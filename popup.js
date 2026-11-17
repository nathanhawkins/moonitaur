import { guessEnv, hostPattern, branchOf } from './moodle.js';
import { probe, readVersion, checkUpdates, request } from './site.js';
import { applyDue } from './reverts.js';
import { $, el, status, openSheet, watchSheet, switchButton, shortRelease } from './ui.js';
import { setupCourse, switchBackButton } from './course.js';
import { setupAdmin } from './admin.js';
import { setupDev, openDev } from './dev.js';
import { setupSearch, isSearching, loadPins, renderGoTo, pinThisPage } from './search.js';
import { runA11yCheck } from './a11y.js';

const VERSION_TTL = 60 * 60 * 1000;
const UPDATES_TTL = 12 * 60 * 60 * 1000;
const ENV_LABELS = { local: 'Local site', staging: 'Staging site', live: 'Live site' };
const ICONS = {
  moodle: { path: { 16: 'icons/16.png', 32: 'icons/32.png' }, title: 'Moonitaur: this is a Moodle site' },
  other: { path: { 16: 'icons/off-16.png', 32: 'icons/off-32.png' }, title: 'Moonitaur: not a Moodle page' }
};
const ALL_SITES = '*://*/*';
const LAST_VIEW_MS = 15 * 60 * 1000;

/** asks once for the access the automatic icon needs; Chrome shows its own prompt on Allow. */
async function offerDetection() {
  const { prefs = {} } = await chrome.storage.local.get('prefs');
  if (prefs.detectAsked || await chrome.permissions.contains({ origins: [ALL_SITES] })) return;
  $('detect-ask').hidden = false;
  const done = () => {
    $('detect-ask').hidden = true;
    savePrefs({ detectAsked: true });
  };
  $('detect-allow').addEventListener('click', async () => {
    const granted = await chrome.permissions.request({ origins: [ALL_SITES] }).catch(() => false);
    done();
    status(granted ? 'The icon now turns green on Moodle sites by itself.' : 'Without it, the icon only changes after you open Moonitaur.', granted ? 'ok' : '');
  });
  $('detect-later').addEventListener('click', done);
}

/** shared with the tab modules. Each module adds its palette actions to `actions`. */
const app = {
  tab: null,
  ctx: null,
  site: null,
  actions: [],
  views: {},
  navigate(url, newTab) {
    if (newTab) {
      chrome.tabs.create({ url, index: app.tab.index + 1 });
    } else {
      chrome.tabs.update(app.tab.id, { url });
      window.close();
    }
  },
  async saveSite(patch) {
    const { sites = {} } = await chrome.storage.local.get('sites');
    app.site = { ...app.site, ...patch };
    sites[app.ctx.wwwroot] = app.site;
    await chrome.storage.local.set({ sites });
  }
};

async function savePrefs(patch) {
  const { prefs = {} } = await chrome.storage.local.get('prefs');
  await chrome.storage.local.set({ prefs: { ...prefs, ...patch } });
}

const TABS = ['course', 'site', 'go'];
const PANELS = [...TABS, 'dev'];
let currentTab = 'go';

const visibleTabs = () => TABS.filter((id) => !$(`tab-${id}`).hidden);

/** "dev" is a panel without a tab: the code icon in the header opens it. */
function showTab(name) {
  currentTab = name;
  for (const id of TABS) {
    const button = $(`tab-${id}`);
    button.setAttribute('aria-selected', String(id === name));
    button.tabIndex = id === name || (name === 'dev' && id === visibleTabs()[0]) ? 0 : -1;
  }
  $('dev-open').setAttribute('aria-pressed', String(name === 'dev'));
  renderPanels();
  remember();
}

function renderPanels() {
  const searching = isSearching();
  $('tabs').hidden = searching;
  $('filters').hidden = !searching;
  for (const id of PANELS) $(`panel-${id}`).hidden = searching || id !== currentTab;
  $('results').hidden = !searching;
}

for (const id of TABS) {
  $(`tab-${id}`).addEventListener('click', () => {
    $('jump').value = '';
    showTab(id);
  });
}

$('tabs').addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  const tabs = visibleTabs();
  const next = tabs[(Math.max(0, tabs.indexOf(currentTab)) + step + tabs.length) % tabs.length];
  $(`tab-${next}`).click();
  $(`tab-${next}`).focus();
});

setupSearch(app, renderPanels);
app.showTab = showTab;
$('dev-open').addEventListener('click', () => (currentTab === 'dev' ? showTab(visibleTabs()[0]) : openDev()));

