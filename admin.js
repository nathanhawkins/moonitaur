// the Site tab: things a site administrator does week to week.

import { fetchDoc, NotAdminError } from './site.js';
import { focusSearch, pluginList } from './search.js';
import { $, el, status, openSheet, confirmAction, note } from './ui.js';

let app = null;

const adminUrl = (path) => `${app.ctx.wwwroot}/${app.ctx.admin}/${path}`;

function toneOf(badge) {
  if (!badge) return 'info';
  if (badge.classList.contains('bg-success')) return 'ok';
  if (badge.classList.contains('bg-warning')) return 'warn';
  if (badge.classList.contains('bg-danger')) return 'bad';
  return 'info';
}

async function readStatus() {
  const { doc } = await fetchDoc(app.tab.id, `${app.ctx.wwwroot}/report/status/index.php`);
  const checks = [...doc.querySelectorAll('#statusreporttable tbody tr')].map((row) => {
    const badge = row.querySelector('td.status .badge');
    const summary = row.querySelector('td.summary');
    summary?.querySelector('small')?.remove();
    const link = row.querySelector('td.check a');
    return {
      name: (link || row.querySelector('td.check'))?.textContent.trim() || '',
      label: badge ? badge.textContent.trim() : '',
      tone: toneOf(badge),
      summary: summary ? summary.textContent.trim().replace(/\s+/g, ' ') : '',
      url: link ? new URL(link.getAttribute('href'), app.ctx.wwwroot + '/report/status/').href : ''
    };
  });
  let failing = [];
  try {
    const tasks = await fetchDoc(app.tab.id, adminUrl('tool/task/scheduledtasks.php'));
    // Moodle 4.x and older mark the fail delay cell, which has a Clear link, instead of column 11
    failing = [...tasks.doc.querySelectorAll('td.c11.table-danger, td.table-danger:has(> .task-clearfaildelay)')].map((cell) => {
      const row = cell.closest('tr');
      const name = row.querySelector('.c0');
      name?.querySelector('.task-class')?.remove();
      const delay = cell.childNodes[0]?.textContent.trim() || '';
      return { name: name ? name.textContent.trim().replace(/\s+/g, ' ') : 'Task', delay: /^\d+$/.test(delay) ? `${Math.ceil(delay / 60)} min` : delay };
    });
  } catch {
    // the status report still says whether any task is failing
  }
  return { checks, failing };
}

function renderStatusButton({ checks, failing }) {
  const bad = checks.filter((c) => c.tone === 'bad').length;
  const warn = checks.filter((c) => c.tone === 'warn').length;
  const parts = [];
  if (bad) parts.push(`${bad} ${bad === 1 ? 'problem' : 'problems'}`);
  if (warn) parts.push(`${warn} ${warn === 1 ? 'warning' : 'warnings'}`);
  if (failing.length) parts.push(`${failing.length} failing ${failing.length === 1 ? 'task' : 'tasks'}`);
  const button = $('site-status');
  button.dataset.tone = bad || failing.length ? 'bad' : warn ? 'warn' : 'ok';
  $('site-status-label').textContent = parts.length ? parts.join(', ') : 'All checks OK';
  button.title = `Site status: ${checks.length} checks, including cron and scheduled tasks`;
  button.disabled = false;
  button.onclick = () => showStatus({ checks, failing });
}

function showStatus({ checks, failing }) {
  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  const rows = [...checks].sort((a, b) => order[a.tone] - order[b.tone]).map((c) => {
    const row = el('a', { className: 'check', href: c.url },
      el('span', { className: `badge ${c.tone}`, textContent: c.label }),
      el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: c.name }), el('span', { className: 'detail', textContent: c.summary })));
    row.addEventListener('click', (e) => { e.preventDefault(); app.navigate(c.url, true); });
    return row;
  });
  const body = [el('div', { className: 'card list' }, ...rows)];
  if (failing.length) {
    body.unshift(el('div', { className: 'card stack' }, el('span', { className: 'card-title', textContent: 'Failing scheduled tasks' }),
      el('ul', { className: 'plain' }, ...failing.map((t) => el('li', {}, el('span', { textContent: t.name }), el('span', { className: 'detail', textContent: ` retries in ${t.delay}` }))))));
  }
  const tasks = el('a', { className: 'outline', href: adminUrl('tool/task/scheduledtasks.php'), textContent: 'Open scheduled tasks' });
  tasks.addEventListener('click', (e) => { e.preventDefault(); app.navigate(tasks.href, true); });
  openSheet({ view: 'status', title: 'Site status', tall: true, body, actions: [tasks] });
}

