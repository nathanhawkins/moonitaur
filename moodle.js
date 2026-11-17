// pure Moodle knowledge: how to read a page, what a release string means, where
// things live. Nothing here touches chrome.* or the network, so it runs in node.

const STABLE = 200; // MATURITY_STABLE

/**
 * Moodle writes `M.cfg = {...};` into an inline script on every page. Pull the
 * object out by matching braces rather than a regex, since values are JSON and
 * may contain braces or semicolons inside strings.
 */
export function parseCfg(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function numberAfter(classes, prefix) {
  for (const c of classes) {
    if (c.startsWith(prefix) && /^\d+$/.test(c.slice(prefix.length))) return Number(c.slice(prefix.length));
  }
  return 0;
}

/** everything the popup knows about the tab, from M.cfg and the body element. */
export function pageContext({ cfgText, bodyId = '', bodyClass = '', url = '', hasAdmin = false, canEdit = false, legacyEditUrl = '', pageUserId = 0, hasLogout = false, switchedRole = false, loggedInAs = false, loggedInAsName = '', guest = false }) {
  const cfg = parseCfg(cfgText);
  if (!cfg || typeof cfg.wwwroot !== 'string' || typeof cfg.sesskey !== 'string') return null;
  const wwwroot = cfg.wwwroot.replace(/\/+$/, '');
  // any page can print its own M.cfg, so only trust a wwwroot the tab is actually on
  if (!/^https?:\/\//.test(wwwroot) || !underRoot(url, wwwroot)) return null;
  const classes = bodyClass.split(/\s+/).filter(Boolean);
  const layout = classes.find((c) => c.startsWith('pagelayout-'));
  const pageType = bodyId.replace(/^page-/, '');
  const modMatch = /^mod-([a-z0-9_]+)-/.exec(pageType);
  const siteId = cfg.siteId || 1;
  // Moodle 3.x leaves the course out of M.cfg, and 5.0 and older the user; the body class and user menu still have them
  const courseId = cfg.courseId ?? numberAfter(classes, 'course-');
  const userId = cfg.userId || pageUserId;
  return {
    wwwroot,
    admin: cfg.admin || 'admin',
    sesskey: cfg.sesskey,
    siteId,
    courseId: courseId && courseId !== siteId ? courseId : 0,
    contextId: cfg.contextid || 0,
    courseContextId: cfg.courseContextId || (pageType.startsWith('course-view') ? cfg.contextid : 0) || 0,
    cmid: numberAfter(classes, 'cmid-'),
    categoryId: numberAfter(classes, 'category-'),
    modname: modMatch ? modMatch[1] : '',
    layout: layout ? layout.slice('pagelayout-'.length) : '',
    pageType,
    theme: cfg.theme || '',
    lang: cfg.language || '',
    userId,
    // a guest has a user id and no notloggedin class, so the login page and the guest's
    // "Log in" link (with no "Log out") are what tell them apart from a real account
    signedIn: (Boolean(userId) || hasLogout) && !classes.includes('notloggedin') && bodyId !== 'page-login-index' && !guest,
    editing: classes.includes('editing'),
    developerDebug: cfg.developerdebug === true,
    hasAdmin,
    canEdit,
    legacyEditUrl,
    switchedRole,
    loggedInAs,
    loggedInAsName,
    url
  };
}

/**
 * the admin notifications page carries the copyright notice, which GPL terms keep
 * intact: `<a href=".../releases" title="2026042004.00">5.2.4 (Build: 20261005)</a>`.
 */
export function parseRelease(html) {
  const m = /<a[^>]*href="[^"]*[Rr]eleases[^"]*"[^>]*title="(\d{10}(?:\.\d+)?)"[^>]*>([^<]+)<\/a>/.exec(html || '');
  return m ? { version: m[1], release: m[2].trim() } : null;
}

/** when new code is on disk, admin/index.php shows "Moodle <release>" over an upgrade form. */
export function parsePendingUpgrade(html) {
  if (!/name="confirmupgrade"/.test(html || '')) return null;
  const m = /<h2[^>]*>\s*Moodle\s+([^<]+?)\s*<\/h2>/.exec(html);
  return { release: m ? m[1] : '' };
}

/** "5.2.4 (Build: 20261005)" -> "5.2"; "6.0dev" -> "6.0". */
export function branchOf(release) {
  const m = /^(\d+)\.(\d+)/.exec(String(release || '').trim());
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

/** the update API writes branches as "5.02"; release strings say "5.2". */
export function normalizeBranch(branch) {
  const [major, minor] = String(branch).split('.');
  return `${Number(major)}.${Number(minor || 0)}`;
}

function compareBranch(a, b) {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}

/**
 * splits the update API's answer into the two things worth saying: a newer point
 * release on this branch, and the newest stable branch beyond it. Dev and beta
 * builds are ignored.
 */
export function classifyUpdates(response, current) {
  const branch = branchOf(current && current.release);
  const core = (response && response.updates && response.updates.core) || [];
  if (!branch) return { patch: null, newer: null };
  const stable = core
    .filter((u) => u.maturity >= STABLE && Number(u.version) > Number(current.version))
    .sort((a, b) => Number(b.version) - Number(a.version));
  return {
    patch: stable.find((u) => normalizeBranch(u.branch) === branch) || null,
    newer: stable.find((u) => compareBranch(normalizeBranch(u.branch), branch) > 0) || null
  };
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$|\.(test|local|localhost|internal|ddev\.site|lndo\.site)$/;
const STAGING_HOST = /(^|[.-])(dev|develop|staging|stage|stg|test|testing|uat|qa|preview|sandbox|multidev)([.-]|\d|$)/;

/**
 * A first guess the user can override. Anything unrecognised is treated as live,
 * because the expensive mistake is toggling debugging on production.
 */
export function guessEnv(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (LOCAL_HOST.test(host)) return 'local';
  if (STAGING_HOST.test(host)) return 'staging';
  return 'live';
}

/** Chrome match patterns cannot carry a port, so a grant covers every port on the host. */
export function hostPattern(wwwroot) {
  const url = new URL(wwwroot);
  return `${url.protocol}//${url.hostname}/*`;
}

/** is this URL inside the Moodle install at wwwroot (which may live in a subdirectory)? */
export function underRoot(url, wwwroot) {
  return url === wwwroot || String(url).startsWith(`${wwwroot}/`) || String(url).startsWith(`${wwwroot}?`);
}

/** `query` is what admin/search.php is asked for; each search returns a form holding the setting. */
export const DEV_SETTINGS = [
  { name: 'debug', query: 'debug', label: 'Debug messages' },
  { name: 'debugdisplay', query: 'debug', label: 'Display debug messages' },
  { name: 'perfdebug', query: 'debug', label: 'Performance info' },
  { name: 'debugstringids', query: 'debug', label: 'Show string identifiers' },
  { name: 'themedesignermode', query: 'themedesignermode', label: 'Theme designer mode' },
  { name: 'cachejs', query: 'cachejs', label: 'Cache JavaScript' }
];

export const PURGE_OPTIONS = [
  { name: 'theme', label: 'Themes' },
  { name: 'js', label: 'JavaScript' },
  { name: 'lang', label: 'Language strings' },
  { name: 'template', label: 'Templates' },
  { name: 'courses', label: 'Courses' },
  { name: 'filter', label: 'Text filters' },
  { name: 'muc', label: 'MUC caches' },
  { name: 'other', label: 'Other' }
];

/** "DEVELOPER: extra Moodle debug messages for developers" -> "Developer"; the full text stays in the tooltip. */
export function shortChoice(label) {
  const head = String(label).split(':')[0].trim();
  return head === head.toUpperCase() ? head.charAt(0) + head.slice(1).toLowerCase() : head;
}

/** `s_` + plugin + `_` + name; core settings have an empty plugin. */
export function settingField(name) {
  return `s__${name}`;
}

/** form fields that save one setting through admin/search.php. */
export function saveFields(setting, value, sesskey) {
  return {
    sesskey,
    action: 'save-settings',
    query: setting.query,
    [settingField(setting.name)]: String(value)
  };
}

/** context-aware destinations. Paths are relative to wwwroot. */
export function jumpLinks(ctx) {
  const a = ctx.admin;
  const links = [
    { group: 'Site', label: 'Site administration', path: `/${a}/search.php` },
    { group: 'Site', label: 'Notifications', path: `/${a}/index.php` },
    { group: 'Site', label: 'Plugins overview', path: `/${a}/plugins.php` },
    { group: 'Site', label: 'Purge caches page', path: `/${a}/purgecaches.php` },
    { group: 'Site', label: 'Cache configuration', path: '/cache/admin.php' },
    { group: 'Site', label: 'Scheduled tasks', path: `/${a}/tool/task/scheduledtasks.php` },
    { group: 'Site', label: 'Debugging settings', path: `/${a}/settings.php?section=debugging` },
    { group: 'Site', label: 'Themes', path: `/${a}/themeselector.php` },
    { group: 'Site', label: 'Browse users', path: `/${a}/user.php` },
    { group: 'Site', label: 'Language customisation', path: `/${a}/tool/customlang/index.php` },
    { group: 'Site', label: 'Environment', path: `/${a}/environment.php` },
    { group: 'Site', label: 'Site logs', path: `/report/log/index.php?id=${ctx.siteId}` }
  ];
  if (ctx.courseId) {
    const id = ctx.courseId;
    links.push(
      { group: 'Course', label: 'Course page', path: `/course/view.php?id=${id}` },
      { group: 'Course', label: 'Course settings', path: `/course/edit.php?id=${id}` },
      { group: 'Course', label: 'Participants', path: `/user/index.php?id=${id}` },
      { group: 'Course', label: 'Enrolment methods', path: `/enrol/instances.php?id=${id}` },
      { group: 'Course', label: 'Gradebook setup', path: `/grade/edit/tree/index.php?id=${id}` },
      { group: 'Course', label: 'Grader report', path: `/grade/report/grader/index.php?id=${id}` },
      { group: 'Course', label: 'Course logs', path: `/report/log/index.php?id=${id}` },
      { group: 'Course', label: 'Backup course', path: `/backup/backup.php?id=${id}` },
      { group: 'Course', label: 'Reset course', path: `/course/reset.php?id=${id}` },
      { group: 'Course', label: 'Groups', path: `/group/index.php?id=${id}` },
      { group: 'Course', label: 'Course completion settings', path: `/course/completion.php?id=${id}` },
      { group: 'Course', label: 'Activity completion report', path: `/report/progress/index.php?course=${id}` },
      { group: 'Course', label: 'Activity report', path: `/report/outline/index.php?id=${id}` },
      { group: 'Course', label: 'Course participation', path: `/report/participation/index.php?id=${id}` }
    );
    if (ctx.courseContextId) {
      links.push({ group: 'Course', label: 'Recycle bin', path: `/${a}/tool/recyclebin/index.php?contextid=${ctx.courseContextId}` });
    }
  }
  if (ctx.cmid) {
    if (ctx.modname) {
      links.push({ group: 'Activity', label: 'Activity page', path: `/mod/${ctx.modname}/view.php?id=${ctx.cmid}` });
    }
    links.push({ group: 'Activity', label: 'Activity settings', path: `/course/modedit.php?update=${ctx.cmid}` });
    if (ctx.courseId) {
      links.push({ group: 'Activity', label: 'Backup activity', path: `/backup/backup.php?id=${ctx.courseId}&cm=${ctx.cmid}` });
    }
  }
  if (ctx.categoryId && !ctx.courseId) {
    links.push({ group: 'Category', label: 'Manage this category', path: `/course/management.php?categoryid=${ctx.categoryId}` });
  }
  if (ctx.contextId) {
    const c = ctx.contextId;
    links.push(
      { group: 'This context', label: 'Permissions', path: `/${a}/roles/permissions.php?contextid=${c}` },
      { group: 'This context', label: 'Check permissions', path: `/${a}/roles/check.php?contextid=${c}` },
      { group: 'This context', label: 'Assign roles', path: `/${a}/roles/assign.php?contextid=${c}` },
      { group: 'This context', label: 'Filters', path: `/filter/manage.php?contextid=${c}` }
    );
  }
  return links;
}

/** case-insensitive, every typed word must appear in group or label. */
export function filterLinks(links, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return links;
  return links.filter((l) => {
    const hay = `${l.group} ${l.label}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** editmode.php flips $USER->editing and redirects back to pageurl. */
export function editModeUrl(ctx, on) {
  // before 4.0 the page's own "Turn editing on/off" button is the switch
  if (ctx.legacyEditUrl) return ctx.legacyEditUrl;
  const q = new URLSearchParams({
    setmode: on ? '1' : '0',
    context: String(ctx.contextId),
    pageurl: ctx.url,
    sesskey: ctx.sesskey
  });
  return `${ctx.wwwroot}/editmode.php?${q}`;
}

/** "in 4m", "in 1h 5m" for a revert timer. */
export function untilLabel(at, now = Date.now()) {
  const mins = Math.max(0, Math.ceil((at - now) / 60000));
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}
