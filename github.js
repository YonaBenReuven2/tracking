/* Practice log: keeping the log in a GitHub repo, through the REST "contents" API.
 * Every save reads the file, merges, and writes it back with the sha it read. If something
 * else wrote in between, GitHub refuses the write and we merge again, so nothing is lost. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.PLCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PLSync = api;
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function decodeBase64Utf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  class SyncError extends Error {
    constructor(kind, message, status) {
      super(message);
      this.kind = kind; // offline | auth | notfound | conflict | invalid | ratelimit | http
      this.status = status;
    }
  }

  function makeClient({ owner, repo, branch = 'main', path = 'log.json', token, fetch: fetchFn }) {
    const doFetch = fetchFn || ((...a) => fetch(...a));
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const filePath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');

    async function call(url, opts = {}) {
      const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
      if (opts.body) headers['Content-Type'] = 'application/json';
      try {
        // no-store: GitHub marks these responses cacheable for 60 s, and a stale read
        // would make every save look like a conflict.
        return await doFetch(url, { ...opts, headers, cache: 'no-store' });
      } catch (e) {
        throw new SyncError('offline', "Can't reach GitHub. Changes are kept on this computer and will sync when you're online.");
      }
    }

    async function fail(res, doing) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch (e) { /* not JSON */ }
      const s = res.status;
      if (s === 401) throw new SyncError('auth', 'GitHub rejected the token. It may have expired: make a new one and paste it in Settings.', s);
      if (s === 429 || (s === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(msg)))) {
        throw new SyncError('ratelimit', 'GitHub is limiting requests for now. Sync will try again in a few minutes.', s);
      }
      if (s === 403) throw new SyncError('auth', `The token isn't allowed to ${doing}. Give it "Contents: Read and write" on ${owner}/${repo}.`, s);
      if (s === 404) throw new SyncError('notfound', `Can't find ${owner}/${repo}. Check the name, and that the token has access to that repo.`, s);
      if (s === 409 || (s === 422 && /sha/i.test(msg))) throw new SyncError('conflict', msg || 'The file changed on GitHub.', s);
      throw new SyncError('http', `GitHub answered ${s} while trying to ${doing}${msg ? `: ${msg}` : ''}.`, s);
    }

    async function checkRepo() {
      const res = await call(base);
      if (!res.ok) await fail(res, 'read the repo');
      const j = await res.json();
      return { fullName: j.full_name, private: !!j.private, defaultBranch: j.default_branch };
    }

    /** {exists, sha, doc}. With {anyContent: true} a file that isn't a valid log comes back
     *  as {exists: true, sha, doc: null} instead of failing (used when starting over). */
    async function read({ anyContent = false } = {}) {
      const res = await call(`${base}/contents/${filePath}?ref=${encodeURIComponent(branch)}`);
      if (res.status === 404) {
        await checkRepo(); // throws if it's the repo (or the token) that's missing, not the file
        return { exists: false, sha: null, doc: null };
      }
      if (!res.ok) await fail(res, 'read the log');
      const j = await res.json();
      if (Array.isArray(j) || j.type !== 'file') throw new SyncError('invalid', `${path} in ${repo} is a folder, not a file.`);
      let b64 = j.encoding === 'base64' ? j.content : '';
      if (!b64) {
        // Files over 1 MB come back without content; the blob endpoint serves up to 100 MB.
        const br = await call(`${base}/git/blobs/${j.sha}`);
        if (!br.ok) await fail(br, 'read the log');
        b64 = (await br.json()).content;
      }
      let doc;
      try {
        doc = core.validate(JSON.parse(decodeBase64Utf8(b64)));
      } catch (e) {
        if (anyContent) return { exists: true, sha: j.sha, doc: null };
        throw new SyncError('invalid', `${path} in ${owner}/${repo} isn't a log this app can read (${e.message}). Nothing was changed on GitHub.`);
      }
      return { exists: true, sha: j.sha, doc };
    }

    async function write(doc, sha, message) {
      const body = { message, content: encodeBase64Utf8(core.serialize(doc)), branch };
      if (sha) body.sha = sha;
      const res = await call(`${base}/contents/${filePath}`, { method: 'PUT', body: JSON.stringify(body) });
      if (!res.ok) await fail(res, 'save the log');
      const j = await res.json();
      return j.content && j.content.sha;
    }

    return { read, write, checkRepo };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Bring GitHub and the local copy together. Returns {doc, sha, pushed, message?}.
   * `doc` is the merged log; the caller merges it into whatever it holds now.
   * Options: `message(before, after)` overrides the commit message; `replace: true` writes
   * the local copy over whatever is on GitHub, without merging (starting over).
   */
  async function sync(client, local, { attempts = 4, wait = sleep, message = null, replace = false } = {}) {
    for (let attempt = 1; ; attempt++) {
      if (replace) {
        const remote = await client.read({ anyContent: true });
        try {
          const sha = await client.write(local, remote.sha, (message && message(remote.doc || core.emptyDoc(), local)) || 'Start over');
          return { doc: local, sha, pushed: true };
        } catch (e) {
          if (e.kind === 'conflict' && attempt < attempts) { await wait(400 * 2 ** (attempt - 1)); continue; }
          throw e;
        }
      }
      const remote = await client.read();
      const merged = core.merge(remote.exists ? remote.doc : core.emptyDoc(), local);
      if (remote.exists && core.sameDoc(merged, remote.doc)) return { doc: merged, sha: remote.sha, pushed: false };
      if (!remote.exists && core.isEmpty(merged)) return { doc: merged, sha: null, pushed: false };
      const custom = message && message(remote.exists ? remote.doc : core.emptyDoc(), merged);
      const message_ = custom || (remote.exists ? core.describeChanges(remote.doc, merged) : 'Start the practice log');
      try {
        const sha = await client.write(merged, remote.sha, message_);
        return { doc: merged, sha, pushed: true, message: message_ };
      } catch (e) {
        if (e.kind === 'conflict' && attempt < attempts) {
          await wait(400 * 2 ** (attempt - 1));
          continue;
        }
        throw e;
      }
    }
  }

  return { makeClient, sync, SyncError, encodeBase64Utf8, decodeBase64Utf8 };
});