async function loadStatus() {
  try {
    renderStatusButton(await readStatus());
  } catch (e) {
    $('site-status-label').textContent = e instanceof NotAdminError ? 'Status needs an admin' : 'Status unavailable';
  }
}

async function showPlugins() {
  openSheet({ view: 'plugins', title: 'Plugins', tall: true, body: [el('div', { className: 'card rows' }, el('div', { className: 'row' }, el('span', { className: 'sk', style: 'width: 160px; height: 12px' })))] });
  let doc;
  try {
    ({ doc } = await fetchDoc(app.tab.id, adminUrl('plugins.php')));
  } catch (e) {
    return status(e.message, 'bad');
  }
  const rows = [...doc.querySelectorAll('#plugins-control-panel tbody tr[class*="name-"]')];
  const info = (row) => ({
    name: row.querySelector('td.pluginname .displayname')?.textContent.trim() || '',
    component: row.querySelector('td.pluginname .componentname')?.textContent.trim() || '',
    release: row.querySelector('td.version .release')?.textContent.trim() || row.querySelector('td.version .versionnumber')?.textContent.trim() || '',
    update: row.querySelector('td.notes .pluginupdateinfo .version')?.textContent.trim().replace(/\s+/g, ' ') || ''
  });
  const updatable = rows.filter((r) => r.classList.contains('updatable')).map(info);
  const additional = rows.filter((r) => r.classList.contains('additional')).map(info);
  const fetched = doc.querySelector('.checkforupdates .lasttimefetched')?.textContent.trim();

  const list = (items, empty) => items.length
    ? el('div', { className: 'card rows' }, ...items.map((p) => el('div', { className: 'row' },
      el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: p.name }), el('span', { className: 'detail', textContent: p.update || p.component })),
      el('span', { className: 'detail', textContent: p.release }))))
    : note(empty);

  const check = el('a', { className: 'outline', href: `${adminUrl('plugins.php')}?fetchupdates=1&sesskey=${encodeURIComponent(app.ctx.sesskey)}`, textContent: 'Check for updates now' });
  check.addEventListener('click', (e) => { e.preventDefault(); app.navigate(check.href, false); });
  openSheet({
    view: 'plugins',
    title: updatable.length ? `${updatable.length} plugin ${updatable.length === 1 ? 'update' : 'updates'}` : 'Plugins',
    text: fetched || 'Moodle has not checked for plugin updates yet.',
    tall: true,
    body: [
      el('span', { className: 'card-title', textContent: 'Updates available' }), list(updatable, 'Every plugin is up to date, as of the last check.'),
      el('span', { className: 'card-title', textContent: `Additional plugins (${additional.length})` }), list(additional, 'No additional plugins installed.')
    ],
    actions: [check]
  });
}

export async function logInAs(person) {
  const ok = await confirmAction(app.site.env, `Log in as ${person.fullname}?`, {
    always: true,
    text: 'You will see the site exactly as they do, and act as them. Log out to come back to your own account.',
    yes: 'Log in as them'
  });
  if (!ok) return;
  // "Return to admin" brings you back here after signing in again
  const { loginasReturn = {} } = await chrome.storage.local.get('loginasReturn');
  loginasReturn[app.ctx.wwwroot] = app.tab.url;
  await chrome.storage.local.set({ loginasReturn });
  const q = new URLSearchParams({ id: String(app.ctx.siteId), user: String(person.id), sesskey: app.ctx.sesskey });
  app.navigate(`${app.ctx.wwwroot}/course/loginas.php?${q}`, false);
}

const STATS_TTL = 60 * 60 * 1000;

/** admin/registration/index.php lists what Moodle would send to moodle.org; each item has a fixed class. */
async function readStats() {
  const key = `stats:${app.ctx.wwwroot}`;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (cached && Date.now() - cached.at < STATS_TTL) return cached.stats;
  const { doc } = await fetchDoc(app.tab.id, `${app.ctx.wwwroot}/${app.ctx.admin}/registration/index.php`);
  const value = (name) => {
    const text = doc.querySelector(`li.site${name}`)?.textContent || '';
    const m = /\(([^()]*)\)\s*$/.exec(text.trim());
    return m ? m[1].trim() : '';
  };
  const stats = Object.fromEntries(['users', 'activeusers', 'courses', 'enrolments', 'diskusage', 'coursesnodates', 'sitetheme', 'primaryauthtype', 'dbtype']
    .map((name) => [name, value(name)]));
  await chrome.storage.local.set({ [key]: { at: Date.now(), stats } });
  return stats;
}

