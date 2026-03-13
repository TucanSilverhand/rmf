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
 * Coerce input value according to element type and data-dtype
 * - checkbox => boolean
 * - number or data-dtype="Number" => Number (defaults 0 if NaN or empty)
 * - otherwise => string
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} el
 * @returns {{ value: any, isNumeric: boolean, type: string }}
 */
export function coerceInputValue(el) {
  const type = (el.getAttribute?.('type') || '').toLowerCase();
  const dtype = el.dataset?.dtype || '';

  if (type === 'checkbox') {
    return { value: !!el.checked, isNumeric: false, type };
  }

  if (type === 'number' || dtype === 'Number') {
    const raw = (el.value ?? '').toString().trim();
    if (raw === '') return { value: 0, isNumeric: true, type };
    const n = Number(raw);
    return { value: Number.isFinite(n) ? n : 0, isNumeric: true, type };
  }

  return { value: el.value ?? '', isNumeric: false, type };
}

/**
 * Initialize dynamic header height variable for CSS layout.
 * Sets --rmf-header-height on the sheet root so CSS can position
 * the scrollable body reliably under the header.
 * Safe to call multiple times; establishes ResizeObserver + MutationObserver.
 * @param {HTMLElement} root - Application root element or any child of it
 * @param {string} selector - Header selector (default .sheet-header)
 * @returns {void}
 */
export function initHeaderAutoHeight(root, selector = '.sheet-header') {
  const element = root?.querySelector ? root : null;
  if (!element) return;
  const header = element.querySelector(selector);
  if (!header) return;

  const update = () => {
    const h = Math.ceil(header.scrollHeight);
    const win = element.closest?.('.app');
    const rect = win?.getBoundingClientRect?.();
    const w = rect?.width || 0;
    let dynamicMin;
    if (w <= 750) dynamicMin = 140;
    else if (w <= 850) dynamicMin = 130;
    else if (w <= 950) dynamicMin = 120;
    else dynamicMin = 110;
    const finalH = Math.max(dynamicMin, h);
    element.style.setProperty('--rmf-header-height', finalH + 'px');
  };

  try { root._rmfHeaderResizeObserver?.disconnect?.(); } catch (_) {}
  try { root._rmfHeaderMutationObserver?.disconnect?.(); } catch (_) {}

  const resizeObs = new ResizeObserver(() => update());
  resizeObs.observe(header);
  root._rmfHeaderResizeObserver = resizeObs;

  const mutObs = new MutationObserver(() => update());
  mutObs.observe(header, { subtree: true, childList: true, characterData: true, attributes: true });
  root._rmfHeaderMutationObserver = mutObs;

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
