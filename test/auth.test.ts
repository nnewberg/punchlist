import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Me } from '../shared/types';
import { prefixFor, ROLE_FRESH_MS } from '../worker/directory';
import { clearMemo } from '../worker/memo';
import { call, gh, INSTALL, ORIGIN, seedBoards, signedIn, useProdWorker, webhook, WEBHOOK_SECRET } from './harness';

// Sign-in, sessions, access and the App webhook, run against the Worker as production would: no dev
// stub, and a fake GitHub behind `fetch`.

useProdWorker();

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
    expect(gh.calls).toEqual([]);
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
    gh.perms = { 'big-talk:aaron-t': 'write', 'bulletin-bee:aaron-t': 'read' };
    const me = (await (await call('/v1/me', { cookie })).json()) as Me;
    expect(me.boards.map(b => `${b.repo}:${b.role}`).sort()).toEqual(['big-talk:edit', 'bulletin-bee:view']);

    gh.perms = { 'big-talk:aaron-t': 'write' };
    await env.DB.prepare(`DELETE FROM access WHERE user_id = 9`).run();
    expect((await call('/v1/boards/nnewberg/bulletin-bee', { cookie })).status).toBe(404);
    expect((await call('/v1/boards/nnewberg/no-such-repo', { cookie })).status).toBe(404);
  });

  it('trusts a role for ten minutes, then asks GitHub again', async () => {
    await seedBoards();
    const cookie = await signedIn();
    gh.perms = { 'big-talk:aaron-t': 'write' };
    await call('/v1/boards/futureleisurefoundation/big-talk', { cookie });
    const asked = () => gh.calls.filter(c => c.includes('/collaborators/')).length;
    expect(asked()).toBe(1);
    await call('/v1/boards/futureleisurefoundation/big-talk', { cookie });
    expect(asked()).toBe(1);

    // Write access is taken away; once the cached role is stale, the board disappears.
    gh.perms = {};
    await env.DB.prepare(`UPDATE access SET checked_at = ? WHERE user_id = 9`).bind(new Date(Date.now() - ROLE_FRESH_MS - 1000).toISOString()).run();
    clearMemo(); // and the Worker's one-minute memory of it has lapsed too
    expect((await call('/v1/boards/futureleisurefoundation/big-talk', { cookie })).status).toBe(404);
    expect(asked()).toBe(2);
  });

  it('a viewer cannot change the board, and other sites cannot post as you', async () => {
    await seedBoards();
    const cookie = await signedIn();
    gh.perms = { 'big-talk:aaron-t': 'read', 'bulletin-bee:aaron-t': 'write' };
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

  it('lists who can edit each board, and only they can be assigned (PL-006)', async () => {
    await seedBoards();
    await signedIn('kevin-r', 10);
    await env.DB.prepare(`INSERT INTO access (user_id, repo_id, role, checked_at) VALUES (10, 502, 'view', ?)`).bind(new Date().toISOString()).run();
    const cookie = await signedIn();
    gh.perms = { 'big-talk:aaron-t': 'write', 'bulletin-bee:aaron-t': 'write' };
    const me = (await (await call('/v1/me', { cookie })).json()) as Me;
    expect(me.boards.find(b => b.repo === 'bulletin-bee')?.editors).toEqual(['aaron-t']);
    expect(me.people['kevin-r']).toBeDefined(); // a viewer is still shown by name

    const post = (op: unknown) => call('/v1/boards/nnewberg/bulletin-bee/ops', { method: 'POST', body: JSON.stringify(op), cookie, headers: { origin: ORIGIN } });
    const { item } = (await (await post({ op: 'create', title: 'assign me' })).json()) as { item: { id: string } };
    const assign = (user: string) => post({ op: 'claim', id: item.id, user });
    const refused = await assign('kevin-r');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(new RegExp(`^kevin-r can’t be assigned ${item.id}`));
    expect((await assign('not-a-login')).status).toBe(409);
    expect((await post({ op: 'claim', id: item.id, user: 7 })).status).toBe(400);
    const ok = await assign('@Aaron-T'); // yourself, written loosely
    expect(((await ok.json()) as { item: { claim: { user: string } } }).item.claim.user).toBe('aaron-t');
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
  const hook = (event: string, payload: unknown, secret = WEBHOOK_SECRET) => webhook(event, payload, { secret });
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
