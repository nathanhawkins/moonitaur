// the Course tab: for anyone who can edit the course they are looking at. Every
// call runs as the signed-in user, so Moodle's own permissions still apply.

import { editModeUrl } from './moodle.js';
import { service, fetchDoc, request, readForm, parse } from './site.js';
import { $, el, status, openSheet, closeSheet, confirmAction, toolRow, note, formatDateTime } from './ui.js';

let app = null;

const courseUrl = (path) => `${app.ctx.wwwroot}${path}`;
const C = () => app.ctx.courseId;

function link(text, url, className = 'outline') {
  const a = el('a', { className, href: url, textContent: text });
  a.addEventListener('click', (e) => { e.preventDefault(); app.navigate(url, e.metaKey || e.ctrlKey); });
  return a;
}

// Moodle 3.x only names the course context on the course page itself
async function courseContextId() {
  if (!app.ctx.courseContextId) {
    const { html } = await request(app.tab.id, courseUrl(`/course/view.php?id=${C()}`));
    app.ctx.courseContextId = Number(/"contextid":(\d+)/.exec(html)?.[1] || 0);
  }
  return app.ctx.courseContextId;
}

function loading() {
  return el('div', { className: 'card rows' }, ...[150, 120, 170].map((w) => el('div', { className: 'row' }, el('span', { className: 'sk', style: `width: ${w}px; height: 12px` }))));
}

async function switchRoles() {
  const back = `/course/view.php?id=${C()}`;
  const { doc } = await fetchDoc(app.tab.id, courseUrl(`/course/switchrole.php?id=${C()}&switchrole=-1&returnurl=${encodeURIComponent(back)}`));
  return [...doc.querySelectorAll('form[action*="switchrole.php"]')].map((form) => ({
    id: form.querySelector('input[name="switchrole"]')?.value,
    name: (form.querySelector('button, input[type="submit"]')?.textContent || form.querySelector('input[type="submit"]')?.value || '').trim()
  })).filter((r) => r.id && r.id !== '0');
}

function switchTo(roleid) {
  const q = new URLSearchParams({ id: String(C()), switchrole: String(roleid), sesskey: app.ctx.sesskey, returnurl: `/course/view.php?id=${C()}` });
  app.navigate(courseUrl(`/course/switchrole.php?${q}`), false);
}

async function viewAs() {
  let roles;
  try {
    roles = await switchRoles();
  } catch (e) {
    return status(e.message, 'bad');
  }
  if (!roles.length) return status('Moodle offers no roles to switch to in this course.', 'bad');
  const student = roles.filter((r) => /student/i.test(r.name));
  if (student.length === 1) return switchTo(student[0].id);
  openSheet({
    title: 'View this course as',
    text: 'Switch back from the user menu, or from Moonitaur.',
    body: [el('div', { className: 'card list' }, ...roles.map((r) => {
      const b = el('button', {}, el('span', { className: 'label', textContent: r.name }));
      b.addEventListener('click', () => switchTo(r.id));
      return b;
    }))]
  });
}

export function switchBackButton(shared) {
  app = shared;
  const b = el('button', { className: 'primary', id: 'switch-back', textContent: 'Return to my normal role' });
  b.addEventListener('click', () => switchTo(0));
  return b;
}

async function getState() {
  return JSON.parse(await service(app.tab.id, app.ctx, 'core_courseformat_get_state', { courseid: C() }));
}

async function update(action, ids, target = {}) {
  return service(app.tab.id, app.ctx, 'core_courseformat_update_course', { action, courseid: C(), ids, ...target });
}

async function showOutline() {
  openSheet({ view: 'course-outline', title: 'Course outline', tall: true, body: [loading()] });
  let state;
  try {
    state = await getState();
  } catch (e) {
    return openSheet({ view: 'course-outline', title: 'Course outline', text: e.message, tall: true });
  }
  renderOutline(state);
}

