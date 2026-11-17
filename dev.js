// the Dev tab: settings that change how the whole site behaves. Hidden behind an
// acknowledgement, which on live sites lasts 30 minutes.

import { DEV_SETTINGS, PURGE_OPTIONS, shortChoice, hostPattern, untilLabel } from './moodle.js';
import { readSettings, writeSetting, purgeAll, purgeSelected, fetchDoc, request, NotAdminError } from './site.js';
import { siteReverts, recordRevert, clearRevert } from './reverts.js';
import { $, el, status, confirmAction, toolRow, note, openSheet, closeSheet, switchButton } from './ui.js';
import { showAnySetting, showCompare } from './settings.js';

const LIVE_UNLOCK_MS = 30 * 60 * 1000;
const MAINTENANCE_WARNING = 'Everyone except site administrators gets a maintenance page instead of the site on their next click, including students in the middle of a quiz, and nobody else can log in until you turn it off.';

let app = null;
let settings = null;
let isOpen = false;

async function readMaintenance() {
  const { doc } = await fetchDoc(app.tab.id, `${`${app.ctx.wwwroot}/${app.ctx.admin}/search.php`}?query=maintenance_enabled`);
  const select = doc.querySelector('select[name="s__maintenance_enabled"]');
  if (!select) throw new Error('Moodle did not show the maintenance setting.');
  return { on: select.value === '1', locked: select.disabled };
}

async function renderMaintenance() {
  const row = $('maintenance-row');
  let state;
  try {
    state = await readMaintenance();
  } catch {
    row.hidden = true;
    return;
  }
  const toggle = switchButton('Maintenance mode', state.on, () => setMaintenance(!state.on));
  toggle.id = 'maintenance';
  toggle.disabled = state.locked;
  row.replaceChildren(
    el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: 'Maintenance mode' }),
      el('span', { className: 'detail', textContent: state.locked ? 'Set in config.php' : state.on ? 'On: only site administrators can use the site' : 'Off: everyone can use the site' })),
    toggle);
  row.classList.toggle('alert', state.on);
}

async function setMaintenance(on) {
  const ok = await confirmAction(app.site.env, on ? 'Turn on maintenance mode?' : 'Turn off maintenance mode?', {
    always: on,
    text: on ? MAINTENANCE_WARNING : undefined,
    yes: on ? 'Turn it on' : 'Turn it off'
  });
  if (!ok) return;
  status('Saving…');
  try {
    await request(app.tab.id, `${app.ctx.wwwroot}/${app.ctx.admin}/search.php`, 'POST', {
      sesskey: app.ctx.sesskey, action: 'save-settings', query: 'maintenance_enabled', s__maintenance_enabled: on ? '1' : '0'
    });
    const after = await readMaintenance();
    if (after.on !== on) throw new Error('Moodle did not accept the change.');
    status(on ? 'Maintenance mode is on.' : 'Maintenance mode is off.', 'ok');
  } catch (e) {
    status(e.message, 'bad');
  }
  await renderMaintenance();
}

async function runPurge(title, fn) {
  if (!(await confirmAction(app.site.env, `${title}?`))) return;
  $('purge-all').disabled = true;
  status('Purging…');
  try {
    status((await fn()) ? 'Caches purged.' : 'Moodle did not confirm the purge.', 'ok');
  } catch (e) {
    status(e.message, 'bad');
  } finally {
    $('purge-all').disabled = false;
  }
}

const lowerFirst = (label) => /^[A-Z][a-z]+( |$)/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
const purgeEverything = () => runPurge('Purge all caches', () => purgeAll(app.tab.id, app.ctx));
const purgeSome = (names) => runPurge(
  names.length === 1 ? `Purge ${lowerFirst(PURGE_OPTIONS.find((o) => o.name === names[0]).label)}` : `Purge ${names.length} caches`,
  () => purgeSelected(app.tab.id, app.ctx, names)
);

function showPurgePicker() {
  const chips = el('div', { className: 'chips', id: 'purge-options' });
  const go = el('button', { className: 'primary', id: 'purge-selected', textContent: 'Purge selected', disabled: true });
  const picked = () => [...chips.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.name);
  for (const option of PURGE_OPTIONS) {
    const chip = el('button', { textContent: option.label });
    chip.dataset.name = option.name;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
      const count = picked().length;
      go.disabled = !count;
      go.textContent = count ? `Purge ${count} selected` : 'Purge selected';
    });
    chips.append(chip);
  }
  go.addEventListener('click', () => {
    const names = picked();
    closeSheet();
    purgeSome(names);
  });
  openSheet({ view: 'purge', title: 'Purge some caches', text: 'Faster than purging everything, and kinder to a busy site.', body: [chips], actions: [go], focus: chips.firstChild });
}