$('a11y-check').addEventListener('click', () => runA11yCheck(app));
app.views.a11y = () => runA11yCheck(app);
app.actions.push(() => [{ group: 'Action', label: 'Check this page for accessibility', run: () => runA11yCheck(app) }]);

let versionInfo = null;
let updateInfo = null;

function setBanner(version, title, sub, clickable) {
  $('version').textContent = version;
  $('update-title').textContent = title;
  $('update').textContent = sub;
  $('banner').disabled = !clickable;
}

function renderBanner() {
  const v = versionInfo;
  if (!v) return;
  if (v.state === 'pending') return setBanner('Upgrade waiting', `Moodle ${shortRelease(v.release)}`, 'Finish the upgrade', true);
  if (v.state !== 'ok') return setBanner('Moodle', 'Version hidden', 'Admins only', false);
  const current = `Moodle ${shortRelease(v.release)}`;
  if (!updateInfo) return setBanner(current, 'Checking moodle.org', '', false);
  if (updateInfo.error) return setBanner(current, 'Update check failed', 'Try again', true);
  if (updateInfo.patch) return setBanner(current, `${shortRelease(updateInfo.patch.release)} is available`, 'See what changed', true);
  if (updateInfo.newer) return setBanner(current, 'Up to date', `${shortRelease(updateInfo.newer.release)} is out`, true);
  setBanner(current, 'Up to date', `Newest ${branchOf(v.release)} release`, false);
}

function buildOf(release) {
  const m = /\(Build:\s*([^)]+)\)/.exec(release);
  return m ? m[1] : '';
}

function detailRows(rows) {
  return el('dl', {}, ...rows.map(([label, value]) => el('div', {}, el('dt', { textContent: label }), el('dd', {}, value))));
}

