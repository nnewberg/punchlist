import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../shared/types';
import { createSession } from '../worker/auth';
import { prefixFor, ROLE_FRESH_MS } from '../worker/directory';
import worker from '../worker/index';

// Sign-in, sessions, access and the App webhook, run against the Worker as production would: no dev
// stub, and a fake GitHub behind `fetch`.

const ORIGIN = 'https://punchlist.example.workers.dev';
const INSTALL = 77;
const WEBHOOK_SECRET = 'whsec';

let prod: Env;
/** What the fake GitHub says each login's permission is, per repo: `${repo}:${login}` → permission. */
let perms: Record<string, string>;
let repos: { id: number; name: string; owner: { login: string } }[];
let ghCalls: string[];

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer;
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
  prod = {
    ...env,
    DEV_MODE: '0',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csecret',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  perms = {};
  repos = [
    { id: 501, name: 'big-talk', owner: { login: 'futureleisurefoundation' } },
    { id: 502, name: 'bulletin-bee', owner: { login: 'nnewberg' } },
  ];
  ghCalls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    ghCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body));
      return body.code === 'good' ? json({ access_token: 'user-token' }) : json({ error: 'bad_verification_code' });
    }
    if (url.pathname === '/user') return json({ id: 9, login: 'Aaron-T', name: 'Aaron', avatar_url: 'https://avatars.githubusercontent.com/u/9' });
    if (url.pathname === `/app/installations/${INSTALL}/access_tokens`) return json({ token: 'inst-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (url.pathname === '/app/installations') return json([{ id: INSTALL, account: { login: 'nnewberg' } }]);
    if (url.pathname === '/installation/repositories') return json({ repositories: repos });
    const m = /^\/repos\/[^/]+\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
    if (m) {
      const p = perms[`${m[1]}:${m[2]}`];
      return p ? json({ permission: p }) : json({ message: 'Not Found' }, 404);
    }
    return json({ message: `unexpected ${url.pathname}` }, 500);
  });
});

afterEach(() => vi.unstubAllGlobals());

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }) as Request<unknown, IncomingRequestCfProperties>, prod, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedBoards() {
  for (const r of repos) {
    await env.DB.prepare(`INSERT OR REPLACE INTO boards (repo_id, owner, repo, prefix, installation_id, archived_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .bind(r.id, r.owner.login, r.name, prefixFor(r.name), INSTALL, new Date().toISOString()).run();
  }
}

async function signedIn(login = 'aaron-t', id = 9) {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, login, name, avatar_url, created_at) VALUES (?, ?, 'Aaron', NULL, ?)`).bind(id, login, new Date().toISOString()).run();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM access WHERE user_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
  ]);
  return `__Host-pl_session=${await createSession(prod, id)}`;
}

describe('prefixes', () => {
  it('come from the repo name', () => {
    expect(prefixFor('big-talk')).toBe('BT');
    expect(prefixFor('bulletin-bee')).toBe('BB');
    expect(prefixFor('punchlist')).toBe('PL');
    expect(prefixFor('widgets')).toBe('WI');
  });
});