function lockedText(state) {
  const shown = state.kind === 'select'
    ? shortChoice((state.options.find((o) => o.value === state.value) || {}).label || '')
    : state.on ? 'On' : 'Off';
  return `${shown}, set in config.php`;
}

async function renderSettings() {
  const reverts = await siteReverts(app.ctx.wwwroot);
  const timer = (name) => reverts[name] ? el('span', { className: 'timer', textContent: `turns back ${untilLabel(reverts[name].at)}` }) : null;
  const cards = [];
  const rows = el('div', { className: 'card rows' });

  for (const setting of DEV_SETTINGS) {
    const state = settings[setting.name];
    if (!state) continue;
    if (state.kind === 'select') {
      const group = el('div', { className: 'segmented', ariaLabel: setting.label });
      group.setAttribute('role', 'radiogroup');
      for (const o of state.options) {
        const option = el('button', { textContent: shortChoice(o.label), title: o.label, disabled: state.locked });
        option.setAttribute('role', 'radio');
        option.setAttribute('aria-checked', String(o.value === state.value));
        option.dataset.value = o.value;
        option.addEventListener('click', () => { if (o.value !== state.value) change(setting, o.value); });
        group.append(option);
      }
      const head = el('div', { className: 'card-head' }, el('span', { className: 'card-title', textContent: setting.label }),
        state.locked ? el('span', { className: 'timer', textContent: lockedText(state) }) : timer(setting.name));
      const card = el('div', { className: 'card stack setting' }, head, group);
      card.dataset.name = setting.name;
      cards.push(card);
    } else {
      const toggle = el('button', { className: 'switch', ariaLabel: setting.label, disabled: state.locked });
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(state.on));
      toggle.addEventListener('click', () => change(setting, state.on ? state.no : state.yes));
      const row = el('div', { className: 'row setting' }, el('span', {}, el('span', { className: 'name', textContent: setting.label })));
      row.dataset.name = setting.name;
      if (state.locked) row.append(el('span', { className: 'locked', textContent: lockedText(state) }));
      else row.append(timer(setting.name) || '');
      row.append(toggle);
      rows.append(row);
    }
  }
  if (rows.childElementCount) cards.push(rows);
  if (!cards.length) cards.push(note('No developer settings found on this site.'));
  $('settings').replaceChildren(...cards);
}

async function loadSettings() {
  try {
    settings = await readSettings(app.tab.id, app.ctx);
  } catch (e) {
    const text = e instanceof NotAdminError ? 'Sign in as a site administrator to change developer settings.' : `Could not read settings: ${e.message}`;
    $('settings').replaceChildren(note(text));
    return;
  }
  await renderSettings();
}

/** saves a setting and, on non-local sites, schedules it to turn back. Shared with the any-setting sheet. */
export async function saveWithRevert({ name, label, before, value, write, reread }) {
  const minutes = Number($('revert-minutes').value);
  const timed = minutes > 0 && app.site.env !== 'local';
  if (!(await confirmAction(app.site.env, `Change ${label}?`))) return false;

  // host access lets the worker revert while this popup is closed; asked while the click still counts as a gesture
  const grant = timed
    ? chrome.permissions.request({ origins: [hostPattern(app.ctx.wwwroot)] }).catch(() => false)
    : Promise.resolve(true);

  status('Saving…');
  let after;
  try {
    await write(value);
    after = await reread();
  } catch (e) {
    status(e.message, 'bad');
    return false;
  }
  if (after === undefined || String(after) !== String(value)) {
    status(`Moodle did not accept that change to ${label}.`, 'bad');
    return false;
  }

  const pending = (await siteReverts(app.ctx.wwwroot))[name];
  if (pending && String(pending.value) === String(value)) {
    await clearRevert(app.ctx.wwwroot, name);
    status('Saved. Back to where it started.', 'ok');
  } else if (timed) {
    await recordRevert(app.ctx.wwwroot, name, before, minutes, write.revert);
    const reach = (await grant) ? '' : ' Open Moonitaur here after that to apply it.';
    status(`Saved. Turns back in ${minutes} min.${reach}`, 'ok');
  } else {
    status('Saved.', 'ok');
  }
  return true;
}

async function change(setting, value) {
  await saveWithRevert({
    name: setting.name,
    label: setting.label,
    before: settings[setting.name].value,
    value,
    write: (v) => writeSetting(app.tab.id, app.ctx, setting, v),
    reread: async () => {
      settings = await readSettings(app.tab.id, app.ctx);
      return settings[setting.name] && settings[setting.name].value;
    }
  });
  await renderSettings();
}

