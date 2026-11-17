// a quick accessibility pass over the current page: the checks that catch most
// problems in course content. Not a full WCAG audit, and the sheet says so.

import { el, openSheet, status, note } from './ui.js';

function checkPage() {
  const MARK = 'data-moonitaur-a11y';
  for (const node of document.querySelectorAll(`[${MARK}]`)) node.removeAttribute(MARK);
  const visible = (node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const describe = (node) => {
    const text = (node.textContent || node.getAttribute('src') || node.getAttribute('name') || node.tagName).trim().replace(/\s+/g, ' ');
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  };
  const named = (node) => Boolean(
    (node.getAttribute('aria-label') || '').trim() || node.getAttribute('aria-labelledby') || (node.getAttribute('title') || '').trim()
  );
  const issues = {};
  const add = (key, node, detail) => {
    (issues[key] ||= []).push(detail || describe(node));
    node.setAttribute(MARK, key);
  };

  for (const img of document.querySelectorAll('img:not([alt])')) if (visible(img)) add('alt', img, (img.getAttribute('src') || '').split('/').pop().split('?')[0]);

  for (const a of document.querySelectorAll('a[href]')) {
    if (!visible(a) || named(a)) continue;
    const text = a.textContent.trim();
    const imgAlt = [...a.querySelectorAll('img[alt]')].some((i) => i.alt.trim());
    if (!text && !imgAlt) add('link', a, a.getAttribute('href'));
  }

  for (const b of document.querySelectorAll('button, [role="button"]')) {
    if (!visible(b) || named(b)) continue;
    if (!b.textContent.trim() && ![...b.querySelectorAll('img[alt]')].some((i) => i.alt.trim())) add('button', b, b.className || 'button');
  }

  for (const field of document.querySelectorAll('input, select, textarea')) {
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(field.type) || !visible(field) || named(field)) continue;
    const labelled = (field.id && document.querySelector(`label[for="${CSS.escape(field.id)}"]`)) || field.closest('label');
    if (!labelled) add('label', field, field.name || field.type);
  }

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible);
  if (!headings.some((h) => h.tagName === 'H1')) (issues.h1 ||= []).push('No main heading on this page');
  let last = 0;
  for (const h of headings) {
    const level = Number(h.tagName[1]);
    if (last && level > last + 1) add('skip', h, `${h.tagName} after H${last}: ${describe(h)}`);
    last = level;
  }

  if (!document.documentElement.getAttribute('lang')) (issues.lang ||= []).push('The page has no language set');

  // contrast: sample elements that hold their own text
  const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const background = (node) => {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.backgroundImage !== 'none') return null;
      const c = parse(style.backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) return c;
    }
    return [255, 255, 255];
  };
  let sampled = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode() && sampled < 600) {
    const parent = walker.currentNode.parentElement;
    if (!parent || seen.has(parent) || !walker.currentNode.textContent.trim() || !visible(parent)) continue;
    seen.add(parent);
    sampled++;
    const style = getComputedStyle(parent);
    const fg = parse(style.color);
    const bg = background(parent);
    if (!bg || (fg[3] !== undefined && fg[3] < 1)) continue;
    const [a, b] = [lum(fg), lum(bg)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) add('contrast', parent, `${ratio.toFixed(1)}:1 · ${describe(parent)}`);
  }
  return issues;
}

function highlight(on) {
  const id = 'moonitaur-a11y-style';
  document.getElementById(id)?.remove();
  if (!on) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = '[data-moonitaur-a11y] { outline: 3px solid #D0482C !important; outline-offset: 2px !important; }';
  document.head.append(style);
  document.querySelector('[data-moonitaur-a11y]')?.scrollIntoView({ block: 'center' });
}

const CHECKS = [
  ['alt', 'Images with no alt text', 'Add a description, or mark the image as decorative.'],
  ['contrast', 'Text with low contrast', 'Needs 4.5:1, or 3:1 for large text.'],
  ['link', 'Links with no text', 'Screen readers announce these as just “link”.'],
  ['button', 'Buttons with no name', 'Give icon buttons a label.'],
  ['label', 'Form fields with no label', ''],
  ['skip', 'Skipped heading levels', 'Headings should go down one level at a time.'],
  ['h1', 'Missing main heading', ''],
  ['lang', 'Missing page language', '']
];

export async function runA11yCheck(app) {
  status('Checking this page…');
  let issues;
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId: app.tab.id }, func: checkPage });
    issues = frame.result;
  } catch (e) {
    return status(`Could not check this page: ${e.message}`, 'bad');
  }
  const found = CHECKS.filter(([key]) => issues[key] && issues[key].length);
  const body = found.length
    ? found.map(([key, title, help]) => el('details', { className: 'card issue' },
      el('summary', {}, el('span', { className: 'label', textContent: title }), el('span', { className: 'count', textContent: String(issues[key].length) })),
      help ? note(help) : null,
      el('ul', {}, ...issues[key].slice(0, 8).map((text) => el('li', { textContent: text }))),
      issues[key].length > 8 ? note(`and ${issues[key].length - 8} more`) : null))
    : [el('div', { className: 'callout' }, el('strong', { textContent: 'No problems found' }), 'These checks cover common problems only. A full audit still needs a person and a screen reader.')];

  const actions = [];
  if (found.length) {
    const show = el('button', { className: 'primary', textContent: 'Outline them on the page' });
    show.addEventListener('click', async () => {
      await chrome.scripting.executeScript({ target: { tabId: app.tab.id }, func: highlight, args: [true] });
      window.close();
    });
    actions.push(show);
  }
  const total = found.reduce((sum, [key]) => sum + issues[key].length, 0);
  openSheet({
    view: 'a11y',
    title: found.length ? `${total} accessibility ${total === 1 ? 'problem' : 'problems'}` : 'Accessibility check',
    text: found.length ? 'Common problems on this page. Not a full audit.' : '',
    body,
    actions,
    tall: true
  });
}
