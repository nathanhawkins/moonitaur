// one search box for everything: actions and pages answer instantly from the
// extension; courses, people and plugins come from Moodle a moment later. While
// typing, filter buttons take the place of the tabs so the layout never moves.

import { jumpLinks, filterLinks } from './moodle.js';
import { service, fetchDoc, OldMoodleError } from './site.js';
import { $, el } from './ui.js';
import { logInAs } from './admin.js';

const PLUGINS_TTL = 6 * 60 * 60 * 1000;
const PER_GROUP = 5;

let app = null;
let onChange = () => {};
let filter = 'all';
let activeResult = 0;
let generation = 0;

const query = () => $('jump').value.trim();
export const isSearching = () => Boolean(query());

function filters() {
  const list = [['all', 'All'], ['courses', 'Courses']];
  if (app.ctx.hasAdmin) list.push(['people', 'People'], ['plugins', 'Plugins']);
  list.push(['actions', 'Actions'], ['pages', 'Pages']);
  return list;
}

function renderFilters() {
  $('filters').replaceChildren(...filters().map(([id, label]) => {
    const b = el('button', { textContent: label });
    b.dataset.filter = id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(id === filter));
    b.addEventListener('click', () => {
      filter = id;
      render();
      $('jump').focus();
    });
    return b;
  }));
}

/** opens search with a filter already chosen, for "Find people" and the like. */
export function focusSearch(which) {
  filter = which;
  const label = filters().find(([id]) => id === which)?.[1] || 'everything';
  $('jump').placeholder = `Search ${label.toLowerCase()}`;
  $('jump').focus();
  render();
}

const DEFAULT_PLACEHOLDER = 'Search courses, people, plugins, pages';

export function pageList(text) {
  const links = jumpLinks(app.ctx).filter((l) => app.ctx.hasAdmin || l.group !== 'Site').map((l) => ({ ...l, url: app.ctx.wwwroot + l.path }));
  const pinnedFirst = [...pins, ...links.filter((l) => !isPinned(l.url))];
  return text ? filterLinks(pinnedFirst, text) : links;
}

/** last in the list: Moodle's own settings search, for anything Moonitaur does not know about. */
function settingsSearch(text) {
  if (!app.ctx.hasAdmin) return [];
  return [{ group: 'Search', label: `Search admin settings for “${text}”`, url: `${app.ctx.wwwroot}/${app.ctx.admin}/search.php?query=${encodeURIComponent(text)}` }];
}

async function courses(text) {
  if (text.length < 2 || !app.ctx.signedIn) return [];
  const found = await service(app.tab.id, app.ctx, 'core_course_search_courses', {
    criterianame: 'search', criteriavalue: text, page: 0, perpage: 20, limittoenrolled: app.ctx.hasAdmin ? 0 : 1
  });
  return found.courses.map((c) => ({ label: c.displayname || c.fullname, group: c.categoryname || c.shortname, url: `${app.ctx.wwwroot}/course/view.php?id=${c.id}` }));
}

async function people(text) {
  if (text.length < 2 || !app.ctx.hasAdmin) return [];
  try {
    const found = await service(app.tab.id, app.ctx, 'core_user_search_identity', { query: text });
    return found.list.slice(0, 30);
  } catch (e) {
    if (!(e instanceof OldMoodleError)) throw e;
    // Moodle 3.9 and 3.10: the data privacy tool's user search returns the same shape
    return service(app.tab.id, app.ctx, 'tool_dataprivacy_get_users', { query: text });
  }
}

