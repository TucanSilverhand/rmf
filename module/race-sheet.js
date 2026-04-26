/**
 * RMF Race Sheet - Specialized Race Item Interface
 *
 * Dedicated sheet implementation for race items in the RoleMaster Fantasy
 * system. Provides comprehensive interface for race stat bonuses, resistances,
 * background options, using
 * FoundryVTT v13.341's ApplicationV2 architecture.
 *
 * @class RMFRaceSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { coerceInputValue, buildEntityTag } from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";

export class RMFRaceSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,

    // Form configuration
    form: {
      submitOnChange: false,
      closeOnSubmit: false,
    },

    // CSS classes
    classes: ["rmf", "sheet", "item", "race"],

    // Window configuration
    window: {
      icon: "fas fa-user",
      title: "RMF.RaceSheet",
      resizable: true,
      positioned: true,
      minimizable: true,
      contentClasses: ["rmf-race-sheet"],
    },

    // Position and size
    position: {
      width: 285,
      height: 508,
    },

    // Declarative actions
    actions: {
      pickImage: RMFActions.handlers.pickImage,
    },
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-race-sheet.hbs",
      scrollable: [".sheet-body"],
    },
  };

  // Action handler removed - now using centralized RMFActions

  static TABS = {
    primary: {
      tabs: [
        {
          id: "background",
          icon: "fas fa-scroll",
          label: "RMF.Tabs.Background",
        },
        {
          id: "stats",
          icon: "fas fa-chart-bar",
          label: "RMF.Tabs.Stats",
        },
        {
          id: "resistances",
          icon: "fas fa-shield-alt",
          label: "RMF.Tabs.Resistances",
        },
        {
          id: "progressions",
          icon: "fas fa-chart-line",
          label: "RMF.Tabs.Progressions",
        },
      ],
    },
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.RaceSheet")}`;
  }

  /**
   * Prepare context data for race sheet template rendering
   *
   * Aggregates race data, enriches text content, and prepares
   * stat and resistance bonus structures for the race sheet UI.
   *
   * @param {ApplicationRenderOptions} options - Rendering options
   * @returns {Promise<Object>} Complete template context with race data
   * @override
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Add document data (defensive: guard against undefined during early lifecycle)
    const doc = this.document;
    const sys = doc?.system ?? {};
    context.item = doc;
    context.system = sys;
    context.flags = doc?.flags ?? {};

    // Add system configuration
    context.config = CONFIG.RMF;

    // Race-specific flags
    context.isRace = true;

    // UI state
    context.isEditable = this.isEditable;

    // Enriched description
    context.enrichedDescription =
      await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        sys.description || "",
        {
          async: true,
          secrets: doc?.isOwner ?? false,
        }
      );

    // Enriched racial abilities
    context.enrichedRacialAbilities =
      await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        sys.racialAbilities || "",
        {
          async: true,
          secrets: doc?.isOwner ?? false,
        }
      );

    // Prepare stat bonuses for display
    context.statBonuses = this._prepareStatBonuses();
    context.resistanceBonuses = this._prepareResistanceBonuses();
    context.progressionBonuses = this._prepareProgressionBonuses();

    return context;
  }

  /**
   * Build display data for the four race progression strings
   * (Body Development + PP for the three magical realms).
   * Each entry exposes the raw string the user edits, the parsed table
   * computed by _prepareRaceData, and a localized label.
   *
   * @returns {Array<{key:string,label:string,value:string,table:object}>}
   * @private
   */
  _prepareProgressionBonuses() {
    const sys = this.document.system ?? {};
    const fields = [
      { key: "bodyDevelopment", labelKey: "RMF.Race.BodyDevelopment" },
      { key: "ppChanneling",    labelKey: "RMF.Race.PPChanneling" },
      { key: "ppEssence",       labelKey: "RMF.Race.PPEssence" },
      { key: "ppMentalism",     labelKey: "RMF.Race.PPMentalism" }
    ];
    return fields.map(({ key, labelKey }) => ({
      key,
      label: game.i18n.has(labelKey) ? game.i18n.localize(labelKey) : key,
      value: sys[key] ?? "",
      table: sys[`${key}Table`] ?? { zero: 0, tier1: 0, tier2: 0, tier3: 0, tier4: 0 }
    }));
  }

  /**
   * Initialize dynamic header height variable for CSS layout
   * Sets --rmf-header-height on the sheet root so CSS can position
   * the scrollable body reliably under the header.
   * @param {HTMLElement} root
   * @private
   */
  _initHeaderAutoHeight(root) {
    const element = root?.querySelector ? root : this.element;
    if (!element) return;
    const header = element.querySelector(".sheet-header");
    if (!header) return;

    const update = () => {
      const h = Math.ceil(header.scrollHeight);
      const win = element.closest(".app");
      const rect = win?.getBoundingClientRect();
      const w = rect?.width || 0;
      let dynamicMin;
      if (w <= 750) dynamicMin = 140;
      else if (w <= 850) dynamicMin = 130;
      else if (w <= 950) dynamicMin = 120;
      else dynamicMin = 110;
      const finalH = Math.max(dynamicMin, h);
      element.style.setProperty("--rmf-header-height", finalH + "px");
    };

    try {
      this._headerResizeObserver?.disconnect();
    } catch (e) {}
    try {
      this._headerMutationObserver?.disconnect();
    } catch (e) {}

    this._headerResizeObserver = new ResizeObserver(() => update());
    this._headerResizeObserver.observe(header);

    this._headerMutationObserver = new MutationObserver(() => update());
    this._headerMutationObserver.observe(header, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    update();
    requestAnimationFrame(update);
  }

  /**
   * @override
   */
  async _updateObject(event, formData) {
    // Debug: verify _updateObject is being triggered and what keys are submitted
    try {
      if (CONFIG?.RMF?.debug) {
        const keys = Object.keys(formData || {});
        const meaningful = Object.fromEntries(
          Object.entries(formData || {}).filter(
            ([k]) => k === "name" || k.startsWith("system.")
          )
        );
        console.debug("RMF DEBUG | RMFRaceSheet._updateObject called", {
          keys,
          eventType: event?.type,
          meaningful,
        });
      }
    } catch {}

    // Delegate to the base implementation which updates the Item document
    const result = await super._updateObject(event, formData);

    // Removed autosave notification to match actor-sheet behavior

    return result;
  }

  /**
   * Initialize race sheet on first render
   *
   * Sets up tab navigation for the race sheet's multi-section interface
   * on the initial render.
   *
   * @param {Object} context - Prepared template context
   * @param {ApplicationRenderOptions} options - Rendering options
   * @override
   */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._setupTabs(this.element);
    this._initHeaderAutoHeight(this.element);
    this._setupFormSubmitLogging(this.element);
    // Apply previously active tab or default on first render
    this._setActiveTab(this._activeTab || "background", this.element);
  }

  /**
   * Called on each render to refresh event listeners
   * @param {HTMLElement} context
   * @param {ApplicationRenderOptions} options
   */
  /**
   * Refresh race sheet components on each render
   *
   * Reestablishes tab navigation after template re-rendering.
   *
   * @param {Object} context - Prepared template context
   * @param {ApplicationRenderOptions} options - Rendering options
   * @override
   */
  _onRender(context, options) {
    super._onRender?.(context, options);
    this._setupTabs(this.element);
    if (!this._headerResizeObserver) this._initHeaderAutoHeight(this.element);
    this._initializeRichTextEditors(this.element);
    this._setupFormSubmitLogging(this.element);
    this._setupChangeAutosubmit(this.element);
    // Restore active tab after rerender
    this._setActiveTab(this._activeTab || "background", this.element);
  }

  /**
   * Attach a one-per-render submit listener to log form submissions in debug mode
   * @param {HTMLElement} html
   * @private
   */
  _setupFormSubmitLogging(html) {
    if (!CONFIG?.RMF?.debug) return;
    const element = html?.querySelector ? html : this.element;
    if (!element) return;
    const form = element.matches?.("form")
      ? element
      : element.querySelector("form");
    if (!form) return;

    // Remove previous handler if present to avoid duplicates
    if (form._rmfSubmitHandler) {
      form.removeEventListener("submit", form._rmfSubmitHandler, true);
    }

    const handler = (event) => {
      try {
        const submitter =
          event.submitter?.getAttribute?.("data-action") ||
          event.submitter?.name ||
          "auto";
        console.debug("RMF DEBUG | RaceSheet form submit triggered", {
          eventType: event.type,
          submitter,
        });
      } catch {}
    };
    form._rmfSubmitHandler = handler;
    form.addEventListener("submit", handler, true);
  }

  /**
   * Attach generic change listeners to trigger autosave and basic logging
   * even when debug mode is off. This helps verify end-to-end form submission.
   * @param {HTMLElement} html
   * @private
   */
  _setupChangeAutosubmit(html) {
    const element = html?.querySelector ? html : this.element;
    if (!element) return;
    const form = element.matches?.("form")
      ? element
      : element.querySelector("form");
    if (!form) return;

    // Avoid duplicate bindings across re-renders
    if (form._rmfChangeHandler) {
      form.removeEventListener("change", form._rmfChangeHandler, true);
    }

    // Removed notifySaved to avoid UI notifications on every change

    // Use shared coercion helper to keep behavior consistent across sheets

    const handler = async (event) => {
      const target = event.target;
      const name = target?.name || target?.getAttribute?.("name");
      if (!name) return;

      // Actor-style: handle all fields via change event (including textareas)

      // Decide if we do granular update (numeric/name/other basic inputs)
      const type = (target.getAttribute?.("type") || "").toLowerCase();
      const isNumeric =
        type === "number" ||
        target.dataset?.dtype === "Number" ||
        name.startsWith("system.stats.") ||
        name.startsWith("system.resistances.") ||
        name === "system.backgroundOptions";

      try {
        const { value } = coerceInputValue(target);
        const tag = buildEntityTag(this.document);
        if (CONFIG?.RMF?.debug) {
          console.debug("RMF DEBUG | RaceSheet granular update", {
            item: tag,
            name,
            value,
            isNumeric,
            type,
          });
        }
        console.log(`RMF | ${tag} Update ${name} => ${value}`);
        await this.document.update({ [name]: value });
      } catch (err) {
        console.error("RMF ERROR | RaceSheet update failed", { name, err });
        ui.notifications?.error(err?.message || "Update failed");
      }
    };

    form._rmfChangeHandler = handler;
    form.addEventListener("change", handler, true);
  }

  /**
   * Initialize rich text editors for description and racial abilities
   *
   * Sets up enhanced text areas with basic formatting capabilities
   * for better content editing experience.
   *
   * @param {HTMLElement} html - The sheet's HTML element
   * @private
   */
  _initializeRichTextEditors(html) {
    const element = html?.querySelector ? html : this.element;
    if (!element) return;

    // Find rich text editor elements
    const editors = element.querySelectorAll(".rmf-rich-editor");

    editors.forEach((editor) => {
      if (editor._rmfBound) return; // avoid duplicate bindings
      // Add basic formatting shortcuts
      editor.addEventListener("keydown", (event) => {
        // Ctrl+B for bold
        if (event.ctrlKey && event.key === "b") {
          event.preventDefault();
          this._wrapSelectedText(editor, "**", "**");
        }
        // Ctrl+I for italic
        else if (event.ctrlKey && event.key === "i") {
          event.preventDefault();
          this._wrapSelectedText(editor, "*", "*");
        }
        // Tab for indentation
        else if (event.key === "Tab") {
          event.preventDefault();
          this._insertAtCursor(editor, "  ");
        }
      });

      // No debounced input saving: actor-style uses change events only

      editor._rmfBound = true;
    });
  }

  /**
   * Wrap selected text with markup
   * @param {HTMLTextAreaElement} textarea - The textarea element
   * @param {string} before - Text to insert before selection
   * @param {string} after - Text to insert after selection
   * @private
   */
  _wrapSelectedText(textarea, before, after) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selection = text.substring(start, end);

    const replacement = before + selection + after;
    textarea.value =
      text.substring(0, start) + replacement + text.substring(end);

    // Update cursor position
    const newStart = start + before.length;
    const newEnd = newStart + selection.length;
    textarea.setSelectionRange(newStart, newEnd);
    textarea.focus();
  }

  /**
   * Insert text at cursor position
   * @param {HTMLTextAreaElement} textarea - The textarea element
   * @param {string} text - Text to insert
   * @private
   */
  _insertAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    textarea.value = value.substring(0, start) + text + value.substring(end);
    textarea.setSelectionRange(start + text.length, start + text.length);
    textarea.focus();
  }

  /**
   * Initialize tab navigation system for race sheet
   *
   * Binds click handlers to tab buttons for the race sheet's
   * multi-section interface (header, background, stats, resistances).
   *
   * @param {HTMLElement} html - The sheet's HTML element
   * @private
   */
  _setupTabs(html) {
    // Ensure we have a valid HTML element
    const element = html?.querySelector ? html : this.element;
    if (!element || !element.querySelector) {
      return;
    }

    // Use native event listeners for better ApplicationV2 compatibility
    // Search for both .item and .nav-item for maximum compatibility
    const tabButtons = element.querySelectorAll(
      ".sheet-tabs .item, .sheet-tabs .nav-item"
    );

    tabButtons.forEach((button) => {
      // Remove existing listeners first
      const existingHandler = button._rmfTabHandler;
      if (existingHandler) {
        button.removeEventListener("click", existingHandler);
      }

      // Add new listener
      const tabClickHandler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const tab = event.currentTarget.dataset.tab;
        if (tab) {
          this._setActiveTab(tab, element);
        }
      };

      button._rmfTabHandler = tabClickHandler;
      button.addEventListener("click", tabClickHandler);
    });

    // Do not force a default tab here; preserve current state.
  }

  /**
   * Activate specific tab and update race sheet UI state
   *
   * Manages tab button active states and corresponding content panel
   * visibility for the race sheet's tabbed navigation.
   *
   * @param {string} tab - Tab identifier to activate
   * @param {HTMLElement} html - The sheet's HTML element
   * @private
   */
  _setActiveTab(tab, html) {
    // Save active tab for future rerenders
    this._activeTab = tab;
    // Ensure we have a valid HTML element
    const element = html?.querySelector ? html : this.element;
    if (!element || !element.querySelector) {
      return;
    }

    // Update tab buttons - search for both .item and .nav-item
    const tabButtons = element.querySelectorAll(
      ".sheet-tabs .item, .sheet-tabs .nav-item"
    );
    tabButtons.forEach((button) => {
      button.classList.remove("active");
      if (button.dataset.tab === tab) {
        button.classList.add("active");
      }
    });

    // Update tab content - hide all first
    const tabContents = element.querySelectorAll(".sheet-body .tab");
    tabContents.forEach((content) => {
      content.classList.remove("active");
      content.style.display = "none";
    });

    // Show the selected tab
    const target = element.querySelector(`.sheet-body .tab[data-tab="${tab}"]`);
    if (target) {
      target.classList.add("active");
      target.style.display = "block";
    }
  }

  /**
   * Prepare stat bonus data for race sheet display
   *
   * Maps abbreviated stat keys to full localized names and values
   * for the race stat bonus configuration interface.
   *
   * @returns {Object} Prepared stat bonus data with labels and values
   * @private
   */
  _prepareStatBonuses() {
    const bonuses = this.document.system.stats || {};
    const prepared = {};

    const statMapping = {
      ag: "chAgility",
      co: "chConstitution",
      me: "chMemory",
      re: "chReasoning",
      sd: "chSelfDiscipline",
      em: "chEmpathy",
      in: "chIntuition",
      pr: "chPresence",
      qu: "chQuickness",
      st: "chStrength",
    };

    for (let [shortKey, fullKey] of Object.entries(statMapping)) {
      prepared[shortKey] = {
        label: game.i18n.localize(`RMF.Stats.${fullKey}`) || fullKey,
        value: bonuses[shortKey] || 0,
        fullKey: fullKey,
      };
    }

    return prepared;
  }

  /**
   * Prepare resistance bonus data for race sheet display
   *
   * Maps abbreviated resistance keys to full localized names
   * and values for the race resistance bonus configuration interface.
   *
   * @returns {Object} Prepared resistance bonus data with labels and values
   * @private
   */
  _prepareResistanceBonuses() {
    const bonuses = this.document.system.resistances || {};
    const prepared = {};

    const resistanceMapping = {
      ess: "essence",
      chan: "channeling",
      ment: "mentalism",
      pois: "poison",
      dis: "disease",
    };

    for (let [shortKey, fullKey] of Object.entries(resistanceMapping)) {
      prepared[shortKey] = {
        label: game.i18n.localize(`RMF.Resistances.${fullKey}`) || fullKey,
        value: bonuses[shortKey] || 0,
        fullKey: fullKey,
      };
    }

    return prepared;
  }

  /**
   * Handle race application button clicks
   *
   * Static action handler for the ApplicationV2 declarative actions system.
   * Intelligently applies race bonuses to selected, assigned, or single actors
   * with comprehensive fallback logic.
   *
   * @param {Event} event - Click event
   * @param {HTMLElement} target - Clicked element
   * @returns {Promise<void>}
   * @static
   */
}
