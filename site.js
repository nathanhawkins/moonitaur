// talking to a Moodle tab. Every request runs inside the tab itself, so it goes
// out as the signed-in user with their session cookie and Moodle applies its own
// permission checks. Nothing here needs a server-side plugin.

import {
  pageContext, parseRelease, parsePendingUpgrade, classifyUpdates, branchOf,
  saveFields, settingField, DEV_SETTINGS
} from './moodle.js';

const UPDATES_API = 'https://download.moodle.org/api/1.3/updates.php';

function probePage() {
  const marker = 'M.cfg = ';
  let cfgText = null;
  for (const script of document.scripts) {
    const text = script.textContent;
    const at = text.indexOf(marker);
    if (at !== -1) {
      cfgText = text.slice(at + marker.length);
      break;
    }
  }
  return {
    cfgText,
    bodyId: document.body ? document.body.id : '',
    bodyClass: document.body ? document.body.className : '',
    url: location.href,
    // site admins get the "Site administration" link in the primary navigation
    hasAdmin: Boolean(document.querySelector('a[href*="/admin/search.php"]')),
    // the edit mode switch is only rendered for people who can edit this page; before 4.0 it was a button
    canEdit: Boolean(document.querySelector('input[name="setmode"], form input[name="edit"]')),
    legacyEditUrl: (() => {
      const form = document.querySelector('form input[name="edit"]')?.form;
      return form ? `${form.action}?${new URLSearchParams(new FormData(form))}` : '';
    })(),
    // Moodle 5.0 and older have no user id in M.cfg
    pageUserId: Number(/[?&]id=(\d+)/.exec(document.querySelector('.usermenu a[href*="/user/profile.php?id="]')?.href || '')?.[1]
      || document.querySelector('.popover-region[data-userid]')?.dataset.userid || 0),
    hasLogout: Boolean(document.querySelector('a[href*="/login/logout.php"]')),
    // the user menu offers "Return to my normal role" only while switched
    switchedRole: Boolean(document.querySelector('a[href*="switchrole=0"]')),
    // while logged in as someone, the user menu shows the real user's avatar next to theirs
    loggedInAs: Boolean(document.querySelector('.avatar.realuser, .meta.viewingas')),
    // guests count as logged in to Moodle; only real accounts get a log out link
    guest: !document.querySelector('a[href*="/login/logout.php"]') && Boolean(document.querySelector('a[href*="/login/index.php"]')),
    loggedInAsName: (document.querySelector('.meta.viewingas .value')?.textContent || '').trim()
  };
}

async function pageRequest(url, method, fields) {
  const init = { method, credentials: 'same-origin' };
  if (fields) init.body = new URLSearchParams(fields);
  const res = await fetch(url, init);
  return { status: res.status, url: res.url, html: await res.text() };
}

async function pageService(url, body) {
  const res = await fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body
  });
  return { status: res.status, text: await res.text() };
}

export async function probe(tabId) {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: probePage });
  return frame && frame.result ? pageContext(frame.result) : null;
}

export async function request(tabId, url, method = 'GET', fields = null) {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId }, func: pageRequest, args: [url, method, fields]
  });
  if (!frame || !frame.result) throw new Error('The page did not answer.');
  return frame.result;
}

/** fetches a Moodle page as the signed-in user and parses it. Throws NotAdminError on a login redirect. */
export async function fetchDoc(tabId, url) {
  const res = await request(tabId, url);
  if (landedOnLogin(res)) throw new NotAdminError();
  if (res.status >= 400) throw new Error(`Moodle answered ${res.status}.`);
  return { doc: parse(res.html), url: res.url };
}

/** calls one function through Moodle's own AJAX endpoint, the one its pages use. */
// functions newer than Moodle 3.9; older sites do not have them in their function list
const ADDED_IN = { core_courseformat_get_state: '4.0', core_courseformat_update_course: '4.0', core_user_search_identity: '3.11' };

export class OldMoodleError extends Error {
  constructor(version) {
    super(`Needs Moodle ${version} or newer. Ask your site administrator about upgrading.`);
  }
}

export async function service(tabId, ctx, methodname, args) {
  const url = `${ctx.wwwroot}/lib/ajax/service.php?sesskey=${encodeURIComponent(ctx.sesskey)}&info=${encodeURIComponent(methodname)}`;
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId }, func: pageService, args: [url, JSON.stringify([{ index: 0, methodname, args }])]
  });
  if (!frame || !frame.result) throw new Error('The page did not answer.');
  let reply;
  try {
    reply = JSON.parse(frame.result.text);
  } catch {
    throw new Error(`Moodle answered ${frame.result.status} to ${methodname}.`);
  }
  const first = Array.isArray(reply) ? reply[0] : reply;
  if (!first || first.error) {
    // a function the site does not have fails the whole request, as a bare { error, errorcode }
    const ex = first?.exception || { message: typeof first?.error === 'string' ? first.error : '', errorcode: first?.errorcode };
    if (ex.errorcode === 'invalidrecord' && ADDED_IN[methodname]) throw new OldMoodleError(ADDED_IN[methodname]);
    throw new Error(ex.message || `Moodle refused ${methodname}.`);
  }
  return first.data;
}

