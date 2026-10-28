// An in-memory stand-in for the bits of the GitHub REST API the app uses.
const crypto = require('node:crypto');

function fakeGitHub({ owner = 'me', repo = 'tracking-data', token = 'tok', largeFiles = false } = {}) {
  const files = new Map(); // path -> {text, sha}
  const commits = [];
  const requests = [];
  const state = { offline: false, beforeWrite: null, repoExists: true };

  const sha = (text) => crypto.createHash('sha1').update(text).digest('hex');
  const json = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  });
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');

  async function fetch(url, opts = {}) {
    requests.push({ url, method: opts.method || 'GET', opts });
    if (state.offline) throw new TypeError('Failed to fetch');
    if (opts.headers.Authorization !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    const u = new URL(url);
    const prefix = `/repos/${owner}/${repo}`;
    if (!state.repoExists || !u.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const rest = u.pathname.slice(prefix.length);
    if (rest === '') return json(200, { full_name: `${owner}/${repo}`, private: true, default_branch: 'main' });
    if (rest.startsWith('/git/blobs/')) {
      const id = rest.split('/').pop();
      const f = [...files.values()].find((x) => x.sha === id);
      return f ? json(200, { sha: f.sha, content: b64(f.text), encoding: 'base64' }) : json(404, { message: 'Not Found' });
    }
    const path = decodeURIComponent(rest.replace(/^\/contents\//, ''));
    const method = opts.method || 'GET';
    if (method === 'GET') {
      const f = files.get(path);
      if (!f) return json(404, { message: 'Not Found' });
      if (largeFiles) return json(200, { type: 'file', sha: f.sha, content: '', encoding: 'none' });
      return json(200, { type: 'file', sha: f.sha, content: b64(f.text), encoding: 'base64' });
    }
    if (method === 'PUT') {
      if (state.beforeWrite) { const hook = state.beforeWrite; state.beforeWrite = null; await hook(); }
      const body = JSON.parse(opts.body);
      const f = files.get(path);
      if (f && !body.sha) return json(422, { message: '"sha" wasn\'t supplied.' });
      if (f && body.sha !== f.sha) return json(409, { message: `${path} does not match ${body.sha}` });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      const next = { text, sha: sha(text) };
      files.set(path, next);
      commits.push({ message: body.message, text });
      return json(f ? 200 : 201, { content: { sha: next.sha } });
    }
    return json(405, { message: 'Method not allowed' });
  }

  return {
    fetch, files, commits, requests, state,
    put(path, text) { files.set(path, { text, sha: sha(text) }); },
    text(path) { return files.get(path) && files.get(path).text; },
  };
}

module.exports = { fakeGitHub };