describe('sign-in (FR-3)', () => {
  it('goes through GitHub and comes back with a session', async () => {
    const login = await call('/auth/login?next=/futureleisurefoundation/big-talk');
    expect(login.status).toBe(302);
    const to = new URL(login.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    const state = to.searchParams.get('state')!;
    const oauth = login.headers.getSetCookie().find(c => c.startsWith('__Host-pl_oauth='))!.split(';')[0]!;

    const back = await call(`/auth/callback?code=good&state=${state}`, { cookie: oauth });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/futureleisurefoundation/big-talk');
    const cookies = back.headers.getSetCookie();
    const session = cookies.find(c => c.startsWith('__Host-pl_session='))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Max-Age=7776000/);
    expect(cookies.some(c => c.startsWith('pl_known=1'))).toBe(true);
    // The GitHub login is kept lowercase; no GitHub token is stored anywhere.
    expect(await env.DB.prepare(`SELECT login FROM users WHERE id = 9`).first('login')).toBe('aaron-t');

    const me = await call('/v1/me', { cookie: session.split(';')[0] });
    expect(me.status).toBe(200);
    expect(((await me.json()) as Me).user).toBe('aaron-t');
  });

  it('rejects a callback whose state does not match', async () => {
    const res = await call('/auth/callback?code=good&state=forged', { cookie: '__Host-pl_oauth=real.%2F' });
    expect(res.status).toBe(400);
    expect(ghCalls).toEqual([]);
  });

  it('only returns to paths on this site', async () => {
    const login = await call('/auth/login?next=//evil.example');
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const oauth = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const back = await call(`/auth/callback?code=good&state=${state}`, { cookie: oauth });
    expect(back.headers.get('location')).toBe('/');
  });
});

describe('sessions (FR-3a)', () => {
  it('signed out is 401', async () => {
    expect((await call('/v1/me')).status).toBe(401);
  });

  it('an expired session is 401 and is removed', async () => {
    const cookie = await signedIn();
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = 9`).bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await call('/v1/me', { cookie })).status).toBe(401);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 9`).first('n')).toBe(0);
  });

  it('rolls forward at most once a day', async () => {
    await seedBoards();
    const cookie = await signedIn();
    const fresh = await call('/v1/me', { cookie });
    expect(fresh.headers.getSetCookie().some(c => c.startsWith('__Host-pl_session='))).toBe(false);
    await env.DB.prepare(`UPDATE sessions SET refreshed_at = ? WHERE user_id = 9`).bind(new Date(Date.now() - 2 * 86_400_000).toISOString()).run();
    const rolled = await call('/v1/me', { cookie });
    expect(rolled.headers.getSetCookie().some(c => c.startsWith('__Host-pl_session='))).toBe(true);
  });
});

describe('access follows GitHub (FR-2)', () => {
  it('write → edit, read → view, nothing → not found', async () => {
    await seedBoards();
    const cookie = await signedIn();
    perms = { 'big-talk:aaron-t': 'write', 'bulletin-bee:aaron-t': 'read' };
    const me = (await (await call('/v1/me', { cookie })).json()) as Me;
    expect(me.boards.map(b => `${b.repo}:${b.role}`).sort()).toEqual(['big-talk:edit', 'bulletin-bee:view']);

    perms = { 'big-talk:aaron-t': 'write' };
    await env.DB.prepare(`DELETE FROM access WHERE user_id = 9`).run();
    expect((await call('/v1/boards/nnewberg/bulletin-bee', { cookie })).status).toBe(404);
    expect((await call('/v1/boards/nnewberg/no-such-repo', { cookie })).status).toBe(404);
  });

  it('trusts a role for ten minutes, then asks GitHub again', async () => {
    await seedBoards();
    const cookie = await signedIn();
    perms = { 'big-talk:aaron-t': 'write' };
    await call('/v1/boards/futureleisurefoundation/big-talk', { cookie });
    const asked = () => ghCalls.filter(c => c.includes('/collaborators/')).length;
    expect(asked()).toBe(1);
    await call('/v1/boards/futureleisurefoundation/big-talk', { cookie });
    expect(asked()).toBe(1);

    // Write access is taken away; once the cached role is stale, the board disappears.
    perms = {};
    await env.DB.prepare(`UPDATE access SET checked_at = ? WHERE user_id = 9`).bind(new Date(Date.now() - ROLE_FRESH_MS - 1000).toISOString()).run();
    expect((await call('/v1/boards/futureleisurefoundation/big-talk', { cookie })).status).toBe(404);
    expect(asked()).toBe(2);
  });

  it('a viewer cannot change the board, and other sites cannot post as you', async () => {
    await seedBoards();
    const cookie = await signedIn();
    perms = { 'big-talk:aaron-t': 'read', 'bulletin-bee:aaron-t': 'write' };
    const op = JSON.stringify({ op: 'create', title: 'hi' });
    const asViewer = await call('/v1/boards/futureleisurefoundation/big-talk/ops', { method: 'POST', body: op, cookie, headers: { origin: ORIGIN } });
    expect(asViewer.status).toBe(403);
    const crossSite = await call('/v1/boards/nnewberg/bulletin-bee/ops', { method: 'POST', body: op, cookie, headers: { origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403);
    const ok = await call('/v1/boards/nnewberg/bulletin-bee/ops', { method: 'POST', body: op, cookie, headers: { origin: ORIGIN } });
    expect(ok.status).toBe(200);
    // (The board object itself runs with the test runner's dev env, so it holds the sample items.)
    expect(((await ok.json()) as { item: { id: string } }).item.id).toMatch(/^BB-\d+$/);
  });

  it('a viewer’s live connection cannot send changes either', async () => {
    const stub = env.BOARD.get(env.BOARD.idFromName(`repo:${crypto.randomUUID()}`));
    const res = await stub.fetch(new Request('https://x/ws', {
      headers: { Upgrade: 'websocket', 'X-Punch-Board': JSON.stringify({ owner: 'o', repo: 'r', prefix: 'R' }), 'X-Punch-User': 'kevin', 'X-Punch-Role': 'view' },
    }));
    const ws = res.webSocket!;
    ws.accept();
    const reply = new Promise<{ type: string; error?: { code: string } }>(resolve => {
      ws.addEventListener('message', e => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'reject') resolve(msg);
      });
    });
    ws.send(JSON.stringify({ type: 'op', clientOpId: 'c1', op: { op: 'create', title: 'nope' } }));
    expect((await reply).error?.code).toBe('forbidden');
    ws.close();
  });
});