// Moodle reports these as plugin and driver names; these are what people call them
const THEMES = { boost: 'Boost', classic: 'Classic', remui: 'Edwiser RemUI', moove: 'Moove', academi: 'Academi', adaptable: 'Adaptable', snap: 'Snap', fordson: 'Fordson', klass: 'Klass', alpha: 'Alpha', degrade: 'Degrade', almondb: 'Almond B' };
const AUTH = {
  manual: 'Moodle accounts', email: 'Email self-registration', db: 'External database', ldap: 'LDAP server', cas: 'CAS server',
  oauth2: 'OAuth 2 (Google, Microsoft and others)', saml2: 'SAML single sign-on', shibboleth: 'Shibboleth', lti: 'LTI', mnet: 'MNet', nologin: 'No login', none: 'No authentication', webservice: 'Web services'
};
const DATABASES = { pgsql: 'PostgreSQL', mysqli: 'MySQL', mariadb: 'MariaDB', auroramysql: 'Amazon Aurora MySQL', sqlsrv: 'Microsoft SQL Server' };

const count = (raw) => (/^\d+$/.test(raw) ? Number(raw).toLocaleString() : raw || 'n/a');

function disk(raw) {
  const mb = parseFloat(raw);
  if (Number.isNaN(mb)) return raw || 'n/a';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

async function loadStats() {
  let stats;
  try {
    stats = await readStats();
  } catch (e) {
    $('site-stats').replaceChildren(note(`Could not read site numbers: ${e.message}`));
    $('site-meta').textContent = '';
    return;
  }
  // older sites report fewer: no disk use before 5.2, only the first four before 4.2
  const tiles = [
    ['Users', stats.users, count, `${app.ctx.wwwroot}/${app.ctx.admin}/user.php`],
    ['Active, last 30 days', stats.activeusers, count, `${app.ctx.wwwroot}/${app.ctx.admin}/user.php`],
    ['Courses', stats.courses, count, `${app.ctx.wwwroot}/course/management.php`],
    ['Role assignments', stats.enrolments, count, ''],
    ['Disk used', stats.diskusage, disk, ''],
    ['Courses with no end date', stats.coursesnodates, count, `${app.ctx.wwwroot}/course/management.php`]
  ].filter(([, raw]) => raw).map(([label, raw, format, url]) => [label, format(raw), url]);
  $('site-stats').replaceChildren(...tiles.map(([label, value, url]) => {
    const tile = el(url ? 'a' : 'div', { className: 'stat', ...(url ? { href: url } : {}) },
      el('span', { className: 'stat-label', textContent: label }), el('span', { className: 'stat-value', textContent: value }));
    if (url) tile.addEventListener('click', (e) => { e.preventDefault(); app.navigate(url, e.metaKey || e.ctrlKey); });
    return tile;
  }));
  const rows = [
    ['Theme', THEMES[stats.sitetheme] || stats.sitetheme],
    ['Logins', AUTH[stats.primaryauthtype] || stats.primaryauthtype],
    ['Database', DATABASES[stats.dbtype] || stats.dbtype]
  ].filter(([, value]) => value);
  $('site-meta').replaceChildren(
    ...(rows.length ? [el('dl', { className: 'card rows facts' }, ...rows.map(([label, value]) => el('div', { className: 'row' }, el('dt', { textContent: label }), el('dd', { textContent: value }))))] : []),
    note('Numbers refresh every hour.'));
}

async function countPluginUpdates() {
  try {
    const updates = (await pluginList()).filter((p) => p.update).length;
    $('plugins-label').textContent = updates ? `${updates} plugin ${updates === 1 ? 'update' : 'updates'}` : 'Plugins';
    $('plugins-open').dataset.tone = updates ? 'warn' : '';
  } catch {
    // the button still opens the plugins sheet, which reports its own errors
  }
}

export async function setupAdmin(shared) {
  app = shared;
  $('iconbar').hidden = false;
  $('plugins-open').addEventListener('click', showPlugins);
  const statusLoaded = loadStatus();
  Object.assign(app.views, { plugins: showPlugins, status: async () => { await statusLoaded; $('site-status').click(); } });
  app.actions.push(() => [
    { group: 'Action', label: 'Log in as someone', run: () => focusSearch('people') },
    { group: 'Action', label: 'Plugin updates', run: showPlugins },
    { group: 'Action', label: 'Site status', run: () => $('site-status').click() }
  ]);
  await Promise.all([statusLoaded, loadStats(), countPluginUpdates()]);
}