/** reads a Moodle form page and returns its fields, so a submit keeps Moodle's own hidden values. */
export async function readForm(tabId, url, selector) {
  const page = await request(tabId, url);
  if (landedOnLogin(page)) throw new NotAdminError();
  const doc = parse(page.html);
  const form = doc.querySelector(selector);
  // a permission error page names the capability that is missing
  if (!form) throw new Error(doc.querySelector('.errormessage')?.textContent.trim() || 'Moodle did not show the expected form.');
  const fields = {};
  for (const input of form.querySelectorAll('input, select, textarea')) {
    if (!input.name || input.disabled) continue;
    if ((input.type === 'checkbox' || input.type === 'radio') && !input.checked) continue;
    if (input.type === 'submit' || input.type === 'button') continue;
    fields[input.name] = input.value;
  }
  const action = new URL(form.getAttribute('action') || page.url, page.url).href;
  return { fields, action, doc, form };
}

export class NotAdminError extends Error {
  constructor() {
    super('Sign in as a site administrator for this.');
  }
}

export function landedOnLogin(res) {
  return /\/login\/index\.php/.test(res.url) || /id="page-login-index"/.test(res.html);
}

function adminUrl(ctx, path) {
  return `${ctx.wwwroot}/${ctx.admin}/${path}`;
}

// DOMParser exists in the popup, not the service worker, so only the popup reads pages.
export function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** { state: 'ok', version, release } | { state: 'pending', release } | { state: 'denied' } */
export async function readVersion(tabId, ctx) {
  const res = await request(tabId, adminUrl(ctx, 'index.php'));
  if (landedOnLogin(res)) return { state: 'denied' };
  const pending = parsePendingUpgrade(res.html);
  if (pending) return { state: 'pending', ...pending };
  const release = parseRelease(res.html);
  return release ? { state: 'ok', ...release } : { state: 'denied' };
}

/** asks moodle.org the same question Moodle's own update checker asks. Sends version and branch only. */
export async function checkUpdates(current) {
  const body = new URLSearchParams({
    format: 'json',
    version: current.version,
    branch: branchOf(current.release)
  });
  const res = await fetch(UPDATES_API, { method: 'POST', body });
  if (!res.ok) throw new Error(`moodle.org answered ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK') throw new Error('moodle.org did not return updates');
  return classifyUpdates(json, current);
}

function readSetting(doc, name) {
  const fields = [...doc.getElementsByName(settingField(name))];
  const el = fields.find((f) => f.type !== 'hidden');
  if (!el) return null;
  if (el.tagName === 'SELECT') {
    return {
      kind: 'select',
      value: el.value,
      options: [...el.options].map((o) => ({ value: o.value, label: o.textContent.trim() })),
      locked: el.disabled
    };
  }
  // a checkbox setting renders a hidden "no" input first; it is absent when forced in config.php.
  const hidden = fields.find((f) => f.type === 'hidden');
  const no = hidden ? hidden.value : '0';
  return { kind: 'checkbox', on: el.checked, yes: el.value, no, value: el.checked ? el.value : no, locked: el.disabled };
}

/** map of setting name -> current state, read through admin/search.php. */
export async function readSettings(tabId, ctx) {
  const queries = [...new Set(DEV_SETTINGS.map((s) => s.query))];
  const pages = await Promise.all(queries.map(async (query) => {
    const res = await request(tabId, `${adminUrl(ctx, 'search.php')}?query=${encodeURIComponent(query)}`);
    if (landedOnLogin(res)) throw new NotAdminError();
    return [query, parse(res.html)];
  }));
  const docs = Object.fromEntries(pages);
  const out = {};
  for (const s of DEV_SETTINGS) out[s.name] = readSetting(docs[s.query], s.name);
  if (Object.values(out).every((v) => v === null)) throw new NotAdminError();
  return out;
}

/** saves one setting. Callers re-read afterwards: that read is the confirmation. */
export async function writeSetting(tabId, ctx, setting, value) {
  const res = await request(tabId, adminUrl(ctx, 'search.php'), 'POST', saveFields(setting, value, ctx.sesskey));
  if (landedOnLogin(res)) throw new NotAdminError();
  if (res.status >= 400) throw new Error(`Moodle answered ${res.status}`);
}

// purgecaches.php confirms with NOTIFY_INFO when it stays on its own page, which renders as alert-info
function purged(res) {
  if (landedOnLogin(res)) throw new NotAdminError();
  return res.status < 400 && /alert-(info|success)/.test(res.html);
}

export async function purgeAll(tabId, ctx) {
  const q = new URLSearchParams({ confirm: '1', sesskey: ctx.sesskey });
  return purged(await request(tabId, `${adminUrl(ctx, 'purgecaches.php')}?${q}`));
}

/** loads the purge form, keeps its hidden fields (sesskey, form id), ticks the chosen caches. */
export async function purgeSelected(tabId, ctx, names) {
  const page = await request(tabId, adminUrl(ctx, 'purgecaches.php'));
  if (landedOnLogin(page)) throw new NotAdminError();
  const doc = parse(page.html);
  const button = doc.querySelector('[name="purgeselectedcaches"]');
  if (!button || !button.form) throw new Error('Moodle did not show the purge form.');
  const fields = {};
  for (const input of button.form.querySelectorAll('input[type="hidden"]')) fields[input.name] = input.value;
  for (const name of names) fields[`purgeselectedoptions[${name}]`] = '1';
  fields.purgeselectedcaches = button.value || '1';
  const action = new URL(button.form.getAttribute('action') || page.url, page.url).href;
  return purged(await request(tabId, action, 'POST', fields));
}
