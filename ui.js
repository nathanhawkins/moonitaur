export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

let toastTimer = 0;

export function status(text, tone = '') {
  const toast = $('status');
  toast.textContent = text;
  toast.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = `toast ${tone}`; }, tone === 'bad' ? 6000 : 3200);
}

let sheetReturn = null;
let sheetClosed = null;
let pendingClose = 0;
let sheetView = null;
let onSheetChange = () => {};

/** `view` names a tool sheet the popup can reopen later; a sheet without one (a confirm, say) keeps the tool's name while it swaps in. */
export const watchSheet = (fn) => { onSheetChange = fn; };

/**
 * one sheet at a time. `tall` sheets hold a whole tool; short ones ask or explain. Resolves with the
 * close answer. Opening while a sheet is up swaps its content in place, so the page behind stays still.
 */
export function openSheet({ view = null, title, text = '', body = [], actions = [], tall = false, focus = null }) {
  const wasOpen = sheetIsOpen() || Boolean(pendingClose);
  if (view || !wasOpen) sheetView = view;
  clearTimeout(pendingClose);
  pendingClose = 0;
  if (sheetClosed) {
    const done = sheetClosed;
    sheetClosed = null;
    done(false);
  }
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
  $('sheet-text').hidden = !text;
  $('sheet-body').replaceChildren(...body);
  $('sheet-actions').replaceChildren(...actions);
  $('sheet').classList.toggle('tall', tall);
  if (!wasOpen || !sheetReturn) sheetReturn = document.activeElement;
  $('sheet').inert = false;
  $('view-moodle').inert = true;
  $('foot').inert = true;
  document.querySelector('.app').classList.remove('sheet-closing');
  document.querySelector('.app').classList.add('sheet-open');
  // without preventScroll, focusing inside the sliding sheet scrolls the whole popup behind it
  (focus || actions[0] || $('sheet-close')).focus({ preventScroll: true });
  onSheetChange(sheetView);
  return new Promise((resolve) => { sheetClosed = resolve; });
}

/** answers and hands control back right away; only the slide-down waits a beat, so a sheet opened next replaces this one in place. */
export function closeSheet(answer = false) {
  if ($('sheet').inert) return;
  const done = sheetClosed;
  sheetClosed = null;
  $('sheet').inert = true;
  $('view-moodle').inert = false;
  $('foot').inert = false;
  if (sheetReturn && sheetReturn.isConnected) sheetReturn.focus({ preventScroll: true });
  document.querySelector('.app').classList.add('sheet-closing');
  sheetView = null;
  onSheetChange(null);
  pendingClose = setTimeout(() => {
    pendingClose = 0;
    document.querySelector('.app').classList.remove('sheet-open', 'sheet-closing');
  }, 60);
  if (done) done(answer);
}

export function sheetIsOpen() {
  return !$('sheet').inert;
}

$('sheet-close').addEventListener('click', () => closeSheet(false));
$('scrim').addEventListener('click', () => closeSheet(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetIsOpen()) {
    e.preventDefault();
    closeSheet(false);
  }
});

/** asks inside a sheet. Live sites always ask; `always` asks everywhere, for things that are hard to undo. */
export function confirmAction(env, title, { always = false, text, yes = 'Do it' } = {}) {
  if (!always && env !== 'live') return Promise.resolve(true);
  const ok = el('button', { className: 'primary', id: 'confirm-yes', textContent: yes });
  const no = el('button', { className: 'outline', id: 'confirm-no', textContent: 'Cancel' });
  ok.addEventListener('click', () => closeSheet(true));
  no.addEventListener('click', () => closeSheet(false));
  const why = text || (env === 'live' ? 'This is the live site. Real users will see the change.' : '');
  return openSheet({ title, text: why, actions: [ok, no] });
}

/** a row in a list of tools: label, a short line under it, and a chevron. */
export function toolRow(label, detail, onClick) {
  const row = el('button', { className: 'tool' },
    el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: label }), detail ? el('span', { className: 'detail', textContent: detail }) : null),
    chevron());
  row.addEventListener('click', onClick);
  return row;
}

export function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}

export function switchButton(label, on, onClick) {
  const toggle = el('button', { className: 'switch', ariaLabel: label });
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(on));
  toggle.addEventListener('click', onClick);
  return toggle;
}

export function note(text) {
  return el('p', { className: 'note', textContent: text });
}

export function shortRelease(release) {
  return String(release).replace(/\s*\(Build:.*\)\s*$/, '');
}

export function formatDateTime(seconds) {
  return new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