/** the plugins page is heavy, so its list is kept for a few hours per site. */
export async function pluginList() {
  const key = `plugins:${app.ctx.wwwroot}`;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (cached && Date.now() - cached.at < PLUGINS_TTL) return cached.list;
  const { doc } = await fetchDoc(app.tab.id, `${app.ctx.wwwroot}/${app.ctx.admin}/plugins.php`);
  const list = [...doc.querySelectorAll('#plugins-control-panel tbody tr[class*="name-"]')].map((row) => {
    const settings = row.querySelector('td.settings a[href]');
    return {
      label: row.querySelector('td.pluginname .displayname')?.textContent.trim() || '',
      component: row.querySelector('td.pluginname .componentname')?.textContent.trim() || '',
      release: row.querySelector('td.version .release')?.textContent.trim() || row.querySelector('td.version .versionnumber')?.textContent.trim() || '',
      update: row.classList.contains('updatable'),
      url: settings ? new URL(settings.getAttribute('href'), `${app.ctx.wwwroot}/${app.ctx.admin}/`).href : `${app.ctx.wwwroot}/${app.ctx.admin}/plugins.php`
    };
  });
  await chrome.storage.local.set({ [key]: { at: Date.now(), list } });
  return list;
}

async function plugins(text) {
  if (!app.ctx.hasAdmin) return [];
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return (await pluginList()).filter((p) => words.every((w) => `${p.label} ${p.component}`.toLowerCase().includes(w)));
}

const PIN_PATH = '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>';
let pins = [];

export async function loadPins() {
  const { pins: all = {} } = await chrome.storage.local.get('pins');
  pins = all[app.ctx.wwwroot] || [];
}

const isPinned = (url) => pins.some((p) => p.url === url);

async function togglePin(link) {
  const { pins: all = {} } = await chrome.storage.local.get('pins');
  pins = isPinned(link.url) ? pins.filter((p) => p.url !== link.url) : [...pins, { label: link.label, group: link.group || 'Pinned', url: link.url }];
  all[app.ctx.wwwroot] = pins;
  await chrome.storage.local.set({ pins: all });
  renderGoTo();
  if (query()) render();
}

function pinButton(link) {
  const on = isPinned(link.url);
  const b = el('button', { className: 'pin', ariaLabel: `${on ? 'Unpin' : 'Pin'} ${link.label}`, title: on ? 'Unpin' : 'Pin to the top' });
  b.setAttribute('aria-pressed', String(on));
  b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PIN_PATH}</svg>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(link);
  });
  return b;
}

/** a link with its pin button beside it. */
function pinnableItem(link) {
  return el('div', { className: `link-row${isPinned(link.url) ? ' pinned' : ''}` }, linkItem(link), pinButton(link));
}

/** pinned links first, in the order they were pinned, then the usual list without duplicates. */
export function renderGoTo() {
  const rest = pageList('').filter((l) => !isPinned(l.url));
  $('links').replaceChildren(...[...pins, ...rest].map(pinnableItem));
  const here = isPinned(app.tab.url);
  $('pin-page').textContent = here ? 'Unpin this page' : 'Pin this page';
}

export function pinThisPage() {
  const title = (app.tab.title || '').split(' | ')[0].replace(/^(Course|Dashboard):\s*/, '').trim() || app.tab.url.replace(app.ctx.wwwroot, '');
  togglePin({ label: title, group: 'This page', url: app.tab.url });
}

export function linkItem(link, detail = link.group) {
  const a = el('a', { href: link.url },
    el('span', { className: 'label', textContent: link.label }), detail ? el('span', { className: 'group', textContent: detail }) : null);
  const open = (e) => {
    e.preventDefault();
    app.navigate(link.url, e.metaKey || e.ctrlKey || e.button === 1);
  };
  a.addEventListener('click', open);
  a.addEventListener('auxclick', open);
  return a;
}

function actionItem(action) {
  const button = el('button', {}, el('span', { className: 'label', textContent: action.label }));
  button.addEventListener('click', () => {
    $('jump').value = '';
    render();
    action.run();
  });
  return button;
}

function personItem(person) {
  const extra = person.extrafields.map((f) => f.value).filter(Boolean).join(', ');
  const profile = el('a', { href: `${app.ctx.wwwroot}/user/profile.php?id=${person.id}` },
    el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: person.fullname }), el('span', { className: 'detail', textContent: extra })));
  profile.addEventListener('click', (e) => { e.preventDefault(); app.navigate(profile.href, e.metaKey || e.ctrlKey); });
  const loginas = el('button', { className: 'link', textContent: 'Log in as', ariaLabel: `Log in as ${person.fullname}` });
  loginas.addEventListener('click', () => logInAs(person));
  return el('div', { className: 'person' }, profile, loginas);
}