function devActions() {
  if (!isOpen) return [];
  const list = [
    { group: 'Action', label: 'Purge all caches', run: purgeEverything },
    ...PURGE_OPTIONS.map((o) => ({ group: 'Action', label: `Purge ${lowerFirst(o.label)}`, run: () => purgeSome([o.name]) })),
    { group: 'Action', label: 'Change any setting', run: () => showAnySetting(app) },
    { group: 'Action', label: 'Compare settings with another site', run: () => showCompare(app) },
    { group: 'Action', label: 'Page details', run: showFacts },
    { group: 'Action', label: 'Maintenance mode', run: () => $('maintenance')?.click() }
  ];
  for (const setting of DEV_SETTINGS) {
    const state = settings && settings[setting.name];
    if (!state || state.locked) continue;
    if (state.kind === 'select') {
      for (const o of state.options) {
        if (o.value !== state.value) list.push({ group: 'Action', label: `${setting.label}: ${shortChoice(o.label)}`, run: () => change(setting, o.value) });
      }
    } else {
      const verb = state.on ? 'off' : 'on';
      list.push({ group: 'Action', label: `Turn ${verb} ${setting.label.charAt(0).toLowerCase()}${setting.label.slice(1)}`, run: () => change(setting, state.on ? state.no : state.yes) });
    }
  }
  return list;
}

function showFacts() {
  const { ctx } = app;
  const facts = [
    ['Course', ctx.courseId], ['Context', ctx.contextId], ['Activity', ctx.cmid], ['Category', ctx.categoryId],
    ['Page type', ctx.pageType], ['Layout', ctx.layout], ['Theme', ctx.theme], ['Language', ctx.lang],
    ['User id', ctx.userId], ['Session key', ctx.sesskey]
  ];
  const rows = facts.filter(([, value]) => value).map(([label, value]) => {
    const copy = el('button', { textContent: String(value), title: `Copy ${label.toLowerCase()}` });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(String(value));
      status(`Copied ${label.toLowerCase()}.`, 'ok');
    });
    return el('div', { className: 'row' }, el('dt', { textContent: label }), el('dd', {}, copy));
  });
  openSheet({ view: 'facts', title: 'Page details', text: 'Click a value to copy it.', tall: true, body: [el('dl', { className: 'card rows facts', id: 'facts' }, ...rows)] });
}

async function unlocked() {
  const { devUnlock = {} } = await chrome.storage.local.get('devUnlock');
  const entry = devUnlock[app.ctx.wwwroot];
  if (!entry) return false;
  return app.site.env !== 'live' || Date.now() - entry < LIVE_UNLOCK_MS;
}

async function open() {
  isOpen = true;
  $('dev-tools').hidden = false;
  $('dev-list').replaceChildren(
    toolRow('Change any setting', 'Find an admin setting, change it, turn it back later', () => showAnySetting(app)),
    toolRow('Compare with another site', 'Same settings, side by side with staging or live', () => showCompare(app)),
    toolRow('Page details', 'Course, context, page type, session key', showFacts)
  );
  await Promise.all([loadSettings(), renderMaintenance()]);
}

/** the code icon in the header: asks once (per site; 30 minutes on live), then shows the Dev panel. */
export async function openDev() {
  if (!isOpen) {
    const ok = await confirmAction(app.site.env, 'This is core stuff', {
      always: true,
      text: `Cache purging, maintenance mode, debugging and any other admin setting. These change how the whole site behaves, for everyone.${app.site.env === 'live' ? ' On live sites this stays unlocked for 30 minutes.' : ''}`,
      yes: 'Unlock developer tools'
    });
    if (!ok) return;
    const { devUnlock = {} } = await chrome.storage.local.get('devUnlock');
    devUnlock[app.ctx.wwwroot] = Date.now();
    await chrome.storage.local.set({ devUnlock });
    open();
  }
  app.showTab('dev');
}

export async function setupDev(shared, prefs) {
  app = shared;
  $('revert-minutes').value = String(prefs.revertMinutes ?? 30);
  $('revert-minutes').addEventListener('change', async (e) => {
    const { prefs: saved = {} } = await chrome.storage.local.get('prefs');
    chrome.storage.local.set({ prefs: { ...saved, revertMinutes: Number(e.target.value) } });
  });
  const ready = unlocked();
  const ifUnlocked = (run) => async () => { if (await ready) run(); };
  Object.assign(app.views, {
    dev: ifUnlocked(() => app.showTab('dev')),
    purge: ifUnlocked(showPurgePicker),
    setting: ifUnlocked(() => showAnySetting(app)),
    compare: ifUnlocked(() => showCompare(app)),
    facts: ifUnlocked(showFacts)
  });
  app.actions.push(devActions);
  app.actions.push(() => isOpen ? [] : [{ group: 'Action', label: 'Developer tools', run: openDev }]);
  $('purge-all').addEventListener('click', purgeEverything);
  $('purge-pick').addEventListener('click', showPurgePicker);
  if (await ready) await open();
}