function renderOutline(state) {
  const cms = new Map(state.cm.map((cm) => [cm.id, cm]));
  const sections = new Map(state.section.map((s) => [s.id, s]));
  const ordered = state.course.sectionlist.map((id) => sections.get(id)).filter(Boolean);

  const act = async (label, action, ids, target, { confirm } = {}) => {
    if (confirm && !(await confirmAction(app.site.env, confirm, { always: true, yes: label }))) return showOutline();
    if (!confirm && !(await confirmAction(app.site.env, `${label}?`))) return showOutline();
    status(`${label}…`);
    try {
      await update(action, ids, target);
      status(`${label}: done.`, 'ok');
    } catch (e) {
      status(e.message, 'bad');
    }
    showOutline();
  };

  const body = ordered.map((section) => {
    const list = section.cmlist.map((id) => cms.get(id)).filter(Boolean);
    const head = el('summary', {},
      el('span', { className: 'label', textContent: section.title || `Section ${section.number}` }),
      section.visible ? null : el('span', { className: 'badge warn', textContent: 'Hidden' }),
      el('span', { className: 'count', textContent: String(list.length) }));
    const sectionActions = el('div', { className: 'chips' });
    const addAction = (box, text, fn) => {
      const b = el('button', { textContent: text });
      b.addEventListener('click', fn);
      box.append(b);
    };
    if (section.number > 0) {
      addAction(sectionActions, section.visible ? 'Hide section' : 'Show section', () => act(section.visible ? 'Hide section' : 'Show section', section.visible ? 'section_hide' : 'section_show', [section.id]));
      addAction(sectionActions, 'Duplicate', () => act('Duplicate section', 'section_duplicate', [section.id]));
      addAction(sectionActions, 'Delete', () => act('Delete section', 'section_delete', [section.id], {}, {
        confirm: list.length ? `Delete “${section.title}” and its ${list.length} activities?` : `Delete “${section.title}”?`
      }));
    }
    const rows = list.map((cm, i) => {
      const actions = el('div', { className: 'chips' });
      addAction(actions, cm.visible ? 'Hide' : 'Show', () => act(cm.visible ? `Hide ${cm.name}` : `Show ${cm.name}`, cm.visible ? 'cm_hide' : 'cm_show', [cm.id]));
      addAction(actions, 'Duplicate', () => act(`Duplicate ${cm.name}`, 'cm_duplicate', [cm.id]));
      if (i > 0) addAction(actions, 'Move up', () => act(`Move ${cm.name}`, 'cm_move', [cm.id], { targetcmid: list[i - 1].id }));
      if (i < list.length - 1) {
        const after = list[i + 2];
        addAction(actions, 'Move down', () => act(`Move ${cm.name}`, 'cm_move', [cm.id], after ? { targetcmid: after.id } : { targetsectionid: section.id }));
      }
      if (cm.url) addAction(actions, 'Open', () => app.navigate(cm.url, false));
      addAction(actions, 'Delete', () => act(`Delete ${cm.name}`, 'cm_delete', [cm.id], {}, { confirm: `Delete “${cm.name}”?` }));
      const flags = [];
      if (!cm.visible) flags.push(el('span', { className: 'badge warn', textContent: 'Hidden' }));
      else if (cm.stealth) flags.push(el('span', { className: 'badge info', textContent: 'Unlisted' }));
      if (cm.hascmrestrictions) flags.push(el('span', { className: 'badge info', textContent: 'Restricted' }));
      return el('details', { className: 'cm' },
        el('summary', {}, el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: cm.name }), el('span', { className: 'detail', textContent: cm.modname })), ...flags),
        actions);
    });
    return el('details', { className: 'card section', open: ordered.length <= 4 }, head, sectionActions.childElementCount ? sectionActions : null,
      ...(rows.length ? rows : [note('No activities.')]));
  });

  const add = el('button', { className: 'outline', id: 'section-add', textContent: 'Add a section' });
  add.addEventListener('click', () => act('Add a section', 'section_add', []));
  openSheet({ view: 'course-outline', title: 'Course outline', text: 'Changes save straight away. Reload the course page to see them.', tall: true, body, actions: [add] });
}

