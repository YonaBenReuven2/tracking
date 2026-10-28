/* Practice log: the data model and everything that doesn't touch the page or the network.
 * Loaded by the app as a plain script (window.PLCore) and by the tests with require(). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PLCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const APP = 'practice-log';
  const VERSION = 2;

  // ---------------------------------------------------------------- dates
  // Dates are local calendar days written 'YYYY-MM-DD'. Arithmetic goes through a
  // day number so daylight-saving changes never shift a day.

  const pad = (n) => String(n).padStart(2, '0');

  function localDate(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function dayNumber(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }

  function fromDayNumber(n) {
    const t = new Date(n * 86400000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);
  const addDays = (iso, n) => fromDayNumber(dayNumber(iso) + n);
  const weekday = (iso) => new Date(dayNumber(iso) * 86400000).getUTCDay(); // 0 = Sunday

  function isDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
  }

  // ---------------------------------------------------------------- ids and time

  function newId(prefix = 'e', now = Date.now(), rand = Math.random) {
    const time = now.toString(36).padStart(9, '0');
    const tail = Math.floor(rand() * 36 ** 5).toString(36).padStart(5, '0');
    return prefix + time + tail;
  }

  const stamp = (now = Date.now()) => new Date(now).toISOString();

  // ---------------------------------------------------------------- the document
  // {app, version, categories, exercises, days, entries}
  //   category: {id, name, order, updated}
  //   exercise: {id, name, category, variations: [names], archived, order, updated}
  //   day:      {id: 'YYYY-MM-DD', label, note, updated}
  //   entry:    {id, date, exercise, variations: [names], lesson?, pos?, note, updated}
  //             pos is the place in that day's list once you've reordered it by hand;
  //             without it, entries are in the order they were logged.
  // Records are never removed: a deletion is {deleted: true} with a newer `updated`.
  // That makes merging two copies a plain union where the newer version of a record wins.

  const LISTS = ['categories', 'exercises', 'days', 'entries'];
  const OLD_TIME = '1970-01-01T00:00:00.000Z';
  const DEFAULT_CATEGORIES = [
    { id: 'breathing', name: 'Breathing', order: 1 },
    { id: 'exercises', name: 'Exercises', order: 2 },
  ];

  const emptyDoc = () => ({ app: APP, version: VERSION, categories: [], exercises: [], days: [], entries: [] });

  const cleanTags = (list) => {
    const out = [];
    for (const t of list || []) {
      const s = String(t).replace(/\s+/g, ' ').trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  };

  function validate(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object');
    if (doc.app !== undefined && doc.app !== APP) throw new Error(`made by "${doc.app}", not this app`);
    if (typeof doc.version === 'number' && doc.version > VERSION) {
      throw new Error(`version ${doc.version} is newer than this app understands; reload to update`);
    }
    const out = emptyDoc();
    for (const key of LISTS) {
      const list = doc[key] === undefined ? [] : doc[key];
      if (!Array.isArray(list)) throw new Error(`"${key}" is not a list`);
      for (const rec of list) {
        if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !rec.id) {
          throw new Error(`a record in "${key}" has no id`);
        }
        if (typeof rec.updated !== 'string') throw new Error(`record ${rec.id} has no "updated" time`);
        if (key === 'entries' && !isDate(rec.date)) throw new Error(`entry ${rec.id} has a bad date`);
        if (key === 'days' && !isDate(rec.id)) throw new Error(`day ${rec.id} is not a date`);
      }
      out[key] = list.map((r) => ({ ...r }));
    }
    // Files from version 1 had one variation per entry and two fixed groups.
    for (const e of out.entries) {
      if (!Array.isArray(e.variations)) e.variations = cleanTags(e.variation ? [e.variation] : []);
      delete e.variation;
    }
    for (const x of out.exercises) {
      if (x.category === undefined) x.category = x.group === 'breathing' ? 'breathing' : 'exercises';
      delete x.group;
      if (!Array.isArray(x.variations)) x.variations = [];
    }
    if (!out.categories.length && out.exercises.length) {
      out.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c, updated: OLD_TIME }));
    }
    return out;
  }

  const KEY_ORDER = ['id', 'date', 'exercise', 'name', 'category', 'variations', 'lesson', 'pos', 'archived', 'order',
    'label', 'note', 'deleted', 'updated'];

  function ordered(rec) {
    const keys = Object.keys(rec).sort((a, b) => {
      const ia = KEY_ORDER.indexOf(a), ib = KEY_ORDER.indexOf(b);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const out = {};
    for (const k of keys) if (rec[k] !== undefined) out[k] = rec[k];
    return out;
  }

  const recordText = (rec) => JSON.stringify(ordered(rec));
  const contentText = (rec) => { const { updated, ...rest } = rec; return JSON.stringify(ordered(rest)); };
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byDateThenId = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byId(a, b));

  function sortDoc(doc) {
    return {
      app: APP,
      version: VERSION,
      categories: (doc.categories || []).slice().sort(byId),
      exercises: (doc.exercises || []).slice().sort(byId),
      days: (doc.days || []).slice().sort(byId),
      entries: (doc.entries || []).slice().sort(byDateThenId),
    };
  }

  /** One record per line, so a commit that logs one exercise is a small diff. */
  function serialize(doc) {
    const d = sortDoc(doc);
    const block = (key) => {
      if (!d[key].length) return `  "${key}": []`;
      return `  "${key}": [\n${d[key].map((r) => '    ' + recordText(r)).join(',\n')}\n  ]`;
    };
    return `{\n  "app": ${JSON.stringify(APP)},\n  "version": ${VERSION},\n` +
      LISTS.map(block).join(',\n') + '\n}\n';
  }

  const sameDoc = (a, b) => serialize(a) === serialize(b);

  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.updated > b.updated) return a;
    if (b.updated > a.updated) return b;
    return recordText(a) >= recordText(b) ? a : b; // same time: any fixed rule, so both sides agree
  }

  function mergeList(a, b) {
    const map = new Map();
    for (const rec of a || []) map.set(rec.id, newer(map.get(rec.id), rec));
    for (const rec of b || []) map.set(rec.id, newer(map.get(rec.id), rec));
    return [...map.values()];
  }

  function merge(a, b) {
    const out = {};
    for (const key of LISTS) out[key] = mergeList(a[key], b[key]);
    return sortDoc(out);
  }

  const isEmpty = (doc) => LISTS.every((k) => !doc[k].length);

  // ---------------------------------------------------------------- editing helpers
  // Each returns a new document; the input is left alone.

  function upsert(doc, key, rec, now = Date.now()) {
    const next = { ...doc, [key]: doc[key].filter((r) => r.id !== rec.id) };
    next[key].push({ ...rec, updated: stamp(now) });
    return next;
  }

  const find = (doc, key, id) => doc[key].find((r) => r.id === id);

  function edit(doc, key, id, changes, now) {
    const old = find(doc, key, id);
    if (!old) throw new Error(`no such ${key.slice(0, -1)}`);
    const rec = { ...old, ...changes };
    for (const flag of ['deleted', 'lesson', 'archived']) if (rec[flag] === false && flag !== 'archived') delete rec[flag];
    if (contentText(rec) === contentText(old)) return doc;
    return upsert(doc, key, rec, now);
  }

  // entries

  function addEntry(doc, { date, exercise, variations = [], note = '', lesson = false }, now = Date.now()) {
    const entry = { id: newId('e', now), date, exercise, variations: cleanTags(variations), note: note.trim() };
    if (lesson) entry.lesson = true;
    return { doc: upsert(doc, 'entries', entry, now), entry: { ...entry, updated: stamp(now) } };
  }

  function editEntry(doc, id, changes, now = Date.now()) {
    const c = { ...changes };
    const old = find(doc, 'entries', id);
    if (old && 'lesson' in c && !!c.lesson !== !!old.lesson && !('pos' in c)) c.pos = undefined;
    if (c.variations) c.variations = cleanTags(c.variations);
    if (typeof c.note === 'string') c.note = c.note.trim();
    return edit(doc, 'entries', id, c, now);
  }

  const deleteEntry = (doc, id, now) => editEntry(doc, id, { deleted: true }, now);
  const restoreEntry = (doc, id, now) => editEntry(doc, id, { deleted: false }, now);

  // days

  function setDay(doc, date, changes, now = Date.now()) {
    const old = doc.days.find((d) => d.id === date) || { id: date, label: '', note: '' };
    const rec = { ...old, ...changes };
    rec.label = (rec.label || '').trim();
    rec.note = rec.note || '';
    const exists = doc.days.includes(old);
    const unchanged = rec.label === (old.label || '') && rec.note === (old.note || '');
    if (unchanged && (exists || (!rec.label && !rec.note))) return doc;
    return upsert(doc, 'days', rec, now);
  }

  // categories

  const liveCategories = (doc) => doc.categories.filter((c) => !c.deleted).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));

  /** Adds the two starting categories if there are none (used before the first exercise). */
  function ensureCategories(doc, now = Date.now()) {
    if (liveCategories(doc).length) return doc;
    let next = doc;
    for (const c of DEFAULT_CATEGORIES) {
      next = find(next, 'categories', c.id) ? edit(next, 'categories', c.id, { deleted: false }, now) : upsert(next, 'categories', c, now);
    }
    return next;
  }

  function addCategory(doc, { name }, now = Date.now()) {
    const order = doc.categories.reduce((m, c) => Math.max(m, c.order || 0), 0) + 1;
    const cat = { id: newId('c', now), name: name.trim(), order };
    return { doc: upsert(doc, 'categories', cat, now), category: cat };
  }

  const editCategory = (doc, id, changes, now = Date.now()) => edit(doc, 'categories', id, changes, now);

  /** Deletes a category, moving its exercises to another one first. */
  function deleteCategory(doc, id, moveTo, now = Date.now()) {
    let next = doc;
    for (const x of doc.exercises.filter((e) => e.category === id && !e.deleted)) {
      next = edit(next, 'exercises', x.id, { category: moveTo }, now);
    }
    return edit(next, 'categories', id, { deleted: true }, now);
  }

  function reorder(doc, key, list, id, dir, now) {
    const i = list.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return doc;
    // Renumber the whole list so equal or missing orders can't make a swap a no-op.
    const seq = list.map((r) => r.id);
    [seq[i], seq[j]] = [seq[j], seq[i]];
    let next = doc;
    seq.forEach((rid, k) => { next = edit(next, key, rid, { order: k + 1 }, now); });
    return next;
  }

  const moveCategory = (doc, id, dir, now = Date.now()) => reorder(doc, 'categories', liveCategories(doc), id, dir, now);

  // exercises

  const liveExercises = (doc) => doc.exercises.filter((x) => !x.deleted);
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name);

  function addExercise(doc, { name, category }, now = Date.now()) {
    const order = doc.exercises.reduce((m, e) => Math.max(m, e.order || 0), 0) + 1;
    const ex = { id: newId('x', now), name: name.trim(), category, variations: [], archived: false, order };
    return { doc: upsert(doc, 'exercises', ex, now), exercise: ex };
  }

  const editExercise = (doc, id, changes, now = Date.now()) => edit(doc, 'exercises', id, changes, now);

  /** Put a category's exercises in this order (and into this category, for ones dragged in). */
  function arrangeExercises(doc, category, ids, now = Date.now()) {
    let next = doc;
    ids.forEach((id, i) => { next = editExercise(next, id, { category, order: i + 1 }, now); });
    return next;
  }

  /** Swap an exercise with its neighbour among the active exercises of its category. */
  function moveExercise(doc, id, dir, now = Date.now()) {
    const ex = find(doc, 'exercises', id);
    const peers = liveExercises(doc).filter((e) => e.category === ex.category && !e.archived).sort(byOrder);
    return reorder(doc, 'exercises', peers, id, dir, now);
  }

  const entriesOf = (doc, exId) => doc.entries.filter((e) => e.exercise === exId && !e.deleted).sort(byDateThenId);

  /** Only for exercises with no history; anything with entries is archived or combined instead. */
  function deleteExercise(doc, id, now = Date.now()) {
    if (entriesOf(doc, id).length) throw new Error('this exercise has entries');
    return edit(doc, 'exercises', id, { deleted: true }, now);
  }

  // variations

  function addVariation(doc, exId, name, now = Date.now()) {
    const ex = find(doc, 'exercises', exId);
    return editExercise(doc, exId, { variations: cleanTags([...ex.variations, name]) }, now);
  }

  function removeVariation(doc, exId, name, now = Date.now()) {
    const ex = find(doc, 'exercises', exId);
    return editExercise(doc, exId, { variations: ex.variations.filter((v) => v !== name) }, now);
  }

  function moveVariation(doc, exId, name, dir, now = Date.now()) {
    const ex = find(doc, 'exercises', exId);
    const list = ex.variations.slice();
    const i = list.indexOf(name), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return doc;
    [list[i], list[j]] = [list[j], list[i]];
    return editExercise(doc, exId, { variations: list }, now);
  }

  /**
   * Rename a variation everywhere it's used for this exercise. Renaming to a name that
   * already exists merges the two. `from` = '' means entries with no variation at all.
   */
  function renameVariation(doc, exId, from, to, now = Date.now()) {
    to = String(to).replace(/\s+/g, ' ').trim();
    if (!to || to === from) return doc;
    let next = doc;
    for (const e of entriesOf(doc, exId)) {
      const has = from === '' ? e.variations.length === 0 : e.variations.includes(from);
      if (!has) continue;
      const vars = from === '' ? [to] : e.variations.map((v) => (v === from ? to : v));
      next = editEntry(next, e.id, { variations: vars }, now);
    }
    const ex = find(next, 'exercises', exId);
    let declared = ex.variations.map((v) => (v === from ? to : v));
    if (from === '' && !declared.includes(to)) declared = [to, ...declared];
    return editExercise(next, exId, { variations: cleanTags(declared) }, now);
  }

  /**
   * Fold one exercise into another: its entries move over, tagged with `as` (usually its
   * old name) as a variation, and it disappears from the list.
   */
  function combineExercises(doc, fromId, intoId, as, now = Date.now()) {
    if (fromId === intoId) throw new Error('pick a different exercise');
    const tag = String(as || '').replace(/\s+/g, ' ').trim();
    let next = doc;
    for (const e of entriesOf(doc, fromId)) {
      next = editEntry(next, e.id, { exercise: intoId, variations: tag ? [tag, ...e.variations] : e.variations }, now);
    }
    const from = find(next, 'exercises', fromId), into = find(next, 'exercises', intoId);
    const declared = cleanTags([...into.variations, ...(tag ? [tag] : [])]);
    next = editExercise(next, intoId, { variations: declared, archived: into.archived && from.archived }, now);
    return editExercise(next, fromId, { deleted: true }, now);
  }

  /**
   * Start over from another file: everything in `incoming` is kept, everything else in
   * `current` is marked deleted, and all of it gets a new time. That way the new file wins
   * when merged with any older copy, wherever it is.
   */
  function replaceWith(current, incoming, now = Date.now()) {
    const t = stamp(now);
    const out = {};
    for (const key of LISTS) {
      const ids = new Set(incoming[key].map((r) => r.id));
      const kept = incoming[key].map((r) => ({ ...r, updated: t }));
      const gone = current[key].filter((r) => !ids.has(r.id)).map((r) =>
        (key === 'days' ? { ...r, label: '', note: '', updated: t } : { ...r, deleted: true, updated: t }));
      out[key] = [...kept, ...gone];
    }
    return sortDoc(out);
  }

  /**
   * Undo: bring every record that differs from `snapshot` back to its snapshot version,
   * with a new time so the undo also wins when merged with other copies.
   */
  function revert(current, snapshot, now = Date.now()) {
    let next = current;
    for (const key of LISTS) {
      const old = new Map(snapshot[key].map((r) => [r.id, r]));
      for (const rec of current[key]) {
        const was = old.get(rec.id);
        if (was && contentText(was) === contentText(rec)) continue;
        if (was) next = upsert(next, key, was, now);
        else if (key === 'days') next = upsert(next, key, { ...rec, label: '', note: '' }, now);
        else next = upsert(next, key, { ...rec, deleted: true }, now);
      }
    }
    return next;
  }

  // ---------------------------------------------------------------- reading the log

  const live = (doc) => doc.entries.filter((e) => !e.deleted);

  const byPos = (a, b) => ((a.pos ?? Infinity) - (b.pos ?? Infinity)) || byId(a, b);

  /** A day's entries in their list order (own practice and lesson mixed; filter by e.lesson). */
  function entriesOn(doc, date) {
    return live(doc).filter((e) => e.date === date).sort(byPos);
  }

  /**
   * Set a day's lists from the order they're shown in after dragging:
   * lists = [{lesson: false, ids: [...]}, {lesson: true, ids: [...]}]. Only entries whose
   * place or section actually changed get a new record.
   */
  function arrangeEntries(doc, lists, now = Date.now()) {
    let next = doc;
    for (const { lesson, ids } of lists) {
      ids.forEach((id, i) => { next = editEntry(next, id, { pos: i + 1, lesson: !!lesson }, now); });
    }
    return next;
  }

  const dayOf = (doc, date) => doc.days.find((d) => d.id === date) || null;

  /**
   * Per-exercise numbers as of a date (entries after it are ignored):
   * {last, daysSince, count, recent, typicalGap, lastVariations,
   *  tags: Map(name -> {count, last, daysSince}), plain: {count, last, daysSince}}
   * With lessons: false, entries from lessons don't count.
   */
  function exerciseStats(doc, asOf, { lessons = true } = {}) {
    const blank = () => ({ count: 0, last: null, daysSince: null });
    const stats = new Map();
    for (const ex of doc.exercises) {
      stats.set(ex.id, { ...blank(), recent: 0, gaps: [], lastVariations: [], tags: new Map(), plain: blank() });
    }
    const entries = live(doc).filter((e) => e.date <= asOf && (lessons || !e.lesson)).sort(byDateThenId);
    const bump = (o, date) => { o.count++; o.last = date; };
    for (const e of entries) {
      const s = stats.get(e.exercise);
      if (!s) continue;
      if (s.last && s.last !== e.date) s.gaps.push(daysBetween(s.last, e.date));
      bump(s, e.date);
      if (daysBetween(e.date, asOf) < 90) s.recent++;
      s.lastVariations = e.variations;
      if (!e.variations.length) bump(s.plain, e.date);
      for (const v of e.variations) {
        if (!s.tags.has(v)) s.tags.set(v, blank());
        bump(s.tags.get(v), e.date);
      }
    }
    for (const s of stats.values()) {
      for (const o of [s, s.plain, ...s.tags.values()]) if (o.last) o.daysSince = daysBetween(o.last, asOf);
      const g = s.gaps.slice().sort((a, b) => a - b);
      s.typicalGap = g.length ? g[Math.floor(g.length / 2)] : null;
    }
    return stats;
  }

  /**
   * The variations to offer for an exercise: plain (no variation) when that has history and
   * there's something to tell it apart from, then the exercise's own list in its order, then
   * anything else used before, most recent first.
   */
  function variationChoices(ex, stat) {
    const out = [];
    const none = { count: 0, last: null, daysSince: null };
    if (stat.plain.count && (ex.variations.length || stat.tags.size)) out.push({ name: '', plain: true, declared: false, ...stat.plain });
    for (const v of ex.variations) out.push({ name: v, declared: true, ...(stat.tags.get(v) || none) });
    const others = [...stat.tags.entries()].filter(([v]) => !ex.variations.includes(v))
      .sort((a, b) => (a[1].last < b[1].last ? 1 : a[1].last > b[1].last ? -1 : b[1].count - a[1].count));
    for (const [v, o] of others) out.push({ name: v, declared: false, ...o });
    return out;
  }

  /** Rest-day labels you've used, most used first. */
  function labelsByUse(doc) {
    const counts = new Map();
    for (const d of doc.days) if (d.label) counts.set(d.label, (counts.get(d.label) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([l]) => l);
  }

  /** Dates that have anything on them (entries, a label or a note), newest first. */
  function activeDates(doc) {
    const set = new Set(live(doc).map((e) => e.date));
    for (const d of doc.days) if (d.label || d.note) set.add(d.id);
    return [...set].sort().reverse();
  }

  // ---------------------------------------------------------------- numbers inside variations
  // "g#4", "up to d4" -> a pitch; "35s", "no random 30s" -> seconds. Used for progress charts.

  const NOTE_STEPS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

  function measure(text) {
    if (!text) return null;
    const p = /(?:^|[^a-z#])([a-g])(#|b(?=\d))?([0-8])(?!\d)/i.exec(text);
    if (p) {
      const step = NOTE_STEPS[p[1].toLowerCase()] + (p[2] === '#' ? 1 : p[2] ? -1 : 0);
      return { kind: 'pitch', value: 12 * (Number(p[3]) + 1) + step };
    }
    const s = /(?:^|\D)(\d{1,3})\s*s\b/i.exec(text);
    if (s) return { kind: 'seconds', value: Number(s[1]) };
    return null;
  }

  const pitchName = (midi) => SHARP_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

  /** {kind, points: [{date, value, variation}]} when enough entries carry the same kind of number. */
  function progress(doc, exerciseId, min = 3) {
    const points = { pitch: [], seconds: [] };
    for (const e of live(doc).filter((x) => x.exercise === exerciseId).sort(byDateThenId)) {
      for (const v of e.variations) {
        const m = measure(v);
        if (m) { points[m.kind].push({ date: e.date, value: m.value, variation: v }); break; }
      }
    }
    const kind = points.pitch.length >= points.seconds.length ? 'pitch' : 'seconds';
    return points[kind].length >= min ? { kind, points: points[kind] } : null;
  }

  // ---------------------------------------------------------------- staleness colours
  // Days since an exercise was last done -> a fill colour, interpolated in OKLab so the
  // steps look even. The old sheet stopped at three weeks; this keeps darkening for months.

  const RAMP_STOPS = [
    [7, '#f1e19c'],
    [14, '#ecb45b'],
    [21, '#dc7a3a'],
    [35, '#bb4430'],
    [60, '#86232b'],
    [120, '#4a1426'],
  ];
  // Done today or yesterday: a neutral fill. In the dark theme that is dark, and the
  // ramp then starts from a pale warm grey at two days, so it never passes through mud.
  const LOW_STOPS = {
    light: [[1, '#e3e7df']],
    dark: [[1, '#283035'], [2, '#d9dbd1']],
  };
  const LEGEND_TICKS = [[0, 'today'], [7, '1 wk'], [14, '2 wk'], [21, '3 wk'], [35, '5 wk'], [60, '2 mo'], [120, '4 mo']];

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
  const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const toSrgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function rgbToOklab([r, g, b]) {
    const [R, G, B] = [r, g, b].map(toLin);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }

  function oklabToRgb([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(toSrgb);
  }

  function mix(hexA, hexB, t) {
    const a = rgbToOklab(hexToRgb(hexA)), b = rgbToOklab(hexToRgb(hexB));
    return rgbToHex(oklabToRgb(a.map((v, i) => v + (b[i] - v) * t)));
  }

  /** Fill colour for something last done `days` ago (null = never). */
  function staleColor(days, theme = 'light') {
    const stops = [...(LOW_STOPS[theme] || LOW_STOPS.light), ...RAMP_STOPS];
    if (days === null || days === undefined) return stops[stops.length - 1][1];
    if (days <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (days <= stops[i][0]) {
        const [d0, c0] = stops[i - 1], [d1, c1] = stops[i];
        return mix(c0, c1, (days - d0) / (d1 - d0));
      }
    }
    return stops[stops.length - 1][1];
  }

  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map(toLin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  /** Black or white, whichever reads better on the fill. Pure black and white are the only
   *  pair that clears 4.5:1 on every colour of a light-to-dark ramp. */
  function textOn(fill, dark = '#000000', light = '#ffffff') {
    return contrast(fill, dark) >= contrast(fill, light) ? dark : light;
  }

  // ---------------------------------------------------------------- commit messages

  function describeChanges(before, after) {
    const names = new Map(after.exercises.map((e) => [e.id, e.name]));
    const label = (e) => (names.get(e.exercise) || e.exercise) + (e.variations.length ? ` (${e.variations.join(', ')})` : '');
    const list = (items) => (items.length > 4 ? `${items.slice(0, 4).join(', ')} +${items.length - 4} more` : items.join(', '));
    const old = new Map(before.entries.map((e) => [e.id, e]));
    const added = [], edited = [], removed = [];
    for (const e of after.entries) {
      const b = old.get(e.id);
      if (!b) { if (!e.deleted) added.push(e); continue; }
      if (recordText(b) === recordText(e)) continue;
      if (e.deleted && !b.deleted) removed.push(e);
      else if (!e.deleted && b.deleted) added.push(e); // brought back with undo
      else if (!e.deleted) edited.push(e);
    }
    const changed = (key) => {
      const was = new Map(before[key].map((r) => [r.id, recordText(r)]));
      return after[key].filter((r) => was.get(r.id) !== recordText(r));
    };
    const days = changed('days');
    const exercises = changed('exercises');
    const categories = changed('categories');

    const dates = new Set([...added, ...edited, ...removed].map((e) => e.date).concat(days.map((d) => d.id)));
    const parts = [];
    if (added.length > 8 && dates.size > 1) {
      parts.push(`log ${added.length} exercises on ${new Set(added.map((e) => e.date)).size} days`);
    } else if (added.length) parts.push(list(added.map(label)));
    if (edited.length > 8) parts.push(`edit ${edited.length} entries`);
    else if (edited.length) parts.push(`edit ${list(edited.map(label))}`);
    if (removed.length) parts.push(`remove ${list(removed.map(label))}`);
    if (days.length === 1) parts.push(days[0].label ? days[0].label : 'note');
    else if (days.length) parts.push(`update ${days.length} days`);
    if (exercises.length) parts.push(exercises.length > 3 ? `update ${exercises.length} exercises` : `update ${exercises.map((x) => x.name).join(', ')}`);
    if (categories.length) parts.push(`update categories`);
    if (!parts.length) return 'Update practice log';
    const msg = parts.join('; ');
    return dates.size === 1 ? `${[...dates][0]}: ${msg}` : msg.charAt(0).toUpperCase() + msg.slice(1);
  }

  return {
    APP, VERSION,
    localDate, dayNumber, daysBetween, addDays, weekday, isDate,
    newId, stamp,
    emptyDoc, validate, serialize, sameDoc, merge, isEmpty, recordText, cleanTags,
    addEntry, editEntry, deleteEntry, restoreEntry, setDay,
    liveCategories, ensureCategories, addCategory, editCategory, deleteCategory, moveCategory,
    liveExercises, byOrder, addExercise, editExercise, moveExercise, arrangeExercises, deleteExercise, entriesOf,
    arrangeEntries,
    addVariation, removeVariation, moveVariation, renameVariation, combineExercises, revert, replaceWith,
    live, entriesOn, dayOf, exerciseStats, variationChoices, labelsByUse, activeDates,
    measure, pitchName, progress,
    staleColor, textOn, contrast, LEGEND_TICKS,
    describeChanges,
  };
});
