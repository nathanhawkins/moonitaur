// any admin setting: find it with Moodle's own settings search, change it with a
// timed revert, or compare it with the same site's other environments.

import { hostPattern } from './moodle.js';
import { fetchDoc, request, parse, landedOnLogin } from './site.js';
import { el, status, openSheet, note, switchButton } from './ui.js';
import { saveWithRevert } from './dev.js';

/** settings on an admin/search.php page that have one plain control: a checkbox, a select or a text field. */
export function parseSettings(doc) {
  const out = [];
  for (const item of doc.querySelectorAll('#adminsettings .form-item[id^="admin-"]')) {
    const setting = item.querySelector('.form-setting');
    if (!setting) continue;
    const controls = [...setting.querySelectorAll('input, select, textarea')].filter((c) => c.name && c.name.startsWith('s_'));
    const names = new Set(controls.map((c) => c.name));
    if (names.size !== 1) continue;
    const field = [...names][0];
    const visible = controls.filter((c) => c.type !== 'hidden');
    if (visible.length !== 1) continue;
    const control = visible[0];
    const base = {
      name: item.querySelector('.form-shortname')?.textContent.trim().replace(/\s*\|\s*/, '/') || field,
      label: (item.querySelector('.form-label label') || item.querySelector('.form-label p'))?.textContent.trim().replace(/\s+/g, ' ') || field,
      field,
      locked: control.disabled || Boolean(item.querySelector('.form-label .alert-info'))
    };
    if (control.type === 'checkbox') {
      const hidden = controls.find((c) => c.type === 'hidden');
      out.push({ ...base, kind: 'checkbox', yes: control.value, no: hidden ? hidden.value : '0', value: control.checked ? control.value : (hidden ? hidden.value : '0'), display: control.checked ? 'On' : 'Off' });
    } else if (control.tagName === 'SELECT' && !control.multiple) {
      const options = [...control.options].map((o) => ({ value: o.value, label: o.textContent.trim() }));
      const current = options.find((o) => o.value === control.value);
      out.push({ ...base, kind: 'select', options, value: control.value, display: current ? current.label : control.value });
    } else if (control.tagName === 'TEXTAREA' || ['text', 'number', 'url', 'email'].includes(control.type)) {
      out.push({ ...base, kind: 'text', value: control.value, display: control.value || 'Empty' });
    }
  }
  return out;
}

const searchUrl = (app, query) => `${app.ctx.wwwroot}/${app.ctx.admin}/search.php?query=${encodeURIComponent(query)}`;
const shortName = (setting) => setting.name.split('/').pop();

async function findSettings(app, query) {
  const { doc } = await fetchDoc(app.tab.id, searchUrl(app, query));
  return parseSettings(doc);
}

export function showAnySetting(app) {
  const input = el('input', { type: 'search', id: 'setting-query', placeholder: 'Setting name or words from its title', autocomplete: 'off', ariaLabel: 'Find a setting' });
  const results = el('div', { className: 'card list', id: 'setting-results', hidden: true });
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const query = input.value.trim();
      if (query.length < 3) {
        results.hidden = true;
        return;
      }
      let found;
      try {
        found = await findSettings(app, query);
      } catch (e) {
        found = [];
        status(e.message, 'bad');
      }
      results.hidden = false;
      results.replaceChildren(...(found.length ? found.slice(0, 30).map((s) => {
        const row = el('button', {}, el('span', { className: 'tool-text' },
          el('span', { className: 'label', textContent: s.label }),
          el('span', { className: 'detail', textContent: `${s.name}: ${s.display}${s.locked ? ', set in config.php' : ''}` })));
        row.dataset.field = s.field;
        row.disabled = s.locked;
        row.addEventListener('click', () => editSetting(app, s));
        return row;
      }) : [el('div', { className: 'empty-result', textContent: 'No settings with one simple value match. Try the full settings search.' })]));
    }, 300);
  });
  openSheet({
    view: 'setting',
    title: 'Change any setting',
    text: 'Changes on staging and live turn back on the timer set in the Dev tab.',
    tall: true,
    body: [el('label', { className: 'search' }, input), results],
    focus: input
  });
}

function editSetting(app, setting) {
  let value = setting.value;
  let control;
  if (setting.kind === 'checkbox') {
    control = switchButton(setting.label, value === setting.yes, () => {
      value = value === setting.yes ? setting.no : setting.yes;
      control.setAttribute('aria-checked', String(value === setting.yes));
    });
    control = el('div', { className: 'card rows' }, el('div', { className: 'row' }, el('span', { textContent: setting.label }), control));
  } else if (setting.kind === 'select') {
    control = el('select', { id: 'setting-value', ariaLabel: setting.label });
    for (const o of setting.options) control.append(el('option', { value: o.value, textContent: o.label, selected: o.value === value }));
    control.addEventListener('change', () => { value = control.value; });
  } else {
    control = el('input', { type: 'text', id: 'setting-value', value, ariaLabel: setting.label });
    control.addEventListener('input', () => { value = control.value; });
  }
  const save = el('button', { className: 'primary', id: 'setting-save', textContent: 'Save' });
  save.addEventListener('click', async () => {
    if (String(value) === String(setting.value)) return status('Nothing changed.');
    const query = shortName(setting);
    const write = (v) => request(app.tab.id, `${app.ctx.wwwroot}/${app.ctx.admin}/search.php`, 'POST', {
      sesskey: app.ctx.sesskey, action: 'save-settings', query, [setting.field]: String(v)
    });
    write.revert = { query, field: setting.field };
    const saved = await saveWithRevert({
      name: setting.field,
      label: setting.label,
      before: setting.value,
      value,
      write,
      reread: async () => (await findSettings(app, query)).find((s) => s.field === setting.field)?.value
    });
    if (saved) setting.value = value;
  });
  openSheet({ title: setting.label, text: setting.name, body: [control], actions: [save], focus: setting.kind === 'checkbox' ? save : control });
}