async function showHealth() {
  openSheet({ view: 'course-health', title: 'Course health check', tall: true, body: [loading()] });
  let state;
  let doc;
  try {
    [state, { doc }] = await Promise.all([getState(), fetchDoc(app.tab.id, courseUrl(`/course/view.php?id=${C()}`))]);
  } catch (e) {
    return openSheet({ view: 'course-health', title: 'Course health check', text: e.message, tall: true });
  }
  const findings = [];
  const sections = state.section.filter((s) => s.number > 0);
  const cms = new Map(state.cm.map((cm) => [cm.id, cm]));

  const empty = sections.filter((s) => !s.cmlist.length && !s.hassummary);
  if (empty.length) findings.push(['warn', `${empty.length} empty ${empty.length === 1 ? 'section' : 'sections'}`, empty.map((s) => s.title)]);

  const hidden = state.cm.filter((cm) => !cm.visible);
  if (hidden.length) findings.push(['info', `${hidden.length} hidden ${hidden.length === 1 ? 'activity' : 'activities'}`, hidden.map((cm) => cm.name)]);

  const trapped = sections.filter((s) => !s.visible).flatMap((s) => s.cmlist.map((id) => cms.get(id)).filter((cm) => cm && cm.visible));
  if (trapped.length) findings.push(['warn', `${trapped.length} visible ${trapped.length === 1 ? 'activity' : 'activities'} inside hidden sections`, trapped.map((cm) => `${cm.name}: students cannot reach it`)]);

  const content = doc.querySelector('#region-main') || doc.body;
  const noAlt = [...content.querySelectorAll('img:not([alt])')];
  if (noAlt.length) findings.push(['warn', `${noAlt.length} ${noAlt.length === 1 ? 'image' : 'images'} with no alt text`, noAlt.map((img) => (img.getAttribute('src') || '').split('/').pop().split('?')[0])]);

  // same-site links in course content; other sites block reading their status
  const links = [...new Set([...content.querySelectorAll('.summarytext a[href], .activity-altcontent a[href], .description a[href]')]
    .map((a) => new URL(a.getAttribute('href'), app.ctx.wwwroot).href)
    .filter((href) => href.startsWith(app.ctx.wwwroot)))].slice(0, 25);
  const broken = [];
  await Promise.all(links.map(async (href) => {
    try {
      const res = await request(app.tab.id, href);
      if (res.status >= 400) broken.push(`${res.status}: ${href.replace(app.ctx.wwwroot, '')}`);
    } catch {
      broken.push(`No answer: ${href.replace(app.ctx.wwwroot, '')}`);
    }
  }));
  if (broken.length) findings.push(['bad', `${broken.length} broken ${broken.length === 1 ? 'link' : 'links'} in course text`, broken]);

  const body = findings.length
    ? findings.map(([tone, title, items]) => el('details', { className: 'card issue' },
      el('summary', {}, el('span', { className: `badge ${tone}`, textContent: tone === 'bad' ? 'Fix' : tone === 'warn' ? 'Check' : 'Note' }), el('span', { className: 'label', textContent: title })),
      el('ul', {}, ...items.slice(0, 12).map((t) => el('li', { textContent: t })))))
    : [el('div', { className: 'callout' }, el('strong', { textContent: 'Nothing to fix' }), `Checked ${state.cm.length} activities, ${sections.length} sections and ${links.length} links.`)];
  openSheet({ view: 'course-health', title: 'Course health check', text: findings.length ? `Checked ${state.cm.length} activities, ${sections.length} sections and ${links.length} links.` : '', tall: true, body });
}

async function showDates() {
  openSheet({ view: 'course-dates', title: 'Upcoming dates', tall: true, body: [loading()] });
  const now = new Date();
  const months = [0, 1, 2].map((i) => new Date(now.getFullYear(), now.getMonth() + i, 1));
  let events = new Map();
  try {
    const views = await Promise.all(months.map((d) => service(app.tab.id, app.ctx, 'core_calendar_get_calendar_monthly_view', {
      year: d.getFullYear(), month: d.getMonth() + 1, courseid: C(), day: 1, includenavigation: false, mini: false
    })));
    for (const view of views) {
      for (const week of view.weeks || []) {
        for (const day of week.days || []) {
          for (const event of day.events || []) {
            if (event.course && event.course.id === C() && event.timestart * 1000 >= Date.now() - 86400000) events.set(event.id, event);
          }
        }
      }
    }
  } catch (e) {
    return openSheet({ view: 'course-dates', title: 'Upcoming dates', text: e.message, tall: true });
  }
  events = [...events.values()].sort((a, b) => a.timestart - b.timestart);
  const rows = events.map((e) => {
    const row = el('a', { href: e.url || e.viewurl || '#' },
      el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: e.name }), el('span', { className: 'detail', textContent: e.activitystr || e.normalisedeventtypetext || '' })),
      el('span', { className: 'detail', textContent: formatDateTime(e.timestart) }));
    row.addEventListener('click', (ev) => { ev.preventDefault(); if (e.url || e.viewurl) app.navigate(e.url || e.viewurl, true); });
    return row;
  });
  const add = el('button', { className: 'outline', textContent: 'Add an event' });
  add.addEventListener('click', showAddEvent);
  openSheet({
    view: 'course-dates',
    title: 'Upcoming dates',
    text: events.length ? `Next three months in this course.` : 'Nothing in this course for the next three months.',
    tall: true,
    body: events.length ? [el('div', { className: 'card list' }, ...rows)] : [],
    actions: [add]
  });
}

