/**
 * Common helpers for RMF ApplicationV2 sheets (FoundryVTT v13.341)
 * - Keep behavior minimal and compatible with existing sheets.
 */

/**
 * Build display tag "Name(id)" for any ClientDocument (Actor/Item)
 * @param {ClientDocument} doc
 * @returns {string}
 */
export function buildEntityTag(doc) {
  const name = doc?.name ?? "Unnamed";
  const id = doc?.id ?? "no-id";
  return `${name}(${id})`;
}

/**
 * Read the value of a form control with the right type.
 *
 * Most numeric coercion now happens automatically because the schema
 * (`NumberField` with `min`/`max`/`integer`) validates and coerces on
 * `document.update()`. We still pre-coerce empty / non-finite numeric
 * inputs to `0` so the schema never sees `""` (which Foundry would
 * round to `NaN` and reject when `nullable: false`). And we read
 * `el.checked` for checkboxes, where `el.value` is always `"on"`.
 *
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} el
 * @returns {boolean|number|string}
 */
export function coerceInputValue(el) {
  const type = (el.getAttribute?.('type') || '').toLowerCase();
  if (type === 'checkbox') return !!el.checked;

  const dtype = el.dataset?.dtype || '';
  if (type === 'number' || dtype === 'Number') {
    const raw = String(el.value ?? '').trim();
    if (raw === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return el.value ?? '';
}

/**
 * Default header-height breakpoints used by item sheets (race / skill /
 * category / profession / realm). Each entry is `[maxWidth, dynamicMin]`
 * meaning "if window-width <= maxWidth, the floor is dynamicMin px".
 * Entries must be sorted ascending by maxWidth; the last one acts as
 * the default for any width above the previous threshold.
 */
export const DEFAULT_HEADER_BREAKPOINTS = Object.freeze([
  Object.freeze({ maxWidth: 750, dynamicMin: 140 }),
  Object.freeze({ maxWidth: 850, dynamicMin: 130 }),
  Object.freeze({ maxWidth: 950, dynamicMin: 120 }),
  Object.freeze({ maxWidth: Infinity, dynamicMin: 110 })
]);

/**
 * Breakpoints for the actor sheet — taller minima because the actor
 * header carries name / portrait / level / xp. Reproduces the values
 * that previously lived inline in actor-sheet.js.
 */
export const ACTOR_HEADER_BREAKPOINTS = Object.freeze([
  Object.freeze({ maxWidth: 850, dynamicMin: 250 }),
  Object.freeze({ maxWidth: 950, dynamicMin: 205 }),
  Object.freeze({ maxWidth: 1100, dynamicMin: 190 }),
  Object.freeze({ maxWidth: Infinity, dynamicMin: 170 })
]);

/**
 * Pick a `dynamicMin` value from a breakpoint table given the current width.
 * @param {number} width
 * @param {Array<{maxWidth:number, dynamicMin:number}>} breakpoints
 * @returns {number}
 */
function _pickDynamicMin(width, breakpoints) {
  for (const bp of breakpoints) {
    if (width <= bp.maxWidth) return bp.dynamicMin;
  }
  return breakpoints[breakpoints.length - 1].dynamicMin;
}

/**
 * Initialize dynamic header height variable for CSS layout.
 * Sets `--rmf-header-height` on the sheet root so CSS can position
 * the scrollable body reliably under the header.
 *
 * Accepts a `breakpoints` array so the actor sheet (taller min heights)
 * and item sheets (shorter) can share a single implementation. When
 * `widthSource` is `"window"` the breakpoints are matched against the
 * Application window width; when `"sheet"` they match the sheet element.
 *
 * Safe to call multiple times; previous observers are disconnected.
 *
 * @param {HTMLElement} root - Application root element or any child of it
 * @param {Object} [options]
 * @param {string} [options.selector=".sheet-header"]
 * @param {Array} [options.breakpoints=DEFAULT_HEADER_BREAKPOINTS]
 * @param {"window"|"sheet"} [options.widthSource="window"]
 * @param {boolean} [options.bindWindowResize=false] - also listen on window resize
 * @returns {void}
 */
export function initHeaderAutoHeight(root, options = {}) {
  const element = root?.querySelector ? root : null;
  if (!element) return;
  const selector = options.selector ?? '.sheet-header';
  const breakpoints = options.breakpoints ?? DEFAULT_HEADER_BREAKPOINTS;
  const widthSource = options.widthSource ?? 'window';
  const bindWindowResize = !!options.bindWindowResize;

  const header = element.querySelector(selector);
  if (!header) return;

  const update = () => {
    const h = Math.ceil(header.scrollHeight);
    let w = 0;
    if (widthSource === 'sheet') {
      w = element.getBoundingClientRect?.().width || 0;
    } else {
      const win = element.closest?.('.app');
      w = win?.getBoundingClientRect?.().width || 0;
    }
    const dynamicMin = _pickDynamicMin(w, breakpoints);
    const finalH = Math.max(dynamicMin, h);
    element.style.setProperty('--rmf-header-height', finalH + 'px');
  };

  try { root._rmfHeaderResizeObserver?.disconnect?.(); } catch (_) {}
  try { root._rmfHeaderMutationObserver?.disconnect?.(); } catch (_) {}
  if (root._rmfHeaderWindowResizeHandler) {
    window.removeEventListener('resize', root._rmfHeaderWindowResizeHandler);
    root._rmfHeaderWindowResizeHandler = null;
  }

  const resizeObs = new ResizeObserver(() => update());
  resizeObs.observe(header);
  root._rmfHeaderResizeObserver = resizeObs;

  const mutObs = new MutationObserver(() => update());
  mutObs.observe(header, { subtree: true, childList: true, characterData: true, attributes: true });
  root._rmfHeaderMutationObserver = mutObs;

  if (bindWindowResize) {
    const handler = () => update();
    root._rmfHeaderWindowResizeHandler = handler;
    window.addEventListener('resize', handler, { passive: true });
  }

  update();
  requestAnimationFrame(update);
}

/**
 * Wire tab buttons inside a sheet to toggle content panels.
 * Expects buttons with data-tab and panels with .sheet-body .tab[data-tab]
 * @param {HTMLElement} root - Sheet element
 * @param {(tab:string, root:HTMLElement)=>void} setActive - function to set active tab
 */
export function wireTabs(root, setActive) {
  const element = root?.querySelector ? root : null;
  if (!element) return;
  const buttons = element.querySelectorAll('.sheet-tabs .item, .sheet-tabs .nav-item');
  buttons.forEach(btn => {
    if (btn._rmfTabHandler) btn.removeEventListener('click', btn._rmfTabHandler);
    const handler = (ev) => {
      ev.preventDefault();
      const tab = ev.currentTarget.dataset.tab;
      if (!tab) return;
      setActive?.(tab, element);
    };
    btn._rmfTabHandler = handler;
    btn.addEventListener('click', handler);
  });
}

/**
 * Default implementation to set active tab for sheet content
 * @param {string} tab
 * @param {HTMLElement} root
 */
export function setActiveTab(tab, root) {
  const element = root?.querySelector ? root : null;
  if (!element) return;
  const buttons = element.querySelectorAll('.sheet-tabs .item, .sheet-tabs .nav-item');
  buttons.forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); });
  const panels = element.querySelectorAll('.sheet-body .tab');
  panels.forEach(p => { 
    const active = p.dataset.tab === tab; 
    p.classList.toggle('active', active); 
    p.style.display = active ? 'block' : 'none';
  });
}

/**
 * Attach change listeners to form inputs to call a handler
 * @param {HTMLElement} root
 * @param {(event:Event)=>void} handler
 */
export function bindChangeListeners(root, handler) {
  const element = root?.querySelector ? root : null;
  if (!element) return;
  const form = (element.matches?.('form') ? element : element.querySelector('form')) || element;
  const inputs = form.querySelectorAll('input[name], select[name], textarea[name]');
  inputs.forEach((input) => {
    if (input._rmfChangeBound) return;
    input.addEventListener('change', handler);
    input._rmfChangeBound = true;
  });
}
