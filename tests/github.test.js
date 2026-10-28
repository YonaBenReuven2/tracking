// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');
const gh = require('../github.js');
const { fakeGitHub } = require('./fake-github.js');

const T0 = Date.UTC(2026, 9, 27, 18, 0, 0);
const cfg = (fake, extra = {}) => ({ owner: 'me', repo: 'tracking-data', token: 'tok', fetch: fake.fetch, ...extra });
const noWait = { wait: async () => {} };

function docWith(names, t = T0) {
  let doc = core.ensureCategories(core.emptyDoc(), t);
  names.forEach((n, i) => { ({ doc } = core.addExercise(doc, { name: n, category: 'exercises' }, t + i + 1)); });
  return doc;
}
const idOf = (doc, name) => doc.exercises.find((e) => e.name === name).id;

test('base64 round-trips UTF-8, Hebrew included', () => {
  const s = 'א-ת basic scale g#4 … ✓';
  assert.equal(gh.decodeBase64Utf8(gh.encodeBase64Utf8(s)), s);
  const long = 'x'.repeat(200000) + 'א';
  assert.equal(gh.decodeBase64Utf8(gh.encodeBase64Utf8(long)), long);
});

test('first sync creates the file', async () => {
  const fake = fakeGitHub();
  const client = gh.makeClient(cfg(fake));
  const local = docWith(['ree']);
  const r = await gh.sync(client, local, noWait);
  assert.equal(r.pushed, true);
  assert.equal(fake.commits[0].message, 'Start the practice log');
  assert.equal(fake.text('log.json'), core.serialize(local));
});

test('an empty local copy and no file does nothing', async () => {
  const fake = fakeGitHub();
  const r = await gh.sync(gh.makeClient(cfg(fake)), core.emptyDoc(), noWait);
  assert.equal(r.pushed, false);
  assert.equal(fake.commits.length, 0);
});

test('nothing new means no commit', async () => {
  const fake = fakeGitHub();
  const local = docWith(['ree']);
  fake.put('log.json', core.serialize(local));
  const r = await gh.sync(gh.makeClient(cfg(fake)), local, noWait);
  assert.equal(r.pushed, false);
  assert.equal(fake.commits.length, 0);
});

test('remote and local changes are merged, with a descriptive commit', async () => {
  const fake = fakeGitHub();
  const base = docWith(['ree', 'brr']);
  const [ree, brr] = [idOf(base, 'ree'), idOf(base, 'brr')];
  const remote = core.addEntry(base, { date: '2026-10-26', exercise: brr }, T0 + 50).doc;
  fake.put('log.json', core.serialize(remote));
  const local = core.addEntry(base, { date: '2026-10-27', exercise: ree, variations: ['down'] }, T0 + 60).doc;
  const r = await gh.sync(gh.makeClient(cfg(fake)), local, noWait);
  assert.equal(r.doc.entries.length, 2);
  assert.equal(fake.commits[0].message, '2026-10-27: ree (down)');
  assert.equal(core.validate(JSON.parse(fake.text('log.json'))).entries.length, 2);
});

test('a write from elsewhere in the middle of a save is merged, not lost', async () => {
  const fake = fakeGitHub();
  const base = docWith(['ree', 'brr']);
  const [ree, brr] = [idOf(base, 'ree'), idOf(base, 'brr')];
  fake.put('log.json', core.serialize(base));
  const other = core.addEntry(base, { date: '2026-10-27', exercise: brr }, T0 + 70).doc;
  fake.state.beforeWrite = () => fake.put('log.json', core.serialize(other)); // someone else saves first
  const local = core.addEntry(base, { date: '2026-10-27', exercise: ree }, T0 + 80).doc;
  const r = await gh.sync(gh.makeClient(cfg(fake)), local, noWait);
  assert.equal(r.pushed, true);
  const saved = core.validate(JSON.parse(fake.text('log.json')));
  assert.equal(saved.entries.length, 2);
  assert.ok(fake.requests.filter((q) => q.method === 'PUT').length === 2);
});