function dateFields(prefix, date) {
  return {
    [`${prefix}[day]`]: String(date.getDate()),
    [`${prefix}[month]`]: String(date.getMonth() + 1),
    [`${prefix}[year]`]: String(date.getFullYear()),
    [`${prefix}[hour]`]: String(date.getHours()),
    [`${prefix}[minute]`]: String(date.getMinutes())
  };
}

function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function showAddEvent() {
  const name = el('input', { type: 'text', id: 'event-name', placeholder: 'Event name', ariaLabel: 'Event name' });
  const start = new Date(Date.now() + 86400000);
  start.setMinutes(0, 0, 0);
  const when = el('input', { type: 'datetime-local', id: 'event-when', value: localInputValue(start), ariaLabel: 'When' });
  const text = el('textarea', { id: 'event-text', rows: 3, placeholder: 'Description (optional)', ariaLabel: 'Description' });
  const save = el('button', { className: 'primary', id: 'event-save', textContent: 'Add to the course calendar' });
  save.addEventListener('click', async () => {
    if (!name.value.trim()) return status('Give the event a name.', 'bad');
    save.disabled = true;
    try {
      const fragment = await service(app.tab.id, app.ctx, 'core_get_fragment', {
        component: 'core_calendar', callback: 'event_form', contextid: await courseContextId(), args: [{ name: 'courseid', value: String(C()) }]
      });
      const form = parse(fragment.html).querySelector('form');
      const fields = {};
      for (const input of form.querySelectorAll('input, select, textarea')) {
        if (!input.name || input.type === 'submit' || ((input.type === 'checkbox' || input.type === 'radio') && !input.checked)) continue;
        fields[input.name] = input.value;
      }
      Object.assign(fields, dateFields('timestart', new Date(when.value)), {
        sesskey: app.ctx.sesskey, name: name.value.trim(), eventtype: 'course', courseid: String(C()), duration: '0',
        'description[text]': text.value, 'description[format]': '1'
      });
      const result = await service(app.tab.id, app.ctx, 'core_calendar_submit_create_update_form', { formdata: new URLSearchParams(fields).toString() });
      if (result.validationerror) throw new Error('Moodle did not accept the event. The date may be before the course starts.');
      status('Event added.', 'ok');
      closeSheet();
    } catch (e) {
      status(e.message, 'bad');
    } finally {
      save.disabled = false;
    }
  });
  openSheet({ view: 'course-event', title: 'Add a course event', text: 'Everyone in the course sees it in their calendar.', body: [el('div', { className: 'stack form' }, name, when, text)], actions: [save], focus: name });
}

async function showGrading() {
  openSheet({ view: 'course-grading', title: 'Grading queue', tall: true, body: [loading()] });
  let doc;
  try {
    ({ doc } = await fetchDoc(app.tab.id, courseUrl(`/course/overview.php?id=${C()}&expand[]=assign`)));
  } catch (e) {
    return openSheet({ view: 'course-grading', title: 'Grading queue', text: 'This needs Moodle 5.0 or newer.', tall: true, actions: [link('Open assignments', courseUrl(`/mod/assign/index.php?id=${C()}`))] });
  }
  const rows = [...doc.querySelectorAll('tr[data-mdl-overview-cmid]')].map((tr) => {
    const actions = tr.querySelector('td[data-mdl-overview-item="actions"]');
    return {
      cmid: tr.dataset.mdlOverviewCmid,
      name: tr.querySelector('td[data-mdl-overview-item="name"], th')?.textContent.trim().replace(/\s+/g, ' ') || 'Assignment',
      submitted: tr.querySelector('td[data-mdl-overview-item="submissions"]')?.textContent.trim().replace(/\s+/g, ' ') || '',
      due: tr.querySelector('td[data-mdl-overview-item="duedate"]')?.textContent.trim().replace(/\s+/g, ' ') || '',
      waiting: Number(actions?.dataset.mdlOverviewAlertcount || 0)
    };
  }).sort((a, b) => b.waiting - a.waiting);
  const total = rows.reduce((sum, r) => sum + r.waiting, 0);
  const list = rows.map((r) => {
    const a = el('a', { href: courseUrl(`/mod/assign/view.php?id=${r.cmid}&action=grading`) },
      el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: r.name }), el('span', { className: 'detail', textContent: [r.submitted && `${r.submitted} submitted`, r.due].filter(Boolean).join(', ') })),
      r.waiting ? el('span', { className: 'badge warn', textContent: `${r.waiting} to grade` }) : el('span', { className: 'detail', textContent: 'Done' }));
    a.addEventListener('click', (e) => { e.preventDefault(); app.navigate(a.href, e.metaKey || e.ctrlKey); });
    return a;
  });
  openSheet({
    view: 'course-grading',
    title: total ? `${total} ${total === 1 ? 'submission' : 'submissions'} to grade` : 'Grading queue',
    text: rows.length ? '' : 'No assignments in this course.',
    tall: true,
    body: rows.length ? [el('div', { className: 'card list' }, ...list)] : []
  });
}

