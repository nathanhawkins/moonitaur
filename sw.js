import { probe } from './site.js';
import { allReverts, applyDue, schedule } from './reverts.js';
import { hostPattern, underRoot } from './moodle.js';

const RETRY_MINUTES = 5;

async function runDueReverts() {
  const now = Date.now();
  let stranded = false;
  for (const [wwwroot, site] of Object.entries(await allReverts())) {
    if (!Object.values(site).some((e) => e.at <= now)) continue;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: hostPattern(wwwroot) });
    } catch {
      // no access to this host: the popup will catch it up
    }
    let done = false;
    for (const tab of tabs) {
      if (!tab.url || !underRoot(tab.url, wwwroot)) continue;
      try {
        const ctx = await probe(tab.id);
        if (ctx && ctx.wwwroot === wwwroot && ctx.signedIn) {
          await applyDue(tab.id, ctx, now);
          done = true;
          break;
        }
      } catch {
        // tab mid-navigation or signed out; try the next one
      }
    }
    if (!done) stranded = true;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#E5534B' });
  await chrome.action.setBadgeText({ text: stranded ? '!' : '' });
  // a stranded revert is already past due, so scheduling by deadline would fire every second
  if (stranded) chrome.alarms.create('moonitaur-revert', { delayInMinutes: RETRY_MINUTES });
  else await schedule(await allReverts());
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'moonitaur-revert') runDueReverts();
});

// registered only for hosts the user granted, so nothing runs on sites they never chose.

const RIBBON = 'moonitaur-ribbon';
let ribbonSync = Promise.resolve();

async function syncRibbon() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  const wanted = [...new Set(Object.entries(sites).filter(([, s]) => s.ribbon).map(([root]) => hostPattern(root)))];
  const matches = [];
  for (const pattern of wanted) {
    if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [RIBBON] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [RIBBON] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{ id: RIBBON, matches, js: ['ribbon.js'], runAt: 'document_idle' }]);
  }
}

function queueRibbonSync() {
  ribbonSync = ribbonSync.then(syncRibbon, syncRibbon);
  return ribbonSync;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'sites' in changes) queueRibbonSync();
});
chrome.permissions.onAdded.addListener(queueRibbonSync);
chrome.permissions.onRemoved.addListener(queueRibbonSync);
// the icon is red by default. Once the user allows site access, detect.js runs on
// every page and reports whether it is Moodle; the icon and its tooltip follow.

const DETECT = 'moonitaur-detect';
const ALL_SITES = '*://*/*';
const ICON = {
  moodle: { path: { 16: 'icons/16.png', 32: 'icons/32.png' }, title: 'Moonitaur: this is a Moodle site' },
  other: { path: { 16: 'icons/off-16.png', 32: 'icons/off-32.png' }, title: 'Moonitaur: not a Moodle page' }
};

function showDetected(tabId, moodle) {
  const icon = moodle ? ICON.moodle : ICON.other;
  chrome.action.setIcon({ tabId, path: icon.path }).catch(() => {});
  chrome.action.setTitle({ tabId, title: icon.title }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.tab && typeof message.moonitaurDetect === 'boolean') showDetected(sender.tab.id, message.moonitaurDetect);
});

async function syncDetect() {
  const allowed = await chrome.permissions.contains({ origins: [ALL_SITES] });
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DETECT] });
  if (existing.length && !allowed) await chrome.scripting.unregisterContentScripts({ ids: [DETECT] });
  if (!existing.length && allowed) {
    await chrome.scripting.registerContentScripts([{ id: DETECT, matches: ['<all_urls>'], js: ['detect.js'], runAt: 'document_end', allFrames: false }]);
    // pages already open get checked now, not on their next load
    for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['detect.js'] }).catch(() => {});
    }
  }
}

chrome.permissions.onAdded.addListener(syncDetect);
chrome.permissions.onRemoved.addListener(syncDetect);

chrome.runtime.onInstalled.addListener(() => {
  syncDetect();
  queueRibbonSync();
  runDueReverts();
});
chrome.runtime.onStartup.addListener(() => {
  syncDetect();
  queueRibbonSync();
  runDueReverts();
});
