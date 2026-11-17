// runs on every page once the user allows it: tells the worker whether this is
// Moodle, so the toolbar icon is green or red before anyone clicks it. Reads two
// attributes on <body> and nothing else.
(() => {
  const body = document.body;
  const moodle = Boolean(body && body.id.startsWith('page-') && /(^|\s)pagelayout-/.test(body.className));
  chrome.runtime.sendMessage({ moonitaurDetect: moodle }).catch(() => {});
})();