async function manualInstance() {
  const fragment = await service(app.tab.id, app.ctx, 'core_get_fragment', {
    component: 'enrol_manual', callback: 'enrol_users_form', contextid: await courseContextId(), args: []
  });
  const doc = parse(fragment.html);
  const enrolid = doc.querySelector('input[name="enrolid"]')?.value;
  const roles = [...doc.querySelectorAll('select[name="roletoassign"] option')].map((o) => ({ id: o.value, name: o.textContent.trim(), selected: o.selected }));
  if (!enrolid) throw new Error('This course has no manual enrolment method.');
  return { enrolid, roles };
}

async function showEnrol() {
  openSheet({ view: 'course-enrol', title: 'Enrol or unenrol', tall: true, body: [loading()] });
  let instance;
  try {
    instance = await manualInstance();
  } catch (e) {
    return openSheet({ view: 'course-enrol', title: 'Enrol or unenrol', text: e.message, tall: true, actions: [link('Open enrolment methods', courseUrl(`/enrol/instances.php?id=${C()}`))] });
  }
  const role = el('select', { id: 'enrol-role', ariaLabel: 'Role' }, ...instance.roles.map((r) => el('option', { value: r.id, textContent: r.name, selected: r.selected || /student/i.test(r.name) })));
  const query = el('input', { type: 'search', id: 'enrol-query', placeholder: 'Find someone by name or email', ariaLabel: 'Find someone', autocomplete: 'off' });
  const results = el('div', { className: 'card list', id: 'enrol-results', hidden: true });
  let timer = 0;
  query.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const search = query.value.trim();
      if (search.length < 2) {
        results.hidden = true;
        return;
      }
      try {
        const [potential, enrolled] = await Promise.all([
          service(app.tab.id, app.ctx, 'core_enrol_get_potential_users', { courseid: C(), enrolid: Number(instance.enrolid), search, searchanywhere: true, page: 0, perpage: 15 }),
          service(app.tab.id, app.ctx, 'core_enrol_search_users', { courseid: C(), search, searchanywhere: true, page: 0, perpage: 15 })
        ]);
        const rows = [
          ...potential.map((u) => personRow(u, 'Enrol', () => enrol(u, role))),
          ...enrolled.map((u) => personRow(u, 'Unenrol', () => unenrol(u), true))
        ];
        results.hidden = false;
        results.replaceChildren(...(rows.length ? rows : [el('div', { className: 'empty-result', textContent: 'Nobody matches.' })]));
      } catch (e) {
        results.hidden = false;
        results.replaceChildren(el('div', { className: 'empty-result', textContent: e.message }));
      }
    }, 250);
  });
  openSheet({
    view: 'course-enrol',
    title: 'Enrol or unenrol',
    text: 'People already in the course show an Unenrol button.',
    tall: true,
    body: [el('label', { className: 'stack' }, el('span', { className: 'card-title', textContent: 'Enrol as' }), role), el('label', { className: 'search' }, query), results],
    focus: query
  });
}