function showVersionSheet() {
  const v = versionInfo;
  const { ctx } = app;
  if (v.state === 'pending') {
    const finish = el('a', { className: 'primary', href: `${ctx.wwwroot}/${ctx.admin}/index.php`, textContent: 'Finish upgrade' });
    finish.addEventListener('click', (e) => { e.preventDefault(); app.navigate(finish.href, false); });
    return openSheet({
      title: `Moodle ${shortRelease(v.release)}`,
      text: 'The new code is on the server, but the database upgrade has not run yet.',
      actions: [finish]
    });
  }
  if (updateInfo.error) return showVersion(true);

  const newer = updateInfo.newer;
  const target = updateInfo.patch || newer;
  const newerNote = updateInfo.patch && newer && el('div', { className: 'callout' },
    el('strong', { textContent: `${shortRelease(newer.release)} is out too` }),
    'A new major version. Check your plugins support it before moving up.');
  const released = target.date ? new Date(target.date * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const rows = [['Released', released], ['Build', buildOf(target.release)], ['Branch', branchOf(target.release)]].filter(([, value]) => value);
  const notes = el('a', { className: 'primary', href: `https://moodledev.io/general/releases/${branchOf(target.release)}/${shortRelease(target.release)}`, target: '_blank', textContent: 'Read release notes' });
  const download = el('a', { className: 'outline', href: target.download, target: '_blank', textContent: 'Download' });
  openSheet({
    title: `Moodle ${shortRelease(target.release)}`,
    text: updateInfo.patch
      ? `A fix release for ${branchOf(v.release)}. Your site runs ${shortRelease(v.release)}.`
      : `A newer major version. Your site runs ${shortRelease(v.release)}, the newest ${branchOf(v.release)} release.`,
    body: [detailRows(rows), newerNote],
    actions: target.download ? [notes, download] : [notes]
  });
}

$('banner').addEventListener('click', showVersionSheet);

async function showUpdates(force) {
  const key = `updates:${versionInfo.version}`;
  let { [key]: cached } = await chrome.storage.local.get(key);
  if (force || !cached || Date.now() - cached.at > UPDATES_TTL) {
    updateInfo = null;
    renderBanner();
    try {
      cached = { at: Date.now(), ...(await checkUpdates(versionInfo)) };
      await chrome.storage.local.set({ [key]: cached });
    } catch {
      cached = { error: true };
    }
  }
  updateInfo = cached;
  renderBanner();
}

async function showVersion(force) {
  const key = `version:${app.ctx.wwwroot}`;
  let { [key]: cached } = await chrome.storage.local.get(key);
  if (force || !cached || Date.now() - cached.at > VERSION_TTL) {
    try {
      cached = { at: Date.now(), ...(await readVersion(app.tab.id, app.ctx)) };
      await chrome.storage.local.set({ [key]: cached });
    } catch {
      cached = { state: 'denied' };
    }
  }
  versionInfo = cached;
  renderBanner();
  if (cached.state === 'ok') await showUpdates(force);
}

function renderEnv() {
  document.body.dataset.env = app.site.env;
  $('env-label').textContent = ENV_LABELS[app.site.env];
}

async function showSiteSheet() {
  const { ctx } = app;
  const pick = el('div', { className: 'segmented', id: 'env-pick', ariaLabel: 'Environment' });
  pick.setAttribute('role', 'radiogroup');
  for (const env of ['local', 'staging', 'live']) {
    const b = el('button', { textContent: ENV_LABELS[env].replace(' site', '') });
    b.dataset.env = env;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(app.site.env === env));
    b.addEventListener('click', async () => {
      await app.saveSite({ env });
      renderEnv();
      for (const other of pick.children) other.setAttribute('aria-checked', String(other === b));
    });
    pick.append(b);
  }

  const ribbonOn = Boolean(app.site.ribbon) && await chrome.permissions.contains({ origins: [hostPattern(ctx.wwwroot)] });
  const ribbon = switchButton('Ribbon on this site', ribbonOn, async () => {
    const on = ribbon.getAttribute('aria-checked') !== 'true';
    if (on) {
      const granted = await chrome.permissions.request({ origins: [hostPattern(ctx.wwwroot)] }).catch(() => false);
      if (!granted) return status('The ribbon needs access to this site.', 'bad');
      await app.saveSite({ ribbon: true });
      await chrome.scripting.executeScript({ target: { tabId: app.tab.id }, files: ['ribbon.js'] }).catch(() => {});
    } else {
      await app.saveSite({ ribbon: false });
    }
    ribbon.setAttribute('aria-checked', String(on));
  });
  ribbon.id = 'ribbon';

  const notes = el('textarea', { id: 'site-notes', rows: 5, value: app.site.notes || '', placeholder: 'Anything to remember about this site. Only stored in this browser.' });
  notes.addEventListener('change', () => app.saveSite({ notes: notes.value }));

  openSheet({
    view: 'site',
    title: ctx.wwwroot.replace(/^https?:\/\//, ''),
    tall: true,
    body: [
      el('div', { className: 'stack' },
        el('span', { className: 'card-title', textContent: 'Environment' }), pick,
        el('p', { className: 'note', textContent: 'Live sites ask before every change.' })),
      el('div', { className: 'card rows' }, el('div', { className: 'row' }, el('span', { textContent: 'Ribbon on this site' }), ribbon)),
      el('label', { className: 'stack' }, el('span', { className: 'card-title', textContent: 'Notes' }), notes)
    ]
  });
}

$('env-change').addEventListener('click', showSiteSheet);
app.views.site = showSiteSheet;

let openView = null;
let pendingFields = null;

function sheetFields() {
  const fields = [...$('sheet-body').querySelectorAll('input[id], select[id], textarea[id]')].filter((f) => f.type !== 'checkbox' && f.type !== 'radio');
  return Object.fromEntries(fields.map((f) => [f.id, f.value]));
}

function remember() {
  if (!app.ctx || $('view-moodle').hidden) return;
  chrome.storage.session.set({
    lastView: {
      wwwroot: app.ctx.wwwroot,
      courseId: app.ctx.courseId,
      tab: currentTab,
      query: $('jump').value,
      view: openView,
      fields: openView ? sheetFields() : {},
      at: Date.now()
    }
  });
}

// tools that load show a skeleton first, so fields are filled in as each one appears
function fillFields(view) {
  if (!pendingFields || pendingFields.view !== view) {
    pendingFields = null;
    return;
  }
  for (const [id, value] of Object.entries(pendingFields.values)) {
    const field = $(id);
    if (!field || !$('sheet-body').contains(field)) continue;
    delete pendingFields.values[id];
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

watchSheet((view) => {
  openView = view;
  fillFields(view);
  remember();
});
$('sheet-body').addEventListener('input', remember);
$('jump').addEventListener('input', remember);
// the popup can close without warning, so "last open" is kept within a minute
setInterval(remember, 60 * 1000);

function restore(last) {
  if (!last || Date.now() - last.at > LAST_VIEW_MS || last.wwwroot !== app.ctx.wwwroot) return;
  if (last.tab === 'dev') app.views.dev?.();
  else if (visibleTabs().includes(last.tab)) showTab(last.tab);
  if (last.query) {
    $('jump').value = last.query;
    $('jump').dispatchEvent(new Event('input'));
  }
  const reopen = last.view && app.views[last.view];
  if (!reopen || (last.view.startsWith('course-') && last.courseId !== app.ctx.courseId)) return;
  pendingFields = { view: last.view, values: last.fields };
  reopen();
}

/**
 * Moodle has no "switch back" from log in as, and logging out ends the admin session too.
 * So: log out, then open the page you started from. It needs a login, so Moodle shows the
 * login page and sends you back there once you have signed in.
 */
function showReturnToAdmin() {
  $('loginas').hidden = false;
  if (app.ctx.loggedInAsName) $('loginas').querySelector('span').textContent = `You are logged in as ${app.ctx.loggedInAsName}.`;
  const back = async () => {
    const { loginasReturn = {} } = await chrome.storage.local.get('loginasReturn');
    const target = loginasReturn[app.ctx.wwwroot] || `${app.ctx.wwwroot}/${app.ctx.admin}/user.php`;
    status('Logging out…');
    try {
      await request(app.tab.id, `${app.ctx.wwwroot}/login/logout.php?sesskey=${encodeURIComponent(app.ctx.sesskey)}`);
    } catch (e) {
      return status(e.message, 'bad');
    }
    delete loginasReturn[app.ctx.wwwroot];
    await chrome.storage.local.set({ loginasReturn });
    app.navigate(target, false);
  };
  $('return-admin').addEventListener('click', back);
  app.actions.push(() => [{ group: 'Action', label: 'Return to admin', run: back }]);
}

function showSignedOut() {
  $('view-signedout').hidden = false;
  const login = `${app.ctx.wwwroot}/login/index.php`;
  if (!app.tab.url.startsWith(login)) {
    $('go-login').hidden = false;
    $('go-login').addEventListener('click', () => app.navigate(login, false));
  }
}

function none(reason) {
  $('view-none').hidden = false;
  $('none-reason').textContent = reason;
}

async function init() {
  [app.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!app.tab || !/^https?:/.test(app.tab.url || '')) return none('This tab is not a web page.');
  try {
    app.ctx = await probe(app.tab.id);
  } catch {
    return none('Chrome does not let extensions read this tab.');
  }
  const icon = app.ctx ? ICONS.moodle : ICONS.other;
  chrome.action.setIcon({ tabId: app.tab.id, path: icon.path }).catch(() => {});
  chrome.action.setTitle({ tabId: app.tab.id, title: icon.title }).catch(() => {});
  await offerDetection();
  if (!app.ctx) return none('This tab is not a Moodle page.');
  const { ctx } = app;

  const { sites = {} } = await chrome.storage.local.get('sites');
  app.site = sites[ctx.wwwroot] || { env: guessEnv(new URL(ctx.wwwroot).hostname), ribbon: false };
  $('host').textContent = ctx.wwwroot.replace(/^https?:\/\//, '');
  renderEnv();
  $('foot').hidden = false;
  if (!ctx.signedIn) return showSignedOut();
  $('view-moodle').hidden = false;

  const policy = await chrome.storage.managed.get('hideDevTools').catch(() => ({}));
  $('tab-course').hidden = !(ctx.courseId && (ctx.canEdit || ctx.hasAdmin)) || ctx.switchedRole;
  $('tab-site').hidden = !ctx.hasAdmin;
  $('dev-open').hidden = !ctx.hasAdmin || policy.hideDevTools === true;

  const { prefs = {} } = await chrome.storage.local.get('prefs');
  const { lastView } = await chrome.storage.session.get('lastView');
  showTab('go');
  await loadPins();
  renderGoTo();
  $('pin-page').addEventListener('click', pinThisPage);
  if (ctx.switchedRole && ctx.courseId) $('panel-go').prepend(switchBackButton(app));
  $('jump').focus();

  if (ctx.loggedInAs) showReturnToAdmin();


  // reverts the worker could not reach (no open tab, or no host access) are applied here
  if (ctx.hasAdmin) {
    try {
      const restored = await applyDue(app.tab.id, ctx);
      if (restored.length) {
        status(`Timer ran out: restored ${restored.join(', ')}.`, 'ok');
        chrome.action.setBadgeText({ text: '' });
      }
    } catch {
      // not an admin any more
    }
  }

  const work = [showVersion(false)];
  if (!$('tab-course').hidden) work.push(setupCourse(app));
  if (!$('tab-site').hidden) work.push(setupAdmin(app));
  if (!$('dev-open').hidden) work.push(setupDev(app, prefs));
  restore(lastView);
  await Promise.all(work);
}

init();