function readSearchPage(url) {
  return fetch(url, { credentials: 'same-origin' }).then(async (res) => ({ status: res.status, url: res.url, html: await res.text() }));
}

async function tabOn(wwwroot) {
  const tabs = await chrome.tabs.query({ url: hostPattern(wwwroot) });
  const open = tabs.find((t) => t.url && t.url.startsWith(wwwroot) && t.status === 'complete');
  if (open) return { tabId: open.id, opened: false };
  const created = await chrome.tabs.create({ url: `${wwwroot}/`, active: false });
  await new Promise((resolve) => {
    const done = (id, info) => {
      if (id === created.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
  });
  return { tabId: created.id, opened: true };
}

export async function showCompare(app) {
  const { sites = {} } = await chrome.storage.local.get('sites');
  const others = Object.keys(sites).filter((root) => root !== app.ctx.wwwroot);
  const pick = el('select', { id: 'compare-site', ariaLabel: 'Other site' },
    ...others.map((root) => el('option', { value: root, textContent: `${root.replace(/^https?:\/\//, '')} (${sites[root].env})` })),
    el('option', { value: '', textContent: 'Another address…' }));
  const address = el('input', { type: 'url', id: 'compare-url', placeholder: 'https://staging.example.edu', hidden: others.length > 0 });
  pick.addEventListener('change', () => { address.hidden = pick.value !== ''; });
  const query = el('input', { type: 'search', id: 'compare-query', value: 'debug', ariaLabel: 'Settings to compare' });
  const results = el('div', { id: 'compare-results', className: 'stack' });
  const run = el('button', { className: 'primary', id: 'compare-run', textContent: 'Compare' });

  run.addEventListener('click', async () => {
    let other = (pick.value || address.value.trim()).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(other)) return status('Enter the other site’s full address, starting with https://', 'bad');
    other = new URL(other).href.replace(/\/+$/, '');
    // requested first, while the click still counts as a gesture
    const granted = await chrome.permissions.request({ origins: [hostPattern(other)] }).catch(() => false);
    if (!granted) return status('Moonitaur needs access to the other site to read its settings.', 'bad');
    results.replaceChildren(note('Reading both sites…'));
    try {
      const mine = await findSettings(app, query.value.trim());
      const { tabId, opened } = await tabOn(other);
      const url = `${other}/${app.ctx.admin}/search.php?query=${encodeURIComponent(query.value.trim())}`;
      const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: readSearchPage, args: [url] });
      if (opened) chrome.tabs.remove(tabId);
      const res = frame.result;
      if (landedOnLogin(res)) throw new Error(`Sign in to ${other.replace(/^https?:\/\//, '')} as an administrator first.`);
      const theirs = new Map(parseSettings(parse(res.html)).map((s) => [s.field, s]));
      const rows = mine.map((s) => ({ s, t: theirs.get(s.field) })).filter(({ t }) => t);
      const differ = rows.filter(({ s, t }) => s.value !== t.value);
      results.replaceChildren(
        note(differ.length ? `${differ.length} of ${rows.length} settings differ.` : `All ${rows.length} settings match.`),
        el('div', { className: 'card rows compare' },
          el('div', { className: 'row head' }, el('span', { textContent: 'Setting' }), el('span', { textContent: 'Here' }), el('span', { textContent: 'There' })),
          ...[...differ, ...rows.filter((r) => !differ.includes(r))].map(({ s, t }) => el('div', { className: `row${s.value !== t.value ? ' differs' : ''}` },
            el('span', { textContent: s.label, title: s.name }), el('span', { textContent: s.display }), el('span', { textContent: t.display })))));
    } catch (e) {
      results.replaceChildren(note(e.message));
    }
  });

  openSheet({
    view: 'compare',
    title: 'Compare with another site',
    text: 'Reads the same settings on both sites, as you. Nothing is changed.',
    tall: true,
    body: [
      el('label', { className: 'stack' }, el('span', { className: 'card-title', textContent: 'Other site' }), pick, address),
      el('label', { className: 'stack' }, el('span', { className: 'card-title', textContent: 'Settings matching' }), query),
      results
    ],
    actions: [run]
  });
}
