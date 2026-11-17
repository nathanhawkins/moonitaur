// timed reverts: when a developer setting is changed on a non-local site, the
// value it had before is kept here with a deadline. The service worker puts it
// back when the deadline passes, through any open tab on that site; if none is
// open, the popup does it the next time it opens there.

import { DEV_SETTINGS, saveFields } from './moodle.js';
import { request } from './site.js';

const KEY = 'reverts';

export async function allReverts() {
  const { [KEY]: reverts } = await chrome.storage.local.get(KEY);
  return reverts || {};
}

export async function siteReverts(wwwroot) {
  return (await allReverts())[wwwroot] || {};
}

async function save(reverts) {
  await chrome.storage.local.set({ [KEY]: reverts });
  await schedule(reverts);
}

/** keeps the earliest original: changing a setting twice should still restore the first value. */
export async function recordRevert(wwwroot, name, original, minutes, form = null) {
  const reverts = await allReverts();
  const site = reverts[wwwroot] || {};
  const at = Date.now() + minutes * 60000;
  site[name] = { value: site[name] ? site[name].value : original, at, ...(form ? { form } : {}) };
  reverts[wwwroot] = site;
  await save(reverts);
}

/** changing a setting back by hand cancels its pending revert. */
export async function clearRevert(wwwroot, name) {
  const reverts = await allReverts();
  if (!reverts[wwwroot] || !reverts[wwwroot][name]) return;
  delete reverts[wwwroot][name];
  if (!Object.keys(reverts[wwwroot]).length) delete reverts[wwwroot];
  await save(reverts);
}

/** applies every due revert for this site through the given tab. Returns the names restored. */
export async function applyDue(tabId, ctx, now = Date.now()) {
  const reverts = await allReverts();
  const site = reverts[ctx.wwwroot];
  if (!site) return [];
  const done = [];
  for (const [name, entry] of Object.entries(site)) {
    if (entry.at > now) continue;
    const url = `${ctx.wwwroot}/${ctx.admin}/search.php`;
    const setting = DEV_SETTINGS.find((s) => s.name === name);
    // settings changed through "Change any setting" keep the exact form fields that saved them
    if (entry.form) await request(tabId, url, 'POST', { sesskey: ctx.sesskey, action: 'save-settings', query: entry.form.query, [entry.form.field]: String(entry.value) });
    else if (setting) await request(tabId, url, 'POST', saveFields(setting, entry.value, ctx.sesskey));
    delete site[name];
    done.push(name);
  }
  if (!Object.keys(site).length) delete reverts[ctx.wwwroot];
  if (done.length) await save(reverts);
  return done;
}

/** one alarm, set for the earliest deadline across all sites. */
export async function schedule(reverts) {
  const times = Object.values(reverts).flatMap((site) => Object.values(site).map((e) => e.at));
  await chrome.alarms.clear('moonitaur-revert');
  if (times.length) chrome.alarms.create('moonitaur-revert', { when: Math.max(Date.now() + 1000, Math.min(...times)) });
}
