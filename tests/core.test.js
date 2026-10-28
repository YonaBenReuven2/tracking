// Run with: node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

const T0 = Date.UTC(2026, 9, 27, 18, 0, 0);

function sample() {
  let doc = core.ensureCategories(core.emptyDoc(), T0);
  ({ doc } = core.addExercise(doc, { name: 'basic scale', category: 'exercises' }, T0 + 1));
  ({ doc } = core.addExercise(doc, { name: 'ree', category: 'exercises' }, T0 + 2));
  ({ doc } = core.addExercise(doc, { name: 'sfch', category: 'breathing' }, T0 + 3));
  return doc;
}
const idOf = (doc, name) => doc.exercises.find((e) => e.name === name && !e.deleted).id;
const log = (doc, name, date, variations = [], t = T0 + 100, extra = {}) =>
  core.addEntry(doc, { date, exercise: idOf(doc, name), variations, ...extra }, t).doc;

test('local date uses the local calendar, not UTC', () => {
  const d = new Date(2026, 9, 28, 0, 30);
  assert.equal(core.localDate(d), '2026-10-28');
});

test('day arithmetic is immune to daylight saving', () => {
  assert.equal(core.daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(core.daysBetween('2026-03-26', '2026-03-28'), 2);
  assert.equal(core.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(core.addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(core.weekday('2026-10-25'), 0);
  assert.ok(core.isDate('2026-02-28'));
  assert.ok(!core.isDate('2025-02-31'));
});

test('ids sort by creation time', () => {
  const a = core.newId('e', T0), b = core.newId('e', T0 + 1000);
  assert.ok(a < b);
  assert.equal(a.length, b.length);
});

test('serialize writes one record per line and round-trips', () => {
  let doc = log(sample(), 'ree', '2026-10-27', [' up to no head ', 'brr', 'brr'], T0 + 10, { lesson: true });
  doc = core.setDay(doc, '2026-10-26', { label: 'shabbat' }, T0 + 11);
  const text = core.serialize(doc);
  const entryLine = text.split('\n').find((l) => l.includes('"variations":["up'));
  assert.match(entryLine, /^ {4}\{"id":"e[0-9a-z]+","date":"2026-10-27","exercise":"x[0-9a-z]+","variations":\["up to no head","brr"\],"lesson":true,"note":"","updated":"2026-10-27T18:00:00.010Z"\}$/);
  assert.equal(core.serialize(core.validate(JSON.parse(text))), text);
  assert.match(text, /"categories": \[\n {4}\{"id":"breathing","name":"Breathing","order":1,/);
});

test('version 1 files are upgraded on load', () => {
  const v1 = {
    app: 'practice-log', version: 1,
    exercises: [{ id: 'kiti', name: 'kiti', group: 'exercises', archived: false, order: 1, updated: 'x' },
      { id: 'sfch', name: 'sfch', group: 'breathing', archived: false, order: 2, updated: 'x' }],
    days: [],
    entries: [{ id: 'e1', date: '2026-10-01', exercise: 'kiti', variation: 'up and down', note: '', updated: 'x' },
      { id: 'e2', date: '2026-10-02', exercise: 'kiti', variation: '', note: '', updated: 'x' }],
  };
  const doc = core.validate(v1);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.entries.map((e) => e.variations), [['up and down'], []]);
  assert.equal(doc.entries[0].variation, undefined);
  assert.deepEqual(doc.exercises.map((x) => x.category), ['exercises', 'breathing']);
  assert.deepEqual(doc.categories.map((c) => c.name), ['Breathing', 'Exercises']);
});

test('merge is a union where the newer copy of a record wins', () => {
  const base = sample();
  const { doc: a, entry } = core.addEntry(base, { date: '2026-10-27', exercise: idOf(base, 'ree') }, T0 + 100);
  const b = log(base, 'basic scale', '2026-10-27', ['a4'], T0 + 200);
  const edited = core.editEntry(a, entry.id, { variations: ['down'] }, T0 + 300);
  const m = core.merge(b, edited);
  assert.equal(m.entries.length, 2);
  assert.deepEqual(m.entries.find((e) => e.id === entry.id).variations, ['down']);
  assert.ok(core.sameDoc(m, core.merge(edited, b)));
  assert.ok(core.sameDoc(m, core.merge(m, b)));
  assert.deepEqual(core.merge(edited, a).entries.find((e) => e.id === entry.id).variations, ['down']);
});

test('a deletion survives merging with a copy that still has the entry', () => {
  const base = sample();
  const { doc: withEntry, entry } = core.addEntry(base, { date: '2026-10-27', exercise: idOf(base, 'ree') }, T0 + 100);
  const deleted = core.deleteEntry(withEntry, entry.id, T0 + 200);
  const m = core.merge(withEntry, deleted);
  assert.equal(core.entriesOn(m, '2026-10-27').length, 0);
  const restored = core.restoreEntry(m, entry.id, T0 + 300);
  assert.equal(core.entriesOn(restored, '2026-10-27').length, 1);
  assert.equal('deleted' in restored.entries[0], false);
});

test('equal timestamps resolve the same way on both sides', () => {
  const x = { id: 'e1', date: '2026-10-27', exercise: 'a', variations: ['one'], note: '', updated: '2026-10-27T00:00:00.000Z' };
  const y = { ...x, variations: ['two'] };
  const d1 = { ...core.emptyDoc(), entries: [x] }, d2 = { ...core.emptyDoc(), entries: [y] };
  assert.ok(core.sameDoc(core.merge(d1, d2), core.merge(d2, d1)));
});

test('validate rejects files it should not overwrite', () => {
  assert.throws(() => core.validate([]), /not a JSON object/);
  assert.throws(() => core.validate({ app: 'ear-trainer' }), /not this app/);
  assert.throws(() => core.validate({ app: 'practice-log', version: 99 }), /newer/);
  assert.throws(() => core.validate({ entries: [{ id: 'a', date: 'nope', updated: 'x' }] }), /bad date/);
  assert.throws(() => core.validate({ entries: [{ date: '2026-01-01' }] }), /no id/);
  assert.deepEqual(core.validate({}), core.emptyDoc());
});

test('stats: per exercise and per variation, ignoring deleted and later entries', () => {
  let doc = sample();
  doc = log(doc, 'basic scale', '2026-09-01', ['g4'], T0 + 1);
  doc = log(doc, 'basic scale', '2026-09-15', ['g#4'], T0 + 2);
  doc = log(doc, 'basic scale', '2026-10-01', ['g4', 'up and down'], T0 + 3);
  doc = log(doc, 'basic scale', '2026-10-10', [], T0 + 4);
  doc = log(doc, 'basic scale', '2026-10-20', ['a4'], T0 + 5);
  doc = core.deleteEntry(doc, doc.entries[doc.entries.length - 1].id, T0 + 6);
  const s = core.exerciseStats(doc, '2026-10-27').get(idOf(doc, 'basic scale'));
  assert.equal(s.last, '2026-10-10');
  assert.equal(s.daysSince, 17);
  assert.equal(s.count, 4);
  assert.deepEqual(s.lastVariations, []);
  assert.equal(s.tags.get('g4').count, 2);
  assert.equal(s.tags.get('g4').daysSince, 26);
  assert.equal(s.plain.count, 1);
  assert.equal(s.tags.has('a4'), false);
  const asOf = core.exerciseStats(doc, '2026-09-20').get(idOf(doc, 'basic scale'));
  assert.equal(asOf.count, 2);
  assert.equal(core.exerciseStats(doc, '2026-10-27').get(idOf(doc, 'ree')).daysSince, null);
});

test('lesson entries can be left out of the stats', () => {
  let doc = sample();
  doc = log(doc, 'ree', '2026-10-01', [], T0 + 1);
  doc = log(doc, 'ree', '2026-10-20', [], T0 + 2, { lesson: true });
  assert.equal(core.exerciseStats(doc, '2026-10-27').get(idOf(doc, 'ree')).daysSince, 7);
  assert.equal(core.exerciseStats(doc, '2026-10-27', { lessons: false }).get(idOf(doc, 'ree')).daysSince, 26);
});

test('variation choices: plain, then the exercise list in order, then the rest by recency', () => {
  let doc = sample();
  const id = idOf(doc, 'ree');
  doc = core.addVariation(doc, id, 'up to no head', T0 + 1);
  doc = core.addVariation(doc, id, 'down', T0 + 2);
  doc = log(doc, 'ree', '2026-10-01', ['brr'], T0 + 3);
  doc = log(doc, 'ree', '2026-10-05', ['down'], T0 + 4);
  doc = log(doc, 'ree', '2026-10-06', [], T0 + 5);
  doc = log(doc, 'ree', '2026-10-07', ['aaa'], T0 + 6);
  const ex = doc.exercises.find((x) => x.id === id);
  const choices = core.variationChoices(ex, core.exerciseStats(doc, '2026-10-10').get(id));
  assert.deepEqual(choices.map((c) => [c.name, c.daysSince]), [['', 4], ['up to no head', null], ['down', 5], ['aaa', 3], ['brr', 9]]);
  assert.equal(choices[0].plain, true);
});

test('renaming a variation renames it everywhere, and can merge two', () => {
  let doc = sample();
  const id = idOf(doc, 'sfch');
  doc = core.addVariation(doc, id, 'no random', T0);
  doc = log(doc, 'sfch', '2026-10-01', ['no random'], T0 + 1);
  doc = log(doc, 'sfch', '2026-10-02', ['set order', 'songs'], T0 + 2);
  doc = log(doc, 'sfch', '2026-10-03', [], T0 + 3);
  doc = core.renameVariation(doc, id, 'no random', 'set order', T0 + 10);
  assert.deepEqual(core.entriesOf(doc, id).map((e) => e.variations), [['set order'], ['set order', 'songs'], []]);
  assert.deepEqual(doc.exercises.find((x) => x.id === id).variations, ['set order']);
  doc = core.renameVariation(doc, id, '', 'random order', T0 + 11); // name the plain ones
  assert.deepEqual(core.entriesOf(doc, id).map((e) => e.variations)[2], ['random order']);
  assert.deepEqual(doc.exercises.find((x) => x.id === id).variations, ['random order', 'set order']);
});

test('combining exercises moves the history and tags it', () => {
  let doc = sample();
  ({ doc } = core.addExercise(doc, { name: 'evil laugh 1', category: 'exercises' }, T0 + 5));
  ({ doc } = core.addExercise(doc, { name: 'evil laugh', category: 'exercises' }, T0 + 6));
  doc = core.editExercise(doc, idOf(doc, 'evil laugh'), { archived: true }, T0 + 7);
  doc = log(doc, 'evil laugh 1', '2026-10-01', ['random'], T0 + 8);
  doc = log(doc, 'evil laugh 1', '2026-10-03', [], T0 + 9);
  const from = idOf(doc, 'evil laugh 1'), into = idOf(doc, 'evil laugh');
  const before = doc;
  doc = core.combineExercises(doc, from, into, '1', T0 + 20);
  assert.deepEqual(core.entriesOf(doc, into).map((e) => e.variations), [['1', 'random'], ['1']]);
  assert.equal(core.entriesOf(doc, from).length, 0);
  assert.equal(doc.exercises.find((x) => x.id === from).deleted, true);
  const target = doc.exercises.find((x) => x.id === into);
  assert.deepEqual(target.variations, ['1']);
  assert.equal(target.archived, false, 'an archived target comes back when an active one joins it');
  assert.match(core.describeChanges(before, doc), /evil laugh/);
  // Undo puts everything back, with newer times so it also wins against older copies.
  const undone = core.revert(doc, before, T0 + 30);
  assert.equal(core.entriesOf(undone, from).length, 2);
  assert.equal(undone.exercises.find((x) => x.id === from).deleted, undefined);
  assert.ok(core.sameDoc(core.merge(doc, undone), undone));
});

test('revert removes records added after the snapshot', () => {
  const before = sample();
  let doc = log(before, 'ree', '2026-10-01', [], T0 + 1);
  doc = core.setDay(doc, '2026-10-02', { label: 'busy' }, T0 + 2);
  const back = core.revert(doc, before, T0 + 3);
  assert.equal(core.live(back).length, 0);
  assert.equal(core.dayOf(back, '2026-10-02').label, '');
});

test('categories: add, reorder, delete moving exercises', () => {
  let doc = sample();
  let cat;
  ({ doc, category: cat } = core.addCategory(doc, { name: 'Lesson' }, T0 + 1));
  assert.deepEqual(core.liveCategories(doc).map((c) => c.name), ['Breathing', 'Exercises', 'Lesson']);
  doc = core.moveCategory(doc, cat.id, -1, T0 + 2);
  assert.deepEqual(core.liveCategories(doc).map((c) => c.name), ['Breathing', 'Lesson', 'Exercises']);
  doc = core.editExercise(doc, idOf(doc, 'ree'), { category: cat.id }, T0 + 3);
  doc = core.deleteCategory(doc, cat.id, 'exercises', T0 + 4);
  assert.deepEqual(core.liveCategories(doc).map((c) => c.name), ['Breathing', 'Exercises']);
  assert.equal(doc.exercises.find((x) => x.name === 'ree').category, 'exercises');
});

test('only exercises without history can be deleted', () => {
  let doc = log(sample(), 'ree', '2026-10-01');
  assert.throws(() => core.deleteExercise(doc, idOf(doc, 'ree')), /entries/);
  doc = core.deleteExercise(doc, idOf(doc, 'basic scale'), T0 + 5);
  assert.equal(core.liveExercises(doc).length, 2);
});

test('day labels and notes', () => {
  let doc = sample();
  doc = core.setDay(doc, '2026-10-24', { label: 'shabbat' }, T0 + 1);
  doc = core.setDay(doc, '2026-10-17', { label: 'shabbat' }, T0 + 2);
  doc = core.setDay(doc, '2026-10-23', { label: ' busy ' }, T0 + 3);
  assert.deepEqual(core.labelsByUse(doc), ['shabbat', 'busy']);
  assert.equal(core.setDay(doc, '2026-10-23', { label: 'busy' }, T0 + 4), doc, 'no change, no new record');
  assert.equal(core.setDay(doc, '2026-10-01', { label: '', note: '' }, T0 + 5), doc, 'empty day is not created');
  assert.deepEqual(core.activeDates(doc), ['2026-10-24', '2026-10-23', '2026-10-17']);
});

test('moving exercises swaps neighbours within a category', () => {
  let doc = sample();
  doc = core.moveExercise(doc, idOf(doc, 'ree'), -1, T0 + 10);
  const order = core.liveExercises(doc).filter((e) => e.category === 'exercises').sort(core.byOrder).map((e) => e.name);
  assert.deepEqual(order, ['ree', 'basic scale']);
  assert.equal(core.moveExercise(doc, idOf(doc, 'ree'), -1, T0 + 11), doc, 'already first');
});

test('numbers in variations: pitches and seconds', () => {
  assert.deepEqual(core.measure('g#4'), { kind: 'pitch', value: 68 });
  assert.deepEqual(core.measure('up to d4'), { kind: 'pitch', value: 62 });
  assert.deepEqual(core.measure('bb3'), { kind: 'pitch', value: 58 });
  assert.deepEqual(core.measure('35s then 37s'), { kind: 'seconds', value: 35 });
  assert.equal(core.measure('up and down'), null);
  assert.equal(core.pitchName(70), 'a#4');
  let doc = sample();
  for (const [i, v] of [['g4'], ['random'], ['g#4', 'up and down'], ['a4']].entries()) doc = log(doc, 'basic scale', `2026-10-0${i + 1}`, v, T0 + i);
  const p = core.progress(doc, idOf(doc, 'basic scale'));
  assert.equal(p.kind, 'pitch');
  assert.deepEqual(p.points.map((x) => x.value), [67, 68, 69]);
});

test('staleness colours get darker with time and never run out', () => {
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
  const days = [7, 14, 21, 35, 60, 90, 120];
  const l = days.map((d) => lum(core.staleColor(d)));
  for (let i = 1; i < l.length; i++) assert.ok(l[i] < l[i - 1], `day ${days[i]} should be darker than ${days[i - 1]}`);
  assert.notEqual(core.staleColor(30), core.staleColor(45));
  assert.equal(core.staleColor(null), core.staleColor(500));
});

test('tile text stays readable on every fill', () => {
  for (const theme of ['light', 'dark']) {
    for (let d = 0; d <= 150; d++) {
      const fill = core.staleColor(d, theme);
      assert.ok(core.contrast(fill, core.textOn(fill)) >= 4.5, `${theme} day ${d}`);
    }
  }
});

test('commit messages say what changed', () => {
  const base = sample();
  const one = log(base, 'ree', '2026-10-27', ['up to no head', 'brr'], T0 + 1);
  assert.equal(core.describeChanges(base, one), '2026-10-27: ree (up to no head, brr)');
  assert.equal(core.describeChanges(base, core.setDay(base, '2026-10-24', { label: 'shabbat' }, T0 + 2)), '2026-10-24: shabbat');
  const del = core.deleteEntry(one, one.entries[0].id, T0 + 3);
  assert.equal(core.describeChanges(one, del), '2026-10-27: remove ree (up to no head, brr)');
  assert.equal(core.describeChanges(del, core.restoreEntry(del, one.entries[0].id, T0 + 4)), '2026-10-27: ree (up to no head, brr)');
  assert.equal(core.describeChanges(base, core.editExercise(base, idOf(base, 'ree'), { name: 'ree ree' }, T0 + 6)), 'Update ree ree');
  let bulk = base;
  for (let i = 1; i <= 9; i++) bulk = log(bulk, 'ree', `2026-10-0${i}`, [], T0 + 10 + i);
  assert.equal(core.describeChanges(base, bulk), 'Log 9 exercises on 9 days');
  assert.equal(core.describeChanges(base, base), 'Update practice log');
});

test('starting over: the new file wins everywhere, old records are marked deleted', () => {
  let old = log(sample(), 'ree', '2026-10-01', [], T0 + 1);
  old = core.editExercise(old, idOf(old, 'ree'), { name: 'ree edited later' }, T0 + 500);
  let fresh = core.ensureCategories(core.emptyDoc(), T0);
  ({ doc: fresh } = core.addExercise(fresh, { name: 'kiki', category: 'exercises' }, T0 + 2));
  const kept = old.exercises.find((x) => x.name === 'basic scale');
  fresh = { ...fresh, exercises: [...fresh.exercises, { ...kept, name: 'basic scale (new file)', updated: core.stamp(T0) }] };
  const next = core.replaceWith(old, fresh, T0 + 1000);
  assert.deepEqual(core.liveExercises(next).map((x) => x.name).sort(), ['basic scale (new file)', 'kiki']);
  assert.equal(core.live(next).length, 0);
  // An old copy elsewhere can't bring anything back.
  const mergedWithOld = core.merge(old, next);
  assert.ok(core.sameDoc(mergedWithOld, next));
});
