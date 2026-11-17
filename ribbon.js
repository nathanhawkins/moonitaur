// environment ribbon: a coloured edge and a corner label, so a live site never
// looks like a local one. Injected only on hosts the user enabled it for.
(() => {
  // the popup injects this directly when the ribbon is switched on, and the registered script may follow
  if (globalThis.moonitaurRibbon) return;
  globalThis.moonitaurRibbon = true;
  const COLORS = { live: '#E5534B', staging: '#E3A33A', local: '#5FAE7A' };
  const LABELS = { live: 'LIVE', staging: 'STAGING', local: 'LOCAL' };
  let host = null;

  function within(url, root) {
    return url === root || url.startsWith(`${root}/`) || url.startsWith(`${root}?`);
  }

  function render(sites) {
    const match = Object.entries(sites || {})
      .filter(([root, s]) => s.ribbon && COLORS[s.env] && within(location.href, root))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (host) host.remove();
    host = null;
    if (!match) return;
    const env = match[1].env;

    host = document.createElement('div');
    host.setAttribute('data-moonitaur', '');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .edge { position: fixed; inset: 0 0 auto 0; height: 3px; background: ${COLORS[env]}; z-index: 2147483647; pointer-events: none; }
      .tag { position: fixed; left: 10px; bottom: 10px; z-index: 2147483647; pointer-events: none;
        font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: .08em;
        color: #fff; background: ${COLORS[env]}; padding: 6px 8px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.25); opacity: .92; }
    </style><div class="edge"></div><div class="tag"></div>`;
    shadow.querySelector('.tag').textContent = `${LABELS[env]} · ${location.host}`;
    document.documentElement.append(host);
  }

  chrome.storage.local.get('sites').then(({ sites }) => render(sites));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sites) render(changes.sites.newValue);
  });
})();
