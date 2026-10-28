/* Practice log: the page. The data rules live in core.js and the GitHub calls in github.js. */
(function () {
  'use strict';

  const C = window.PLCore;
  const S = window.PLSync;

  const K = {
    doc: 'practicelog.doc',
    settings: 'practicelog.settings',
    token: 'practicelog.token',
    ui: 'practicelog.ui',
    sync: 'practicelog.sync',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch (e) { /* storage off */ } },
  };

  // ------------------------------------------------------------------ state

  const today = () => C.localDate();

  function loadDoc() {
    let raw = null;
    try { raw = localStorage.getItem(K.doc); } catch (e) { return C.emptyDoc(); }
    if (!raw) return C.emptyDoc();
    try {
      return C.validate(JSON.parse(raw));
    } catch (e) {
      // Keep the unreadable copy aside rather than lose it; GitHub still has the log.
      try { localStorage.setItem(K.doc + '.unreadable', raw); } catch (e2) { /* full */ }
      return C.emptyDoc();
    }
  }

  const state = {
    doc: loadDoc(),
    view: 'day',
    date: today(),
    followToday: true,
    ui: Object.assign({ sort: 'stale', theme: 'auto', countLessons: true }, store.get(K.ui, {})),
    settings: Object.assign({ owner: '', repo: '', branch: 'main', path: 'log.json' }, store.get(K.settings, {})),
    sync: Object.assign({ state: 'idle', message: '', at: null, dirty: false, notes: [], replace: false }, store.get(K.sync, {})),
    filter: '',
    exercise: null,       // selected in the Exercises view ('~categories' for the category list)
    adding: false,
    renaming: null,       // variation being renamed: {exercise, from}
    deletingCategory: null,
    startingOver: false,
    active: null,         // {date, lesson}: which section clicking a tile logs to
    historyLimit: 40,
    boardKey: '',
    boardOrder: [],
  };

  function saveDoc() {
    try {
      localStorage.setItem(K.doc, C.serialize(state.doc));
    } catch (e) {
      toast("Couldn't save on this computer (browser storage is full or off).");
    }
  }

  /** Make a change. `note` describes a big change for the commit message. */
  function commit(next, note) {
    if (next === state.doc) return;
    state.doc = next;
    saveDoc();
    state.sync.dirty = true;
    if (note) state.sync.notes.push(note);
    persistSync();
    scheduleSync();
    render();
  }

  /** Make a change that can be undone from the toast. */
  function commitUndoable(next, message, note) {
    const before = state.doc;
    if (next === before) return;
    commit(next, note);
    toast(message, 'Undo', () => commit(C.revert(state.doc, before), note ? `Undo: ${note}` : undefined));
  }

  const exMap = () => new Map(state.doc.exercises.map((e) => [e.id, e]));
  const nameOf = (map, id) => (map.get(id) || { name: '(deleted exercise)' }).name;
  const statsFor = (date) => C.exerciseStats(state.doc, date, { lessons: state.ui.countLessons });
  const varText = (list) => (list && list.length ? list.join(', ') : '');

  function catIndex() {
    const m = new Map();
    C.liveCategories(state.doc).forEach((c, i) => m.set(c.id, i));
    return m;
  }

  // ------------------------------------------------------------------ theme

  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };
  const theme = () => (state.ui.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : state.ui.theme);

  function applyTheme() {
    const root = document.documentElement;
    if (state.ui.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.ui.theme);
  }

  // ------------------------------------------------------------------ dates for people

  const asDate = (iso) => new Date(C.dayNumber(iso) * 86400000);
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'UTC' }, opts));
  const F = {
    long: fmt({ weekday: 'long', day: 'numeric', month: 'long' }),
    longYear: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    short: fmt({ day: 'numeric', month: 'short' }),
    shortYear: fmt({ day: 'numeric', month: 'short', year: 'numeric' }),
    weekday: fmt({ weekday: 'short' }),
  };
  const sameYear = (iso) => iso.slice(0, 4) === today().slice(0, 4);
  const longDate = (iso) => (sameYear(iso) ? F.long : F.longYear).format(asDate(iso));
  const shortDate = (iso) => (sameYear(iso) ? F.short : F.shortYear).format(asDate(iso));

  function relative(iso) {
    const d = C.daysBetween(iso, today());
    if (d === 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d > 1) return `${d} days ago`;
    return d === -1 ? 'Tomorrow' : `In ${-d} days`;
  }

  function ago(days) {
    if (days === null || days === undefined) return 'never';
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  const shortAgo = (days) => (days === null || days === undefined ? 'never' : days === 0 ? 'today' : `${days}d`);

  function clock(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return C.localDate(d) === today() ? time : `${shortDate(C.localDate(d))}, ${time}`;
  }

  // ------------------------------------------------------------------ routing

  const VIEWS = ['day', 'history', 'exercises', 'settings'];

  function route() {
    const [view, arg] = location.hash.replace(/^#/, '').split('/');
    state.view = VIEWS.includes(view) ? view : 'day';
    if (state.view === 'day') {
      const date = arg && C.isDate(arg) ? arg : today();
      state.date = date;
      state.followToday = date === today();
    }
    if (state.view === 'exercises' && arg) {
      const next = decodeURIComponent(arg);
      if (next !== state.exercise) { state.renaming = null; state.deletingCategory = null; }
      state.exercise = next;
    }
    render(true);
    window.scrollTo(0, 0);
  }

  function setDate(date) {
    const t = today();
    if (date > t) date = t;
    state.date = date;
    state.followToday = date === t;
    history.replaceState(null, '', date === t ? '#day' : `#day/${date}`);
    render();
  }

  function rollToday() {
    if (state.followToday && state.date !== today()) {
      state.date = today();
      if (state.view === 'day') render();
    }
  }

  // ------------------------------------------------------------------ rendering

  function render(entering = false) {
    applyTheme();
    for (const a of $$('.tabs a')) {
      if (a.dataset.view === state.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== state.view;
    if (state.view === 'day') renderDay();
    if (state.view === 'history') renderHistory();
    if (state.view === 'exercises') renderExercises();
    if (state.view === 'settings') {
      if (entering) renderSettings();
      else renderDataSummary();
    }
    renderSync();
  }

  // -- day view

  function entryItem(e, map) {
    const name = nameOf(map, e.exercise);
    return `<li><button type="button" class="entry" data-entry="${esc(e.id)}" title="Edit">` +
      `<b>${esc(name)}</b>${e.variations.length ? `<span class="var">${esc(varText(e.variations))}</span>` : ''}` +
      `${e.note ? `<span class="note">${esc(e.note)}</span>` : ''}</button>` +
      `<button type="button" class="entry-remove" data-remove="${esc(e.id)}" aria-label="Remove ${esc(name)}" title="Remove">×</button></li>`;
  }

  function renderDay() {
    const date = state.date;
    const t = today();
    const map = exMap();

    $('#day-title').textContent = longDate(date);
    $('#day-relative').textContent = relative(date);
    $('#next-day').disabled = date >= t;
    $('#go-today').hidden = date === t;
    const picker = $('#day-picker');
    picker.max = t;
    if (document.activeElement !== picker) picker.value = date;

    // What was done, in the order it was logged: own practice, then the lesson.
    const entries = C.entriesOn(state.doc, date);
    const lessonActive = activeLesson();
    for (const [key, lesson] of [['own', false], ['lesson', true]]) {
      const list = entries.filter((e) => !!e.lesson === lesson);
      const box = $(`#session-${key}`);
      const isActive = lessonActive === lesson;
      box.classList.toggle('active', isActive);
      box.classList.toggle('empty-session', !list.length);
      box.querySelector('.count').textContent = list.length ? String(list.length) : '';
      let empty;
      if (lesson) empty = isActive ? 'Pick what you did at the lesson from the exercises below.' : 'No lesson logged.';
      else empty = isActive ? (date === t ? 'Nothing yet. Pick an exercise below to log it.' : 'Nothing logged.') : 'Nothing logged.';
      box.querySelector('.session-body').innerHTML = list.length
        ? `<ol class="entries">${list.map((e) => entryItem(e, map)).join('')}</ol>`
        : `<p class="empty">${empty}</p>`;
    }
    for (const b of $$('.log-to button')) b.setAttribute('aria-checked', String((b.dataset.session === 'lesson') === lessonActive));

    const day = C.dayOf(state.doc, date);
    const current = day ? day.label : '';
    let labels = C.labelsByUse(state.doc).slice(0, 8);
    if (!labels.length) labels = ['rest', 'busy', 'tired', 'sick'];
    if (current && !labels.includes(current)) labels.unshift(current);
    const formOpen = !$('#label-form').hidden;
    $('#day-labels').innerHTML = labels.map((l) =>
      `<button type="button" class="chip" data-label="${esc(l)}" aria-pressed="${l === current}">${esc(l)}</button>`).join('') +
      `<button type="button" class="chip" id="label-other" aria-expanded="${formOpen}">Other…</button>`;

    const note = $('#day-note');
    if (document.activeElement !== note || note.dataset.date !== date) {
      note.value = day ? day.note : '';
      note.dataset.date = date;
    }
    renderBoard();
  }

  const tileEls = new Map();
  const sectionEls = new Map();

  function orderFor(list, stats) {
    const sorted = list.slice();
    if (state.ui.sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (state.ui.sort === 'order') sorted.sort(C.byOrder);
    else {
      const age = (e) => { const d = stats.get(e.id).daysSince; return d === null ? Infinity : d; };
      sorted.sort((a, b) => (age(b) - age(a)) || C.byOrder(a, b));
    }
    return sorted.map((e) => e.id);
  }

  function paintTile(el, ex, s, todays, th) {
    const done = todays.length > 0;
    const days = s.daysSince;
    const fill = C.staleColor(days, th);
    el.style.setProperty('--fill', fill);
    el.style.setProperty('--on-fill', C.textOn(fill));
    el.classList.toggle('done', done);
    el.querySelector('.tile-name').textContent = ex.name;
    let age;
    if (done) age = `<b>✓</b><span>${todays.length > 1 ? `${todays.length}×` : 'done'}</span>`;
    else if (days === null) age = '<b>never</b>';
    else age = `<b>${days}</b><span>${days === 1 ? 'day' : 'days'}</span>`;
    el.querySelector('.tile-age').innerHTML = age;
    const shown = done ? C.cleanTags(todays.flatMap((e) => e.variations)) : s.lastVariations;
    el.querySelector('.tile-var').textContent = varText(shown);
    el.querySelector('.tile-dots').innerHTML = ex.variations.slice(0, 8).map((v) => {
      const t = s.tags.get(v);
      const d = t ? t.daysSince : null;
      return `<i style="background:${C.staleColor(d, th)}" title="${esc(`${v}: ${ago(d)}`)}"></i>`;
    }).join('');
    const when = done ? 'logged on this day' : days === null ? 'never done' : `last done ${ago(days)}`;
    el.setAttribute('aria-label', `${ex.name}, ${when}${shown.length && !done ? `, last time ${varText(shown)}` : ''}. Log it.`);
  }

  function renderBoard() {
    const th = theme();
    const stats = statsFor(state.date);
    const todays = new Map();
    for (const e of C.entriesOn(state.doc, state.date)) {
      if (!todays.has(e.exercise)) todays.set(e.exercise, []);
      todays.get(e.exercise).push(e);
    }
    const cats = C.liveCategories(state.doc);
    const catIds = new Set(cats.map((c) => c.id));
    const active = C.liveExercises(state.doc).filter((e) => !e.archived);
    const catOf = (e) => (catIds.has(e.category) ? e.category : '__other');
    const sections = cats.map((c) => ({ id: c.id, name: c.name }));
    if (active.some((e) => !catIds.has(e.category))) sections.push({ id: '__other', name: 'Other' });

    const f = state.filter.trim().toLowerCase();
    const matches = (e) => !f || e.name.toLowerCase().includes(f) || e.variations.some((v) => v.toLowerCase().includes(f));
    const visible = active.filter(matches);

    $('#board-empty').hidden = active.length > 0;
    $('#board-head').hidden = active.length === 0;
    $('#legend').hidden = active.length === 0;
    $('#filter-empty').hidden = !(f && !visible.length);

    // The order is worked out when the day, sort or filter changes, not on every log,
    // so a tile you just logged stays put and fades instead of jumping away.
    const key = [state.date, state.ui.sort, state.ui.countLessons, f, visible.map((e) => e.id).join(',')].join('|');
    if (key !== state.boardKey) {
      state.boardKey = key;
      state.boardOrder = orderFor(visible, stats);
    }

    const host = $('#board-groups');
    const placed = new Map(sections.map((s) => [s.id, 0]));
    const keep = new Set();
    sections.forEach((sec, i) => {
      let box = sectionEls.get(sec.id);
      if (!box) {
        const el = document.createElement('section');
        el.className = 'group';
        el.innerHTML = '<h2></h2><div class="tiles"></div>';
        box = { el, h2: el.querySelector('h2'), tiles: el.querySelector('.tiles') };
        sectionEls.set(sec.id, box);
      }
      box.h2.textContent = sec.name;
      if (host.children[i] !== box.el) host.insertBefore(box.el, host.children[i] || null);
    });
    for (const [id, box] of sectionEls) if (!sections.some((s) => s.id === id)) { box.el.remove(); sectionEls.delete(id); }

    const map = exMap();
    for (const id of state.boardOrder) {
      const ex = map.get(id);
      if (!ex || ex.deleted || ex.archived) continue;
      const sec = catOf(ex);
      const box = sectionEls.get(sec);
      let el = tileEls.get(id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'tile';
        el.dataset.id = id;
        el.innerHTML = '<span class="tile-head"><span class="tile-name"></span><span class="tile-var"></span></span>' +
          '<span class="tile-foot"><span class="tile-age"></span><span class="tile-dots" aria-hidden="true"></span></span>';
        tileEls.set(id, el);
      }
      paintTile(el, ex, stats.get(id), todays.get(id) || [], th);
      const at = box.tiles.children[placed.get(sec)];
      if (at !== el) box.tiles.insertBefore(el, at || null);
      placed.set(sec, placed.get(sec) + 1);
      keep.add(id);
    }
    for (const [id, el] of tileEls) if (!keep.has(id)) el.remove();
    for (const sec of sections) sectionEls.get(sec.id).el.hidden = placed.get(sec.id) === 0;

    for (const b of $$('#board-head [data-sort]')) b.setAttribute('aria-checked', String(b.dataset.sort === state.ui.sort));
    renderLegend(th);
  }

  let legendTheme = null;
  function renderLegend(th) {
    if (legendTheme === th) return;
    legendTheme = th;
    const max = 120;
    const pos = (d) => Math.sqrt(d / max) * 100; // spreads out the first weeks, where most tiles are
    const samples = [];
    for (let i = 0; i <= 40; i++) {
      const p = i / 40;
      samples.push(`${C.staleColor(p * p * max, th)} ${(p * 100).toFixed(1)}%`);
    }
    const ticks = C.LEGEND_TICKS.map(([d, label], i, all) => {
      const last = i === all.length - 1;
      const style = last ? 'right:0;transform:none' : `left:${pos(d).toFixed(1)}%`;
      return `<span style="${style}">${esc(last ? label + '+' : label)}</span>`;
    }).join('');
    $('#legend').innerHTML = `<div class="bar-ramp" style="background:linear-gradient(90deg, ${samples.join(', ')})"></div>` +
      `<div class="ticks">${ticks}</div><figcaption>Colour shows how long ago you last did each exercise. The small squares are its variations.</figcaption>`;
  }

  // -- history

  function renderHistory() {
    const t = today();
    const map = exMap();
    const weeks = 26;
    const end = C.addDays(t, 6 - C.weekday(t)); // the Saturday of this week
    const start = C.addDays(end, -(weeks * 7 - 1));
    const per = new Map();
    for (const e of C.live(state.doc)) {
      if (e.date < start) continue;
      const o = per.get(e.date) || { ex: 0, names: [] };
      const ex = map.get(e.exercise);
      if (!ex || ex.category !== 'breathing') o.ex++;
      o.names.push(nameOf(map, e.exercise));
      per.set(e.date, o);
    }
    let practised = 0, span = 0;
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
      const date = C.addDays(start, i);
      if (date > t) { cells.push('<a data-level="future" tabindex="-1" aria-hidden="true"></a>'); continue; }
      span++;
      const o = per.get(date);
      const day = C.dayOf(state.doc, date);
      let level = '0', what = day && day.label ? day.label : 'nothing logged';
      if (o) {
        practised++;
        level = o.ex >= 3 ? '3' : o.ex === 2 ? '2' : '1';
        what = o.names.join(', ');
      } else if (day && day.label) level = 'rest';
      cells.push(`<a href="#day/${date}" data-level="${level}" tabindex="-1" title="${esc(`${F.weekday.format(asDate(date))} ${shortDate(date)}: ${what}`)}"></a>`);
    }

    const dates = C.activeDates(state.doc);
    const shown = dates.slice(0, state.historyLimit);
    const item = (e) => `<span>${esc(nameOf(map, e.exercise))}${e.variations.length ? ` <em>${esc(varText(e.variations))}</em>` : ''}</span>`;
    const rows = shown.map((date) => {
      const entries = C.entriesOn(state.doc, date);
      const own = entries.filter((e) => !e.lesson), lesson = entries.filter((e) => e.lesson);
      const day = C.dayOf(state.doc, date);
      return `<li><a href="#day/${date}"><time datetime="${date}"><b>${esc(F.weekday.format(asDate(date)))}</b> ${esc(shortDate(date))}</time>` +
        `<span class="what">${day && day.label ? `<span class="label">${esc(day.label)}</span>` : ''}${own.map(item).join('')}` +
        `${lesson.length ? `<span class="label lesson">lesson</span>${lesson.map(item).join('')}` : ''}` +
        `${day && day.note ? `<span class="note">${esc(day.note)}</span>` : ''}</span></a></li>`;
    }).join('');

    $('#history-body').innerHTML =
      `<div class="heat-wrap"><p>Practised on ${practised} of the last ${span} days.</p>` +
      `<div class="heat" aria-hidden="true">${cells.join('')}</div>` +
      `<div class="heat-key"><span><i style="background:var(--heat-1)"></i>1 exercise</span><span><i style="background:var(--heat-2)"></i>2</span>` +
      `<span><i style="background:var(--heat-3)"></i>3 or more</span><span><i style="background:var(--rest)"></i>marked day, no practice</span></div></div>` +
      (rows ? `<ol class="days">${rows}</ol>` : '<p class="empty">Nothing logged yet.</p>') +
      (dates.length > shown.length ? `<button type="button" class="quiet more" data-act="more">Show older days</button>` : '');
  }

  // -- exercises

  const CATS = '~categories';

  function renderExercises() {
    const t = today();
    const th = theme();
    const stats = statsFor(t);
    const all = C.liveExercises(state.doc).sort(C.byOrder);
    const map = exMap();
    if (state.exercise !== CATS && (!state.exercise || !map.has(state.exercise) || map.get(state.exercise).deleted)) {
      const first = all.find((e) => !e.archived) || all[0];
      state.exercise = first ? first.id : null;
    }
    const cats = C.liveCategories(state.doc);
    const catIds = new Set(cats.map((c) => c.id));
    const groups = cats.map((c) => [c.name, all.filter((e) => !e.archived && e.category === c.id)]);
    groups.push(['Other', all.filter((e) => !e.archived && !catIds.has(e.category))]);
    groups.push(['Archived', all.filter((e) => e.archived)]);
    const item = (e) => {
      const s = stats.get(e.id);
      return `<li><a href="#exercises/${encodeURIComponent(e.id)}" aria-current="${e.id === state.exercise}">` +
        `<span class="sw" style="background:${C.staleColor(s.daysSince, th)}"></span>${esc(e.name)}<span class="d">${shortAgo(s.daysSince)}</span></a></li>`;
    };
    const catOptions = cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#ex-list').innerHTML =
      `<div class="ex-list-tools">` +
      (state.adding ? '' : `<button type="button" class="quiet" data-act="add-open">Add an exercise</button>`) +
      `<a class="button quiet" href="#exercises/${CATS}" aria-current="${state.exercise === CATS}">Categories</a></div>` +
      (state.adding
        ? `<form class="ex-add" data-form="add"><label><span>New exercise</span><input name="name" required autocomplete="off" placeholder="Name"></label>` +
          `<div class="ex-add-row">${cats.length ? `<select name="category" aria-label="Category">${catOptions}</select>` : ''}` +
          `<button class="primary">Add</button><button type="button" class="quiet" data-act="add-cancel">Cancel</button></div></form>`
        : '') +
      groups.filter(([, list]) => list.length).map(([title, list]) => `<h2>${esc(title)}</h2><ul>${list.map(item).join('')}</ul>`).join('');

    if (state.exercise === CATS) $('#ex-detail').innerHTML = categoriesPanel();
    else {
      const ex = map.get(state.exercise);
      $('#ex-detail').innerHTML = ex ? exerciseDetail(ex, stats.get(ex.id), th) : '<p class="empty">No exercises yet. Add one, or load your log in Settings.</p>';
    }
    if (state.adding) { const input = $('#ex-list input[name="name"]'); if (input && document.activeElement !== input) input.focus(); }
    const rename = $('#ex-detail form[data-form="rename-var"] input');
    if (rename && document.activeElement !== rename) { rename.focus(); rename.select(); }
  }

  function variationTable(ex, s, th) {
    const r = state.renaming && state.renaming.exercise === ex.id ? state.renaming.from : null;
    const nameCell = (v, label) => (r === v
      ? `<form class="inline-form" data-form="rename-var" data-from="${esc(v)}"><input name="to" value="${esc(v)}" aria-label="New name" autocomplete="off"><button class="primary">Save</button><button type="button" class="quiet" data-act="rename-cancel">Cancel</button></form>`
      : label);
    const row = (v, o, acts, label) =>
      `<tr><td class="vname"><span><span class="sw" style="background:${C.staleColor(o ? o.daysSince : null, th)}"></span>${nameCell(v, label || esc(v))}</span></td>` +
      `<td class="num">${o ? o.count : 0}</td><td>${o && o.last ? esc(shortDate(o.last)) : 'never'}</td><td class="acts">${r === v ? '' : acts}</td></tr>`;
    const btn = (act, v, text, extra = '') => `<button type="button" class="quiet small" data-act="${act}" data-var="${esc(v)}"${extra}>${text}</button>`;
    const declared = ex.variations.map((v, i) =>
      row(v, s.tags.get(v),
        btn('var-up', v, '↑', ` aria-label="Move ${esc(v)} up"${i === 0 ? ' disabled' : ''}`) +
        btn('var-down', v, '↓', ` aria-label="Move ${esc(v)} down"${i === ex.variations.length - 1 ? ' disabled' : ''}`) +
        btn('var-rename', v, 'Rename') + btn('var-remove', v, 'Take off the list'))).join('');
    const others = [...s.tags.entries()].filter(([v]) => !ex.variations.includes(v))
      .sort((a, b) => (a[1].last < b[1].last ? 1 : -1));
    const otherRows = others.map(([v, o]) => row(v, o, btn('var-declare', v, 'Add to the list') + btn('var-rename', v, 'Rename'))).join('');
    const plain = s.plain.count && (ex.variations.length || others.length)
      ? row('', s.plain, btn('var-rename', '', 'Name them'), '<em>no variation</em>') : '';
    return `<table class="vars-table"><thead><tr><th>Variation</th><th class="num">Times</th><th>Last</th><th></th></tr></thead><tbody>` +
      (declared || '<tr><td colspan="4" class="empty">None on the list yet.</td></tr>') +
      (otherRows || plain ? `<tr class="subhead"><th colspan="4">Also logged</th></tr>${plain}${otherRows}` : '') +
      `</tbody></table>` +
      `<form class="inline-form add-var" data-form="add-var"><input name="name" placeholder="New variation" aria-label="New variation" autocomplete="off" required><button class="quiet">Add to the list</button></form>` +
      `<p class="hint">The list is what you rotate through: each one gets a square on the tile and a chip when you log. Renaming changes every entry that used it; renaming to a name that's already there merges the two.</p>`;
  }

  function exerciseDetail(ex, s, th) {
    const recent = C.entriesOf(state.doc, ex.id).reverse().slice(0, 20);
    const prog = C.progress(state.doc, ex.id);
    const cats = C.liveCategories(state.doc);
    const others = C.liveExercises(state.doc).filter((x) => x.id !== ex.id).sort((a, b) => a.name.localeCompare(b.name));
    const facts =
      `<dl class="facts">` +
      `<div><dt>Last done</dt><dd>${s.last ? esc(shortDate(s.last)) : 'Never'} <small>${s.last ? esc(ago(s.daysSince)) : ''}</small></dd></div>` +
      `<div><dt>Times done</dt><dd>${s.count} <small>${s.recent} in the last 90 days</small></dd></div>` +
      `<div><dt>Usual gap</dt><dd>${s.typicalGap ? `${s.typicalGap} <small>${s.typicalGap === 1 ? 'day' : 'days'}</small>` : '<small>not enough yet</small>'}</dd></div>` +
      `</dl>`;
    const history = recent.length
      ? `<table><thead><tr><th>Date</th><th>Variations</th><th>Note</th></tr></thead><tbody>` +
        recent.map((e) => `<tr class="clickable" data-entry="${esc(e.id)}" tabindex="0"><td>${esc(F.weekday.format(asDate(e.date)))} ${esc(shortDate(e.date))}${e.lesson ? ' <span class="label lesson">lesson</span>' : ''}</td><td>${esc(varText(e.variations))}</td><td>${esc(e.note)}</td></tr>`).join('') +
        `</tbody></table>`
      : '<p class="empty">Not done yet.</p>';
    const n = C.entriesOf(state.doc, ex.id).length;
    const combine = others.length
      ? `<section class="ex-section"><h2>Make it a variation of another exercise</h2>` +
        `<form class="combine" data-form="combine"><label><span>Exercise</span><select name="into">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label>` +
        `<label><span>As the variation</span><input name="as" value="${esc(ex.name)}" autocomplete="off"></label><button class="quiet">Combine</button></form>` +
        `<p class="hint">${n ? `Its ${n} ${n === 1 ? 'entry moves' : 'entries move'} to that exercise, marked with this variation, and` : 'It'} ${esc(ex.name)} leaves the list. You can undo it straight after.</p></section>`
      : '';
    return `<div class="ex-head"><span class="swatch" style="background:${C.staleColor(s.daysSince, th)}"></span><h1>${esc(ex.name)}</h1>` +
      `<button type="button" class="primary" data-act="log-today">Log it today</button></div>` +
      facts +
      (prog ? `<section class="ex-section"><h2>${prog.kind === 'pitch' ? 'Notes in your variations' : 'Seconds in your variations'}</h2>${chart(prog)}</section>` : '') +
      `<section class="ex-section"><h2>Variations</h2>${variationTable(ex, s, th)}</section>` +
      `<section class="ex-section"><h2>Recent</h2>${history}</section>` +
      `<section class="ex-section"><h2>Change this exercise</h2><div class="ex-tools">` +
      `<form class="rename" data-form="rename"><input name="name" value="${esc(ex.name)}" aria-label="Name" required autocomplete="off"><button class="quiet">Rename</button></form>` +
      (cats.length ? `<select data-act="category" aria-label="Category">${cats.map((c) => `<option value="${esc(c.id)}"${c.id === ex.category ? ' selected' : ''}>In ${esc(c.name)}</option>`).join('')}</select>` : '') +
      (ex.archived ? '' : `<button type="button" class="quiet" data-act="up" title="Earlier in “Your order”">Move up</button><button type="button" class="quiet" data-act="down" title="Later in “Your order”">Move down</button>`) +
      `<button type="button" class="quiet" data-act="archive">${ex.archived ? 'Put back on the board' : 'Archive'}</button>` +
      (n ? '' : `<button type="button" class="danger" data-act="delete-ex">Delete</button>`) +
      `</div><p class="hint">Archived exercises leave the board but keep their history.${n ? ' Exercises with history can be archived or combined, not deleted.' : ''}</p></section>` +
      combine;
  }

  function categoriesPanel() {
    const cats = C.liveCategories(state.doc);
    const count = (id) => C.liveExercises(state.doc).filter((e) => e.category === id).length;
    const rows = cats.map((c, i) => {
      const n = count(c.id);
      const deleting = state.deletingCategory === c.id;
      const moveTo = cats.filter((o) => o.id !== c.id);
      return `<tr><td><form class="inline-form" data-form="rename-cat" data-id="${esc(c.id)}"><input name="name" value="${esc(c.name)}" aria-label="Category name" required autocomplete="off"><button class="quiet">Rename</button></form></td>` +
        `<td class="num">${n}</td><td class="acts">` +
        `<button type="button" class="quiet small" data-act="cat-up" data-id="${esc(c.id)}" aria-label="Move ${esc(c.name)} up"${i === 0 ? ' disabled' : ''}>↑</button>` +
        `<button type="button" class="quiet small" data-act="cat-down" data-id="${esc(c.id)}" aria-label="Move ${esc(c.name)} down"${i === cats.length - 1 ? ' disabled' : ''}>↓</button>` +
        (deleting
          ? (n && moveTo.length
            ? `<span class="confirm">Move its ${n} to <select data-role="move-to">${moveTo.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select> and <button type="button" class="danger small" data-act="cat-delete-yes" data-id="${esc(c.id)}">Delete</button></span>`
            : n ? '<span class="confirm">Add another category first to move its exercises to.</span>'
              : `<button type="button" class="danger small" data-act="cat-delete-yes" data-id="${esc(c.id)}">Delete it</button>`) +
            `<button type="button" class="quiet small" data-act="cat-delete-no">Cancel</button>`
          : `<button type="button" class="quiet small" data-act="cat-delete" data-id="${esc(c.id)}">Delete</button>`) +
        `</td></tr>`;
    }).join('');
    return `<div class="ex-head"><h1>Categories</h1></div>` +
      `<p class="hint">Each category is a section on the board, in this order. Move exercises between them from each exercise's page.</p>` +
      `<table class="cats-table"><thead><tr><th>Name</th><th class="num">Exercises</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">No categories yet.</td></tr>'}</tbody></table>` +
      `<form class="inline-form" data-form="add-cat"><input name="name" placeholder="New category, e.g. Scales" aria-label="New category" required autocomplete="off"><button class="quiet">Add category</button></form>`;
  }

  function chart(prog) {
    const W = 760, H = 220, L = 52, R = 18, T = 14, B = 30;
    const pts = prog.points;
    const xs = pts.map((p) => C.dayNumber(p.date));
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x1 === x0) { x0 -= 1; x1 += 1; }
    const vals = pts.map((p) => p.value);
    const step = prog.kind === 'pitch' ? 1 : 5;
    const y0 = Math.floor(Math.min(...vals) / step) * step - step;
    const y1 = Math.ceil(Math.max(...vals) / step) * step + step;
    let every = step;
    while ((y1 - y0) / every > 7) every += step;
    const X = (d) => L + ((d - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const label = (v) => (prog.kind === 'pitch' ? C.pitchName(v) : `${v}s`);
    let grid = '';
    for (let v = Math.ceil(y0 / every) * every; v <= y1; v += every) {
      grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>` +
        `<text class="axis" x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(label(v))}</text>`;
    }
    const first = pts[0].date, last = pts[pts.length - 1].date;
    grid += `<text class="axis" x="${L}" y="${H - 8}">${esc(shortDate(first))}</text>` +
      `<text class="axis" x="${W - R}" y="${H - 8}" text-anchor="end">${esc(shortDate(last))}</text>`;
    const line = pts.map((p) => `${X(C.dayNumber(p.date)).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
    const dots = pts.map((p) => `<circle class="dot" cx="${X(C.dayNumber(p.date)).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="4"><title>${esc(`${shortDate(p.date)}: ${p.variation}`)}</title></circle>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${pts.length} logged values from ${shortDate(first)} to ${shortDate(last)}`)}">${grid}<polyline class="trend" points="${line}"/>${dots}</svg>`;
  }

  // -- settings

  function renderSettings() {
    const s = state.settings;
    $('#settings-body').innerHTML = `<div class="settings">
      <section class="panel" aria-labelledby="sync-h">
        <h2 id="sync-h">Sync with GitHub</h2>
        <p>The log is always saved on this computer. Connect a private GitHub repo to keep a copy there as well: each change becomes a commit, so you get a backup and the full history.</p>
        <form id="sync-form" class="form-grid" autocomplete="off">
          <label><span>GitHub username</span><input name="owner" value="${esc(s.owner)}" spellcheck="false"></label>
          <label><span>Repository</span><input name="repo" value="${esc(s.repo)}" placeholder="tracking-data" spellcheck="false"></label>
          <label><span>Branch</span><input name="branch" value="${esc(s.branch)}" spellcheck="false"></label>
          <label><span>File</span><input name="path" value="${esc(s.path)}" spellcheck="false"></label>
          <label class="wide"><span>Token</span><span class="token-row"><input name="token" type="password" value="${esc(token())}" spellcheck="false" placeholder="github_pat_…"><button type="button" class="quiet" data-act="show-token">Show</button></span></label>
          <div class="wide row">
            <button class="primary">Save and sync</button>
            <button type="button" class="quiet" data-act="sync-now">Sync now</button>
            <button type="button" class="danger" data-act="disconnect">Disconnect</button>
          </div>
        </form>
        <p class="status-line" id="sync-line"></p>
        <details>
          <summary>How to set up the repo and token</summary>
          <ol>
            <li>On GitHub, create a <b>private</b> repository for the data, for example <code>tracking-data</code>. Tick “Add a README” so it isn’t empty.</li>
            <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Settings → Developer settings → Fine-grained tokens → Generate new token</a>.</li>
            <li>Under Repository access choose “Only select repositories” and pick the data repo.</li>
            <li>Under Permissions → Repository permissions, set Contents to “Read and write”.</li>
            <li>Pick an expiry (up to a year). When it runs out, sync stops and says so; make a new token and paste it here.</li>
            <li>Paste the token above and press Save and sync. It stays in this browser on this computer.</li>
          </ol>
        </details>
      </section>
      <section class="panel" aria-labelledby="board-h">
        <h2 id="board-h">Board</h2>
        <label class="check"><input type="checkbox" name="countLessons"${state.ui.countLessons ? ' checked' : ''}> Count exercises done at a lesson</label>
        <p>When this is off, the colours and days only count your own practice, so an exercise you did at a lesson still shows as due.</p>
      </section>
      <section class="panel" aria-labelledby="data-h">
        <h2 id="data-h">Your data</h2>
        <p id="data-summary"></p>
        <div class="row">
          <label class="button">Load a log file…<input type="file" id="load-file" accept=".json,application/json" hidden></label>
          <button type="button" class="quiet" data-act="export">Download a copy</button>
          <button type="button" class="danger" data-act="start-over">Start over from a file…</button>
        </div>
        <p>Loading a file adds what's in it to the log here. Nothing already here is removed or overwritten by older copies.</p>
        <div class="warning" id="start-over"${state.startingOver ? '' : ' hidden'}>
          <p><b>Starting over replaces everything</b> here${connected() ? ' and in the file on GitHub' : ''} with the file you pick. Use it to bring in a corrected import. Anything not in that file is removed, including entries logged here since. GitHub keeps the old version in the repo's history, and you can download a copy first.</p>
          <div class="row">
            <label class="button danger">Choose the file<input type="file" id="start-over-file" accept=".json,application/json" hidden></label>
            <button type="button" class="quiet" data-act="start-over-cancel">Cancel</button>
          </div>
        </div>
      </section>
      <section class="panel" aria-labelledby="look-h">
        <h2 id="look-h">Appearance</h2>
        <div class="radio-row" role="radiogroup" aria-labelledby="look-h">
          ${['auto', 'light', 'dark'].map((v) => `<label><input type="radio" name="theme" value="${v}"${state.ui.theme === v ? ' checked' : ''}> ${v === 'auto' ? 'Match the system' : v === 'light' ? 'Light' : 'Dark'}</label>`).join('')}
        </div>
      </section>
    </div>`;
    renderDataSummary();
  }

  function renderDataSummary() {
    const el = $('#data-summary');
    if (!el) return;
    const entries = C.live(state.doc);
    const days = new Set(entries.map((e) => e.date)).size;
    const active = C.liveExercises(state.doc).filter((e) => !e.archived).length;
    el.textContent = entries.length
      ? `This computer has ${entries.length.toLocaleString('en')} entries over ${days.toLocaleString('en')} days, and ${active} exercises on the board.`
      : 'Nothing on this computer yet.';
  }

  // ------------------------------------------------------------------ sync

  let syncing = false, syncAgain = false, syncTimer = null, retryTimer = null, lastPull = 0;

  const token = () => store.get(K.token, '') || '';
  const connected = () => !!(state.settings.owner && state.settings.repo && token());
  const persistSync = () => store.set(K.sync, {
    at: state.sync.at, dirty: !!state.sync.dirty, notes: state.sync.notes, replace: !!state.sync.replace,
  });

  function client() {
    const s = state.settings;
    return S.makeClient({
      owner: s.owner.trim(), repo: s.repo.trim(),
      branch: (s.branch || 'main').trim(), path: (s.path || 'log.json').trim(),
      token: token(),
    });
  }

  function setSync(st, message) {
    state.sync.state = st;
    if (message !== undefined) state.sync.message = message;
    renderSync();
  }

  function scheduleSync(delay = 1500) {
    if (!connected()) { renderSync(); return; }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, delay);
    if (!syncing) setSync('pending');
  }

  async function runSync() {
    clearTimeout(syncTimer);
    clearTimeout(retryTimer);
    if (!connected()) { renderSync(); return; }
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setSync('saving');
    const notes = state.sync.notes.slice();
    const replace = !!state.sync.replace;
    try {
      const r = await S.sync(client(), state.doc, {
        replace,
        message: (before, after) => {
          if (!notes.length) return null;
          // Big changes say what they were; anything logged alongside is listed after.
          const known = new Set(before.entries.map((e) => e.id));
          const added = after.entries.filter((e) => !known.has(e.id) && !e.deleted);
          const names = new Map(after.exercises.map((x) => [x.id, x.name]));
          const list = added.slice(0, 4).map((e) => names.get(e.exercise) || e.exercise).join(', ');
          return notes.join('; ') + (added.length ? `; log ${list}${added.length > 4 ? ` +${added.length - 4} more` : ''}` : '');
        },
      });
      const merged = C.merge(state.doc, r.doc); // keeps anything logged while the request was out
      const changed = !C.sameDoc(merged, state.doc);
      if (changed) { state.doc = merged; saveDoc(); }
      state.sync.dirty = !C.sameDoc(merged, r.doc);
      state.sync.at = Date.now();
      if (r.pushed) state.sync.notes = state.sync.notes.slice(notes.length);
      if (replace) state.sync.replace = false;
      persistSync();
      lastPull = Date.now();
      setSync('ok', r.pushed ? 'Saved to GitHub.' : 'Up to date with GitHub.');
      if (state.sync.dirty) syncAgain = true;
      if (changed) render();
    } catch (e) {
      const kind = e && e.kind;
      setSync(kind === 'offline' ? 'offline' : 'error', (e && e.message) || String(e));
      if (['offline', 'ratelimit', 'conflict', 'http'].includes(kind)) {
        retryTimer = setTimeout(runSync, kind === 'ratelimit' ? 5 * 60000 : 60000);
      }
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
  }

  function renderSync() {
    const st = connected() ? state.sync.state : 'off';
    const button = $('#sync-status');
    button.dataset.state = st;
    const short = {
      off: 'Not syncing',
      idle: state.sync.dirty ? 'Not saved yet' : 'Sync',
      pending: 'Saving…',
      saving: 'Saving…',
      ok: state.sync.at ? `Synced ${clock(state.sync.at)}` : 'Synced',
      offline: 'Offline, saved here',
      error: 'Sync problem',
    }[st];
    $('.sync-text', button).textContent = short;
    button.title = st === 'off' ? 'Set up sync in Settings' : state.sync.message || short;
    const line = $('#sync-line');
    if (line) {
      line.dataset.kind = st === 'error' ? 'error' : '';
      line.textContent = {
        off: 'Not connected. The log is saved on this computer only.',
        idle: state.sync.dirty ? 'Changes waiting to be saved to GitHub.' : 'Connected.',
        pending: 'Saving to GitHub…',
        saving: 'Talking to GitHub…',
        ok: `${state.sync.message} Last synced ${state.sync.at ? clock(state.sync.at) : ''}.`,
        offline: state.sync.message,
        error: state.sync.message,
      }[st];
    }
  }

  // ------------------------------------------------------------------ the log dialog

  const dialog = $('#entry-dialog');
  let ctx = null; // {mode, exercise, date, entryId?, selected: Set, plain, lesson}

  /** Where a new entry goes for a date: what you picked last for that day, otherwise
   *  where the last entry of the day went, otherwise your own practice. */
  function defaultLesson(date) {
    if (state.active && state.active.date === date) return state.active.lesson;
    const es = C.entriesOn(state.doc, date);
    return es.length ? !!es[es.length - 1].lesson : false;
  }
  const activeLesson = () => defaultLesson(state.date);

  function setActive(lesson) {
    state.active = { date: state.date, lesson };
    renderDay();
  }

  function renderChips() {
    const ex = exMap().get(ctx.exercise);
    const asOf = ctx.mode === 'add' ? ctx.date : today();
    const s = statsFor(asOf).get(ctx.exercise);
    const th = theme();
    let choices = ex && s ? C.variationChoices(ex, s) : [];
    const declared = choices.filter((c) => c.declared || c.plain);
    const others = choices.filter((c) => !c.declared && !c.plain).slice(0, Math.max(0, 14 - declared.length));
    choices = [...declared, ...others];
    for (const v of ctx.selected) if (!choices.some((c) => c.name === v)) choices.push({ name: v, declared: false, daysSince: null, count: 0, extra: true });
    $('#ed-chips').innerHTML = choices.map((c) => {
      const pressed = c.plain ? ctx.plain : ctx.selected.has(c.name);
      const days = c.extra ? '' : `<small>${shortAgo(c.daysSince)}</small>`;
      return `<button type="button" class="chip var${c.declared ? ' declared' : ''}" data-var="${esc(c.name)}"${c.plain ? ' data-plain="1"' : ''} aria-pressed="${pressed}"` +
        ` title="${esc(c.plain ? 'No variation' : c.name)}: ${esc(ago(c.daysSince))}${c.count ? `, ${c.count}×` : ''}">` +
        `${c.extra ? '' : `<i class="sw" style="background:${C.staleColor(c.daysSince, th)}"></i>`}${esc(c.plain ? 'plain' : c.name)}${days}</button>`;
    }).join('');
    $('#ed-chips').hidden = !choices.length;
  }

  function renderSession() {
    for (const b of $$('.ed-session button')) b.setAttribute('aria-checked', String((b.dataset.session === 'lesson') === ctx.lesson));
  }

  function openLog(exId, date = state.date) {
    const ex = exMap().get(exId);
    if (!ex) return;
    ctx = { mode: 'add', exercise: exId, date, selected: new Set(), plain: false, lesson: defaultLesson(date) };
    const s = statsFor(date).get(exId);
    $('#ed-title').textContent = ex.name;
    const when = date === today() ? '' : ` Logging for ${longDate(date)}.`;
    $('#ed-sub').textContent = (s.last ? `Last done ${ago(s.daysSince)}, ${s.count} ${s.count === 1 ? 'time' : 'times'} in all.` : 'Not done before.') + when;
    $('#ed-where').hidden = true;
    $('#ed-delete').hidden = true;
    $('#ed-ok').textContent = 'Log it';
    $('#ed-variation').value = '';
    $('#ed-note').value = '';
    renderChips();
    renderSession();
    dialog.showModal();
    const first = $('#ed-chips .chip');
    (first || $('#ed-variation')).focus();
  }

  function openEdit(entryId) {
    const entry = state.doc.entries.find((e) => e.id === entryId);
    if (!entry) return;
    ctx = { mode: 'edit', entryId, exercise: entry.exercise, date: entry.date, selected: new Set(entry.variations), plain: !entry.variations.length, lesson: !!entry.lesson };
    const map = exMap();
    $('#ed-title').textContent = nameOf(map, entry.exercise);
    $('#ed-sub').textContent = `Logged on ${longDate(entry.date)}.`;
    const options = C.liveExercises(state.doc).sort((a, b) => a.name.localeCompare(b.name))
      .filter((e) => !e.archived || e.id === entry.exercise);
    $('#ed-exercise').innerHTML = options.map((e) => `<option value="${esc(e.id)}"${e.id === entry.exercise ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
    $('#ed-date').value = entry.date;
    $('#ed-date').max = today();
    $('#ed-where').hidden = false;
    $('#ed-delete').hidden = false;
    $('#ed-ok').textContent = 'Save changes';
    $('#ed-variation').value = '';
    $('#ed-note').value = entry.note || '';
    renderChips();
    renderSession();
    dialog.showModal();
    $('#ed-note').focus();
  }

  $('#entry-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!ctx) return;
    const typed = $('#ed-variation').value.trim();
    const variations = [...ctx.selected, ...(typed ? [typed] : [])];
    const note = $('#ed-note').value;
    const map = exMap();
    if (ctx.mode === 'add') {
      const { doc, entry } = C.addEntry(state.doc, { date: ctx.date, exercise: ctx.exercise, variations, note, lesson: ctx.lesson });
      state.active = { date: ctx.date, lesson: ctx.lesson };
      dialog.close();
      commit(doc);
      toast(`Logged ${nameOf(map, entry.exercise)}${entry.variations.length ? ` (${varText(entry.variations)})` : ''}${entry.lesson ? ' at the lesson' : ''}`,
        'Undo', () => commit(C.deleteEntry(state.doc, entry.id)));
    } else {
      const date = $('#ed-date').value;
      if (!C.isDate(date) || date > today()) { $('#ed-date').focus(); return; }
      dialog.close();
      commit(C.editEntry(state.doc, ctx.entryId, { exercise: $('#ed-exercise').value, date, variations, note, lesson: ctx.lesson }));
      toast('Saved changes');
    }
    ctx = null;
  });

  $('#ed-cancel').addEventListener('click', () => dialog.close());
  $('#ed-delete').addEventListener('click', () => {
    if (!ctx || ctx.mode !== 'edit') return;
    const id = ctx.entryId;
    dialog.close();
    removeEntry(id);
  });
  $('#ed-chips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip || !ctx) return;
    if (chip.dataset.plain) {
      ctx.plain = !ctx.plain;
      if (ctx.plain) ctx.selected.clear();
    } else {
      const v = chip.dataset.var;
      if (ctx.selected.has(v)) ctx.selected.delete(v); else ctx.selected.add(v);
      ctx.plain = false;
    }
    for (const c of $$('#ed-chips .chip')) {
      c.setAttribute('aria-pressed', String(c.dataset.plain ? ctx.plain : ctx.selected.has(c.dataset.var)));
    }
  });
  $('#ed-variation').addEventListener('input', () => {
    if (ctx && ctx.plain && $('#ed-variation').value.trim()) { ctx.plain = false; const p = $('#ed-chips [data-plain]'); if (p) p.setAttribute('aria-pressed', 'false'); }
  });
  $('.ed-session').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-session]');
    if (!b || !ctx) return;
    ctx.lesson = b.dataset.session === 'lesson';
    renderSession();
  });
  $('#ed-exercise').addEventListener('change', (ev) => {
    ctx.exercise = ev.target.value;
    $('#ed-title').textContent = nameOf(exMap(), ev.target.value);
    renderChips();
  });

  function removeEntry(id) {
    const entry = state.doc.entries.find((e) => e.id === id);
    if (!entry) return;
    const name = nameOf(exMap(), entry.exercise);
    commit(C.deleteEntry(state.doc, id));
    toast(`Removed ${name}`, 'Undo', () => commit(C.restoreEntry(state.doc, id)));
  }

  // ------------------------------------------------------------------ toast

  let toastTimer = null;
  function toast(text, actionLabel, action) {
    const el = $('#toast');
    $('#toast-text').textContent = text;
    const btn = $('#toast-action');
    btn.hidden = !action;
    btn.textContent = actionLabel || '';
    btn.onclick = action ? () => { hideToast(); action(); } : null;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 8000 : 3500);
  }
  function hideToast() { $('#toast').hidden = true; }

  // ------------------------------------------------------------------ events: day view

  $('#prev-day').addEventListener('click', () => setDate(C.addDays(state.date, -1)));
  $('#next-day').addEventListener('click', () => setDate(C.addDays(state.date, 1)));
  $('#go-today').addEventListener('click', () => setDate(today()));
  $('#day-picker').addEventListener('change', (ev) => { if (C.isDate(ev.target.value)) setDate(ev.target.value); });
  $('#pick-date').addEventListener('click', () => {
    const picker = $('#day-picker');
    try { picker.showPicker(); } catch (e) { $('.date-pick').classList.add('no-picker'); picker.focus(); }
  });
  if (!('showPicker' in HTMLInputElement.prototype)) $('.date-pick').classList.add('no-picker');

  $('.done-grid').addEventListener('click', (ev) => {
    const remove = ev.target.closest('[data-remove]');
    if (remove) return removeEntry(remove.dataset.remove);
    const entry = ev.target.closest('[data-entry]');
    if (entry) return openEdit(entry.dataset.entry);
    const session = ev.target.closest('.session');
    if (session) setActive(session.dataset.session === 'lesson');
  });
  $('.log-to').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-session]');
    if (b) setActive(b.dataset.session === 'lesson');
  });

  $('#day-labels').addEventListener('click', (ev) => {
    if (ev.target.closest('#label-other')) {
      const form = $('#label-form');
      form.hidden = !form.hidden;
      ev.target.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) $('#label-input').focus();
      return;
    }
    const chip = ev.target.closest('[data-label]');
    if (!chip) return;
    const day = C.dayOf(state.doc, state.date);
    const label = day && day.label === chip.dataset.label ? '' : chip.dataset.label;
    commit(C.setDay(state.doc, state.date, { label }));
  });

  $('#label-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const label = $('#label-input').value.trim();
    if (!label) return;
    $('#label-input').value = '';
    $('#label-form').hidden = true;
    commit(C.setDay(state.doc, state.date, { label }));
  });

  let noteTimer = null;
  function saveNote() {
    clearTimeout(noteTimer);
    const note = $('#day-note');
    const date = note.dataset.date;
    if (!date) return;
    const day = C.dayOf(state.doc, date);
    if ((day ? day.note : '') !== note.value) commit(C.setDay(state.doc, date, { note: note.value }));
  }
  $('#day-note').addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 700); });
  $('#day-note').addEventListener('blur', saveNote);

  $('#board-groups').addEventListener('click', (ev) => {
    const tile = ev.target.closest('.tile');
    if (tile) openLog(tile.dataset.id);
  });

  const filter = $('#filter');
  filter.addEventListener('input', () => { state.filter = filter.value; renderBoard(); });
  filter.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { filter.value = ''; state.filter = ''; renderBoard(); }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const first = $$('#board-groups .group:not([hidden]) .tile')[0];
      if (first && state.filter.trim()) openLog(first.dataset.id);
    }
  });

  $('#board-head').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sort]');
    if (!b) return;
    state.ui.sort = b.dataset.sort;
    store.set(K.ui, state.ui);
    renderBoard();
  });

  $('#empty-add').addEventListener('click', () => { state.adding = true; });

  // ------------------------------------------------------------------ events: other views

  $('#history-body').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="more"]')) { state.historyLimit += 60; renderHistory(); }
  });

  $('#view-exercises').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-entry]');
    if (row) return openEdit(row.dataset.entry);
    const act = ev.target.closest('[data-act]');
    if (!act || act.tagName === 'SELECT') return;
    const id = state.exercise;
    const ex = exMap().get(id);
    const v = act.dataset.var;
    switch (act.dataset.act) {
      case 'add-open': state.adding = true; renderExercises(); break;
      case 'add-cancel': state.adding = false; renderExercises(); break;
      case 'log-today': openLog(id, today()); break;
      case 'up': commit(C.moveExercise(state.doc, id, -1)); break;
      case 'down': commit(C.moveExercise(state.doc, id, 1)); break;
      case 'archive':
        commit(C.editExercise(state.doc, id, { archived: !ex.archived }));
        toast(ex.archived ? `${ex.name} is back on the board` : `Archived ${ex.name}`);
        break;
      case 'delete-ex':
        commitUndoable(C.deleteExercise(state.doc, id), `Deleted ${ex.name}`, `Delete ${ex.name}`);
        break;
      case 'var-up': commit(C.moveVariation(state.doc, id, v, -1)); break;
      case 'var-down': commit(C.moveVariation(state.doc, id, v, 1)); break;
      case 'var-declare': commit(C.addVariation(state.doc, id, v)); break;
      case 'var-remove':
        commitUndoable(C.removeVariation(state.doc, id, v), `Took ${v} off the list. Its history stays.`);
        break;
      case 'var-rename': state.renaming = { exercise: id, from: v }; renderExercises(); break;
      case 'rename-cancel': state.renaming = null; renderExercises(); break;
      case 'cat-up': commit(C.moveCategory(state.doc, act.dataset.id, -1)); break;
      case 'cat-down': commit(C.moveCategory(state.doc, act.dataset.id, 1)); break;
      case 'cat-delete': state.deletingCategory = act.dataset.id; renderExercises(); break;
      case 'cat-delete-no': state.deletingCategory = null; renderExercises(); break;
      case 'cat-delete-yes': {
        const cat = state.doc.categories.find((c) => c.id === act.dataset.id);
        const sel = act.closest('td').querySelector('[data-role="move-to"]');
        state.deletingCategory = null;
        commitUndoable(C.deleteCategory(state.doc, cat.id, sel ? sel.value : null), `Deleted the ${cat.name} category`, `Delete category ${cat.name}`);
        break;
      }
      default: break;
    }
  });
  $('#view-exercises').addEventListener('keydown', (ev) => {
    const row = ev.target.closest('tr[data-entry]');
    if (row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openEdit(row.dataset.entry); }
    if (ev.key === 'Escape' && state.renaming) { state.renaming = null; renderExercises(); }
  });
  $('#view-exercises').addEventListener('change', (ev) => {
    if (ev.target.matches('select[data-act="category"]')) commit(C.editExercise(state.doc, state.exercise, { category: ev.target.value }));
  });
  $('#view-exercises').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const kind = form.dataset.form;
    const value = (name) => (form.elements[name] ? form.elements[name].value.trim() : '');
    const live = C.liveExercises(state.doc);
    const ex = exMap().get(state.exercise);
    if (kind === 'add' || kind === 'rename') {
      const name = value('name');
      if (!name) return;
      const taken = live.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (taken && (kind === 'add' || taken.id !== state.exercise)) { toast(`There's already an exercise called ${taken.name}`); return; }
      if (kind === 'add') {
        let doc = C.ensureCategories(state.doc);
        const cats = C.liveCategories(doc);
        const category = value('category') || (cats.find((c) => c.id === 'exercises') || cats[cats.length - 1]).id;
        let exercise;
        ({ doc, exercise } = C.addExercise(doc, { name, category }));
        state.adding = false;
        commit(doc);
        location.hash = `#exercises/${encodeURIComponent(exercise.id)}`;
        toast(`Added ${name}`);
      } else {
        commit(C.editExercise(state.doc, state.exercise, { name }));
        toast(`Renamed to ${name}`);
      }
    } else if (kind === 'add-var') {
      const name = value('name');
      if (name) commit(C.addVariation(state.doc, state.exercise, name));
    } else if (kind === 'rename-var') {
      const from = form.dataset.from, to = value('to');
      state.renaming = null;
      if (!to || to === from) { renderExercises(); return; }
      const merging = ex.variations.includes(to) || C.entriesOf(state.doc, ex.id).some((e) => e.variations.includes(to));
      const what = from ? `${from} to ${to}` : `entries with no variation to ${to}`;
      commitUndoable(C.renameVariation(state.doc, ex.id, from, to),
        merging ? `Merged ${from || 'the plain entries'} into ${to}` : `Renamed ${what}`,
        `${ex.name}: rename variation ${what}`);
    } else if (kind === 'combine') {
      const into = exMap().get(form.elements.into.value);
      const as = value('as');
      commitUndoable(C.combineExercises(state.doc, ex.id, into.id, as),
        `Combined ${ex.name} into ${into.name}${as && as !== ex.name ? ` as ${as}` : ''}`,
        `Combine ${ex.name} into ${into.name}${as ? ` as ${as}` : ''}`);
      location.hash = `#exercises/${encodeURIComponent(into.id)}`;
    } else if (kind === 'add-cat') {
      const name = value('name');
      if (!name) return;
      const { doc } = C.addCategory(state.doc, { name });
      commit(doc);
      toast(`Added the ${name} category`);
    } else if (kind === 'rename-cat') {
      const name = value('name');
      if (name) commit(C.editCategory(state.doc, form.dataset.id, { name }));
    }
  });

  $('#view-settings').addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'sync-form') return;
    ev.preventDefault();
    const f = ev.target.elements;
    state.settings = {
      owner: f.owner.value.trim(), repo: f.repo.value.trim(),
      branch: f.branch.value.trim() || 'main', path: f.path.value.trim() || 'log.json',
    };
    store.set(K.settings, state.settings);
    const tok = f.token.value.trim();
    if (tok) store.set(K.token, tok); else store.remove(K.token);
    if (!connected()) { setSync('off'); toast('Fill in the username, repository and token to sync.'); return; }
    setSync('saving', '');
    try {
      const repo = await client().checkRepo();
      if (!repo.private) toast(`${repo.fullName} is public, so anyone can read your log. You can make it private in its settings on GitHub.`);
    } catch (e) {
      setSync(e.kind === 'offline' ? 'offline' : 'error', e.message);
      return;
    }
    runSync();
  });

  $('#view-settings').addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'sync-now') runSync();
    if (act.dataset.act === 'show-token') {
      const input = $('#sync-form').elements.token;
      input.type = input.type === 'password' ? 'text' : 'password';
      act.textContent = input.type === 'password' ? 'Show' : 'Hide';
    }
    if (act.dataset.act === 'disconnect') {
      store.remove(K.token);
      $('#sync-form').elements.token.value = '';
      setSync('off', '');
      toast('Disconnected. The token is removed from this computer; the log stays here.');
    }
    if (act.dataset.act === 'export') {
      const blob = new Blob([C.serialize(state.doc)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `practice-log-${today()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    if (act.dataset.act === 'start-over') { state.startingOver = true; $('#start-over').hidden = false; }
    if (act.dataset.act === 'start-over-cancel') { state.startingOver = false; $('#start-over').hidden = true; }
  });

  async function readLogFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return null;
    try {
      return { file, doc: C.validate(JSON.parse(await file.text())) };
    } catch (e) {
      toast(`Couldn't read ${file.name}: ${e.message}`);
      return null;
    }
  }

  $('#view-settings').addEventListener('change', async (ev) => {
    if (ev.target.name === 'theme') {
      state.ui.theme = ev.target.value;
      store.set(K.ui, state.ui);
      render();
    }
    if (ev.target.name === 'countLessons') {
      state.ui.countLessons = ev.target.checked;
      store.set(K.ui, state.ui);
    }
    if (ev.target.id === 'load-file') {
      const got = await readLogFile(ev.target);
      if (!got) return;
      const before = new Set(state.doc.entries.map((e) => e.id));
      const added = got.doc.entries.filter((e) => !before.has(e.id) && !e.deleted).length;
      const merged = C.merge(state.doc, got.doc);
      if (C.sameDoc(merged, state.doc)) { toast(`Nothing new in ${got.file.name}.`); return; }
      commit(merged);
      toast(`Loaded ${got.file.name}: ${added.toLocaleString('en')} new entries.`);
    }
    if (ev.target.id === 'start-over-file') {
      const got = await readLogFile(ev.target);
      if (!got) return;
      state.doc = C.replaceWith(state.doc, got.doc);
      saveDoc();
      state.sync.dirty = true;
      state.sync.replace = true;
      state.sync.notes = [`Start over from ${got.file.name}`];
      persistSync();
      state.startingOver = false;
      state.boardKey = '';
      renderSettings();
      scheduleSync(300);
      toast(`Started over from ${got.file.name}: ${C.live(got.doc).length.toLocaleString('en')} entries.`);
    }
  });

  $('#sync-status').addEventListener('click', () => {
    const st = connected() ? state.sync.state : 'off';
    if (st === 'off' || st === 'error') location.hash = '#settings';
    else runSync();
  });

  // ------------------------------------------------------------------ keyboard, focus, other tabs

  document.addEventListener('keydown', (ev) => {
    if (dialog.open || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const typing = ev.target.closest('input, textarea, select, [contenteditable]');
    if (typing || state.view !== 'day') return;
    if (ev.key === '/') { ev.preventDefault(); filter.focus(); filter.select(); }
    else if (ev.key === 'ArrowLeft') setDate(C.addDays(state.date, -1));
    else if (ev.key === 'ArrowRight' && state.date < today()) setDate(C.addDays(state.date, 1));
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => runSync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { saveNote(); return; }
    rollToday();
    if (connected() && Date.now() - lastPull > 30000) runSync();
  });
  window.addEventListener('pagehide', saveNote);
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    rollToday();
    if (connected() && !syncing && Date.now() - lastPull > 5 * 60000) runSync();
  }, 60000);

  window.addEventListener('storage', (ev) => {
    if (ev.key !== K.doc || !ev.newValue) return;
    try {
      const other = C.validate(JSON.parse(ev.newValue));
      const merged = C.merge(state.doc, other);
      if (!C.sameDoc(merged, state.doc)) { state.doc = merged; render(); }
    } catch (e) { /* the other tab wrote something odd; ignore it */ }
  });

  if (darkQuery.addEventListener) {
    darkQuery.addEventListener('change', () => { if (state.ui.theme === 'auto') render(); });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is a bonus */ });
  }

  // ------------------------------------------------------------------ start

  route();
  if (connected()) setTimeout(runSync, 300);

  // Handy from the browser console, and used by the browser tests.
  window.practiceLog = { state, runSync };
})();