function personRow(user, verb, run, enrolled = false) {
  const extra = user.email || '';
  const button = el('button', { className: 'link', textContent: verb });
  button.addEventListener('click', run);
  return el('div', { className: `person${enrolled ? ' enrolled' : ''}` },
    el('span', { className: 'tool-text' }, el('span', { className: 'label', textContent: user.fullname }), el('span', { className: 'detail', textContent: enrolled ? `In this course${extra ? `, ${extra}` : ''}` : extra })),
    button);
}

async function enrol(user, role) {
  if (!(await confirmAction(app.site.env, `Enrol ${user.fullname}?`))) return showEnrol();
  const q = new URLSearchParams({ id: String(C()), action: 'enrol', enrolid: (await manualInstance()).enrolid, userid: String(user.id), roletoassign: role.value, sesskey: app.ctx.sesskey });
  try {
    const res = await request(app.tab.id, courseUrl(`/enrol/manual/ajax.php?${q}`));
    const reply = JSON.parse(res.html);
    if (!reply.success) throw new Error(reply.error || 'Moodle did not enrol them.');
    status(`${user.fullname} is enrolled.`, 'ok');
  } catch (e) {
    status(e.message, 'bad');
  }
  showEnrol();
}

async function unenrol(user) {
  const ok = await confirmAction(app.site.env, `Unenrol ${user.fullname}?`, {
    always: true, text: 'Their grades and progress in this course stop showing. Enrolling them again can bring grades back.', yes: 'Unenrol'
  });
  if (!ok) return showEnrol();
  try {
    const { doc } = await fetchDoc(app.tab.id, courseUrl(`/user/index.php?id=${C()}&perpage=5000`));
    const row = doc.querySelector(`#user${user.id}`)?.closest('tr');
    const ueid = row?.querySelector('a[data-action="unenrol"]')?.getAttribute('rel');
    if (!ueid) throw new Error('Moodle offers no way for you to unenrol them here. They may be enrolled by another method.');
    const result = await service(app.tab.id, app.ctx, 'core_enrol_unenrol_user_enrolment', { ueid: Number(ueid) });
    if (!result.result) throw new Error((result.errors[0] || {}).message || 'Moodle did not unenrol them.');
    status(`${user.fullname} is unenrolled.`, 'ok');
  } catch (e) {
    status(e.message, 'bad');
  }
  showEnrol();
}

async function showCopy() {
  openSheet({ view: 'course-copy', title: 'Copy this course', tall: true, body: [loading()] });
  let form;
  try {
    form = await readForm(app.tab.id, courseUrl(`/backup/copy.php?id=${C()}`), 'form:has(input[name="_qf__core_backup_output_copy_form"])');
  } catch (e) {
    return openSheet({ view: 'course-copy', title: 'Copy this course', text: e.message, tall: true });
  }
  const f = form.fields;
  const fullname = el('input', { type: 'text', id: 'copy-fullname', value: f.fullname || '', ariaLabel: 'Full name' });
  const shortname = el('input', { type: 'text', id: 'copy-shortname', value: f.shortname || '', ariaLabel: 'Short name' });
  const start = new Date(Number(f['startdate[year]']), Number(f['startdate[month]']) - 1, Number(f['startdate[day]']), Number(f['startdate[hour]'] || 0), Number(f['startdate[minute]'] || 0));
  const startInput = el('input', { type: 'date', id: 'copy-start', value: localInputValue(start).slice(0, 10), ariaLabel: 'Start date' });
  const go = el('button', { className: 'primary', id: 'copy-go', textContent: 'Make the copy' });
  go.addEventListener('click', async () => {
    if (!(await confirmAction(app.site.env, `Copy to “${fullname.value}”?`))) return;
    const fields = { ...f, fullname: fullname.value.trim(), shortname: shortname.value.trim(), sesskey: app.ctx.sesskey };
    const [y, m, d] = startInput.value.split('-').map(Number);
    Object.assign(fields, dateFields('startdate', new Date(y, m - 1, d, start.getHours(), start.getMinutes())));
    for (const key of ['day', 'month', 'year', 'hour', 'minute']) fields[`enddate[${key}]`] ??= fields[`startdate[${key}]`];
    try {
      await service(app.tab.id, app.ctx, 'core_backup_submit_copy_form', { jsonformdata: JSON.stringify(new URLSearchParams(fields).toString()) });
      status('Copy started. It finishes the next time cron runs.', 'ok');
    } catch (e) {
      status(e.message, 'bad');
    }
  });
  openSheet({
    view: 'course-copy',
    title: 'Copy this course',
    text: 'Copies the content without users. Other options are on the full copy page.',
    tall: true,
    body: [el('div', { className: 'stack form' },
      el('label', { className: 'stack' }, el('span', { className: 'card-title', textContent: 'Full name' }), fullname),
      el('label', { className: 'stack' }, el('span', { className: 'card-title', textContent: 'Short name' }), shortname),
      el('label', { className: 'stack' }, el('span', { className: 'card-title', textContent: 'Starts' }), startInput))],
    actions: [go, link('Open the full copy page', courseUrl(`/backup/copy.php?id=${C()}`))]
  });
}