function pluginItem(plugin) {
  const a = linkItem(plugin, null);
  a.querySelector('.label').after(el('span', { className: 'group', textContent: plugin.component }));
  if (plugin.update) a.append(el('span', { className: 'badge warn', textContent: 'Update' }));
  return a;
}

const GROUPS = [
  ['actions', 'Actions', (t) => filterLinks(app.actions.flatMap((provide) => provide()), t), actionItem, false],
  ['pages', 'Pages', pageList, pinnableItem, false],
  ['courses', 'Courses', courses, pinnableItem, true],
  ['people', 'People', people, personItem, true],
  ['plugins', 'Plugins', plugins, pluginItem, true],
  ['settings', 'Admin settings', settingsSearch, (l) => linkItem(l), false]
];

function loadingRows() {
  return el('div', { className: 'loading-rows' }, ...[140, 110].map((w) => el('div', { className: 'row' }, el('span', { className: 'sk', style: `width: ${w}px; height: 12px` }))));
}

function render() {
  onChange();
  const text = query();
  if (!text) return;
  renderFilters();
  const mine = ++generation;
  const box = $('results');
  box.textContent = '';
  const groups = GROUPS.filter(([id]) => (filter === 'all' || filter === id || (id === 'settings' && filter === 'pages')) && (id === 'settings' || filters().some(([f]) => f === id)));
  let pending = 0;
  let shown = 0;
  const empty = el('div', { className: 'empty-result', textContent: 'Nothing matches.', hidden: true });

  for (const [id, label, source, row, remote] of groups) {
    const section = el('div', { className: 'group-section' });
    section.dataset.group = id;
    box.append(section);
    const fill = (items) => {
      if (mine !== generation) return;
      if (!items.length) {
        section.remove();
      } else {
        const limit = filter === 'all' ? PER_GROUP : items.length;
        const more = items.length > limit && el('button', { className: 'more', textContent: `All ${items.length} ${label.toLowerCase()}` });
        if (more) more.addEventListener('click', () => { filter = id; render(); $('jump').focus(); });
        section.replaceChildren(el('div', { className: 'heading', textContent: label }), ...items.slice(0, limit).map(row), more || '');
        shown += items.length;
      }
      empty.hidden = Boolean(shown || pending);
      markActive();
    };
    if (!remote) {
      fill(source(text));
      continue;
    }
    pending++;
    section.append(el('div', { className: 'heading', textContent: label }), loadingRows());
    setTimeout(async () => {
      if (mine !== generation) return;
      let items = [];
      try {
        items = await source(text);
      } catch {
        items = [];
      }
      pending--;
      fill(items);
    }, 200);
  }
  box.append(empty);
  empty.hidden = Boolean(shown || pending);
  activeResult = 0;
  markActive();
}

function reset() {
  filter = 'all';
  $('jump').placeholder = DEFAULT_PLACEHOLDER;
}

const resultItems = () => [...$('results').querySelectorAll('a, button:not(.link):not(.pin)')];

function markActive() {
  resultItems().forEach((item, i) => item.classList.toggle('active', i === activeResult));
}

export function setupSearch(shared, changed) {
  app = shared;
  onChange = changed;
  $('jump').addEventListener('input', () => {
    if (!query()) reset();
    render();
  });
  $('jump').addEventListener('keydown', (e) => {
    const items = resultItems();
    if (e.key === 'Escape' && $('jump').value) {
      e.preventDefault();
      $('jump').value = '';
      reset();
      render();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
      e.preventDefault();
      activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      markActive();
      items[activeResult].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items[activeResult]) {
      e.preventDefault();
      const item = items[activeResult];
      if (item.tagName === 'A') app.navigate(item.href, e.metaKey || e.ctrlKey);
      else item.click();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('jump').focus();
      $('jump').select();
    }
  });
}