describe('boards come from the GitHub App (FR-1)', () => {
  async function hook(event: string, payload: unknown, secret = WEBHOOK_SECRET) {
    const body = JSON.stringify(payload);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
    return call('/github/webhook', { method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': `sha256=${sig}` } });
  }
  const board = (id: number) => env.DB.prepare(`SELECT owner, repo, prefix, archived_at FROM boards WHERE repo_id = ?`).bind(id).first<{ owner: string; repo: string; prefix: string; archived_at: string | null }>();

  it('rejects a webhook with a bad signature', async () => {
    expect((await hook('installation_repositories', {}, 'wrong')).status).toBe(401);
  });

  it('adding a repo creates its board; removing it archives the board', async () => {
    const installation = { id: INSTALL, account: { login: 'nnewberg' } };
    expect((await hook('installation_repositories', { action: 'added', installation, repositories_added: [{ id: 601, name: 'widget-shop' }] })).status).toBe(204);
    expect(await board(601)).toMatchObject({ owner: 'nnewberg', repo: 'widget-shop', prefix: 'WS', archived_at: null });
    await hook('installation_repositories', { action: 'removed', installation, repositories_removed: [{ id: 601, name: 'widget-shop' }] });
    expect((await board(601))?.archived_at).not.toBeNull();
  });

  it('ignores installs on accounts it does not serve', async () => {
    await hook('installation', { action: 'created', installation: { id: 88, account: { login: 'stranger' } }, repositories: [{ id: 701, name: 'their-repo' }] });
    expect(await board(701)).toBeNull();
  });

  it('follows a rename without losing the board', async () => {
    const installation = { id: INSTALL, account: { login: 'nnewberg' } };
    await hook('installation_repositories', { action: 'added', installation, repositories_added: [{ id: 602, name: 'old-name' }] });
    await hook('repository', { action: 'renamed', installation, repository: { id: 602, name: 'new-name', owner: { login: 'nnewberg' } } });
    expect(await board(602)).toMatchObject({ repo: 'new-name', prefix: 'ON', archived_at: null });
  });
});