async function participants() {
  const all = [];
  for (let page = 0; page < 20; page++) {
    const batch = await service(app.tab.id, app.ctx, 'core_enrol_search_users', { courseid: C(), search: '', searchanywhere: true, page, perpage: 500 });
    all.push(...batch);
    if (batch.length < 500) break;
  }
  return all.filter((u) => u.id !== app.ctx.userId);
}

function showMessage() {
  const text = el('textarea', { id: 'message-text', rows: 6, maxLength: 4000, placeholder: 'Write to everyone in this course', ariaLabel: 'Message' });
  const send = el('button', { className: 'primary', id: 'message-send', textContent: 'Send' });
  send.addEventListener('click', async () => {
    if (!text.value.trim()) return status('Write something first.', 'bad');
    let people;
    try {
      people = await participants();
    } catch (e) {
      return status(e.message, 'bad');
    }
    const ok = await confirmAction(app.site.env, `Send to ${people.length} people?`, { always: true, text: 'Each person gets it as a private message from you.', yes: 'Send' });
    if (!ok) return showMessage();
    let failed = 0;
    for (let i = 0; i < people.length; i += 100) {
      const messages = people.slice(i, i + 100).map((u) => ({ touserid: u.id, text: text.value, textformat: 2 }));
      try {
        const sent = await service(app.tab.id, app.ctx, 'core_message_send_instant_messages', { messages });
        failed += sent.filter((m) => m.msgid === -1).length;
      } catch (e) {
        return status(e.message, 'bad');
      }
    }
    status(failed ? `Sent to ${people.length - failed}. ${failed} could not receive messages.` : `Sent to ${people.length} people.`, failed ? 'bad' : 'ok');
  });
  openSheet({ view: 'course-message', title: 'Message everyone', text: 'Sent as private messages. Plain text.', body: [text], actions: [send], focus: text });
}

export async function setupCourse(shared) {
  app = shared;
  const { ctx } = app;
  $('view-as').hidden = false;
  $('view-as').addEventListener('click', viewAs);
  const edit = $('editmode');
  edit.hidden = !ctx.contextId;
  edit.textContent = ctx.editing ? 'Turn editing off' : 'Turn editing on';
  edit.addEventListener('click', () => app.navigate(editModeUrl(ctx, !ctx.editing), false));

  const tools = [
    ['Outline', 'Hide, show, move, duplicate and delete', showOutline],
    ['Health check', 'Empty sections, hidden content, alt text, broken links', showHealth],
    ['Upcoming dates', 'Every date in this course, and add an event', showDates],
    ['Grading queue', 'What is waiting to be marked', showGrading],
    ['Enrol or unenrol', 'Add or remove someone without the participants page', showEnrol],
    ['Copy this course', 'New name and dates, without users', showCopy],
    ['Message everyone', 'A private message to every participant', showMessage]
  ];
  Object.assign(app.views, {
    'course-outline': showOutline, 'course-health': showHealth, 'course-dates': showDates, 'course-event': showAddEvent,
    'course-grading': showGrading, 'course-enrol': showEnrol, 'course-copy': showCopy, 'course-message': showMessage
  });
  $('course-tools').replaceChildren(...tools.map(([label, detail, run]) => toolRow(label, detail, run)));
  app.actions.push(() => [
    { group: 'Action', label: 'View as student', run: viewAs },
    { group: 'Action', label: ctx.editing ? 'Turn editing off' : 'Turn editing on', run: () => app.navigate(editModeUrl(ctx, !ctx.editing), false) },
    ...tools.map(([label, , run]) => ({ group: 'Action', label: label === 'Outline' ? 'Course outline' : label, run })),
    { group: 'Action', label: 'Add a course event', run: showAddEvent }
  ]);
}