test('gives up after repeated conflicts', async () => {
  const fake = fakeGitHub();
  const base = docWith(['ree']);
  fake.put('log.json', core.serialize(base));
  const client = gh.makeClient(cfg(fake));
  const realWrite = client.write;
  let tries = 0;
  client.write = async () => { tries++; throw new gh.SyncError('conflict', 'x', 409); };
  const local = core.addEntry(base, { date: '2026-10-27', exercise: idOf(base, 'ree') }, T0 + 1).doc;
  await assert.rejects(gh.sync(client, local, { attempts: 3, wait: async () => {} }), (e) => e.kind === 'conflict');
  assert.equal(tries, 3);
  client.write = realWrite;
});

test('large files are read through the blob endpoint', async () => {
  const fake = fakeGitHub({ largeFiles: true });
  const local = docWith(['ree']);
  fake.put('log.json', core.serialize(local));
  const r = await gh.makeClient(cfg(fake)).read();
  assert.equal(r.exists, true);
  assert.ok(core.sameDoc(r.doc, local));
  assert.ok(fake.requests.some((q) => q.url.includes('/git/blobs/')));
});

test('a file the app cannot read is never overwritten', async () => {
  const fake = fakeGitHub();
  fake.put('log.json', '{ this is not json');
  await assert.rejects(gh.sync(gh.makeClient(cfg(fake)), docWith(['ree']), noWait), (e) => e.kind === 'invalid');
  assert.equal(fake.commits.length, 0);
  assert.equal(fake.text('log.json'), '{ this is not json');
});

test('errors say what to fix', async () => {
  const fake = fakeGitHub();
  await assert.rejects(gh.makeClient(cfg(fake, { token: 'wrong' })).read(), (e) => e.kind === 'auth' && /token/.test(e.message));
  fake.state.repoExists = false;
  await assert.rejects(gh.makeClient(cfg(fake)).read(), (e) => e.kind === 'notfound' && /me\/tracking-data/.test(e.message));
  fake.state.offline = true;
  await assert.rejects(gh.makeClient(cfg(fake)).read(), (e) => e.kind === 'offline');
});

test('requests skip the browser cache and carry the token', async () => {
  const fake = fakeGitHub();
  await gh.makeClient(cfg(fake)).read();
  for (const q of fake.requests) {
    assert.equal(q.opts.cache, 'no-store');
    assert.equal(q.opts.headers.Authorization, 'Bearer tok');
  }
});

test('custom branch and file path go into the URLs', async () => {
  const fake = fakeGitHub();
  const client = gh.makeClient(cfg(fake, { branch: 'data', path: 'logs/singing log.json' }));
  await client.write(docWith(['ree']), null, 'x');
  const put = fake.requests.find((q) => q.method === 'PUT');
  assert.ok(put.url.endsWith('/contents/logs/singing%20log.json'));
  assert.equal(JSON.parse(put.opts.body).branch, 'data');
});

test('a custom commit message wins over the generated one', async () => {
  const fake = fakeGitHub();
  const base = docWith(['ree']);
  fake.put('log.json', core.serialize(base));
  const local = core.editExercise(base, idOf(base, 'ree'), { name: 'ree 2' }, T0 + 9);
  await gh.sync(gh.makeClient(cfg(fake)), local, { ...noWait, message: () => 'Combine ree into ree 2' });
  assert.equal(fake.commits[0].message, 'Combine ree into ree 2');
});

test('starting over replaces the file instead of merging, even an unreadable one', async () => {
  const fake = fakeGitHub();
  fake.put('log.json', core.serialize(docWith(['old one', 'another'])));
  const fresh = docWith(['ree']);
  const r = await gh.sync(gh.makeClient(cfg(fake)), fresh, { ...noWait, replace: true, message: () => 'Start over from log.json' });
  assert.equal(r.pushed, true);
  assert.equal(fake.text('log.json'), core.serialize(fresh));
  assert.equal(fake.commits[0].message, 'Start over from log.json');
  fake.put('log.json', 'not json');
  await gh.sync(gh.makeClient(cfg(fake)), fresh, { ...noWait, replace: true });
  assert.equal(fake.text('log.json'), core.serialize(fresh));
});
