import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoardEvent, Item } from '../shared/types';
import { call, gh, ORIGIN, seedBoards, signedIn, useProdWorker } from './harness';

// The CLI's way in (FR-3): GitHub's device flow ends in a Punchlist API token, which then works like
// a session — but per machine, revocable, and with no cookie to forge.

useProdWorker();

async function cliToken(machine = 'nick-mbp') {
  const start = (await (await call('/auth/device/start', { method: 'POST' })).json()) as { user_code: string; handle: string };
  expect(start.user_code).toBe('ABCD-1234');
  const poll = () => call('/auth/device/poll', { method: 'POST', body: JSON.stringify({ handle: start.handle, machine }) });
  expect((await poll()).status).toBe(202); // not approved yet
  const done = await poll();
  expect(done.status).toBe(200);
  return ((await done.json()) as { token: string }).token;
}

async function setup() {
  await seedBoards();
  await signedIn(); // creates the user row and clears cached access
  gh.perms = { 'big-talk:aaron-t': 'write', 'bulletin-bee:aaron-t': 'read' };
}

describe('device-flow login', () => {
  it('hands out a Punchlist token once the person approves on GitHub', async () => {
    await setup();
    const token = await cliToken();
    expect(token).toMatch(/^pl_/);
    const me = await call('/v1/me', { token });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: string }).user).toBe('aaron-t');
    // Only the hash is stored.
    const row = await env.DB.prepare(`SELECT token_hash, machine FROM tokens WHERE user_id = 9 ORDER BY created_at DESC`).first<{ token_hash: string; machine: string }>();
    expect(row?.token_hash).not.toContain(token);
    expect(row?.machine).toBe('nick-mbp');
  });

  it('explains when device sign-in is off for the App', async () => {
    gh.deviceDisabled = true;
    const res = await call('/auth/device/start', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Enable Device Flow/);
  });

  it('says so when the person cancels', async () => {
    gh.devicePolls = ['access_denied'];
    const start = (await (await call('/auth/device/start', { method: 'POST' })).json()) as { handle: string };
    const res = await call('/auth/device/poll', { method: 'POST', body: JSON.stringify({ handle: start.handle }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe('denied');
  });
});

describe('API tokens', () => {
  it('an unknown or revoked token is 401, and never falls back to the cookie', async () => {
    await setup();
    const cookie = await signedIn();
    expect((await call('/v1/me', { token: 'pl_nope', cookie })).status).toBe(401);
    const token = await cliToken();
    const list = (await (await call('/v1/me/tokens', { token })).json()) as { tokens: { id: string; current: boolean }[] };
    expect(list.tokens.find(t => t.current)).toBeTruthy();
    expect((await call('/v1/me/tokens/current', { method: 'DELETE', token })).status).toBe(204);
    expect((await call('/v1/me', { token })).status).toBe(401);
  });

  it('can post without an Origin header, which a cookie cannot', async () => {
    await setup();
    const token = await cliToken();
    const cookie = await signedIn();
    const op = JSON.stringify({ op: 'create', title: 'from the terminal' });
    const path = '/v1/boards/futureleisurefoundation/big-talk/ops';
    expect((await call(path, { method: 'POST', body: op, token })).status).toBe(200);
    expect((await call(path, { method: 'POST', body: op, cookie })).status).toBe(403);
    expect((await call(path, { method: 'POST', body: op, cookie, headers: { origin: ORIGIN } })).status).toBe(200);
  });

  it('still follows the repo role', async () => {
    await setup();
    const token = await cliToken();
    const res = await call('/v1/boards/nnewberg/bulletin-bee/ops', { method: 'POST', body: JSON.stringify({ op: 'create', title: 'x' }), token });
    expect(res.status).toBe(403);
  });
});

describe('ops from the CLI', () => {
  const path = '/v1/boards/futureleisurefoundation/big-talk';

  it('record the agent session that made them (FR-4)', async () => {
    await setup();
    const token = await cliToken();
    const res = await call(`${path}/ops`, { method: 'POST', token, body: JSON.stringify({ op: 'create', title: 'deferred' }), headers: { 'x-punch-via': 'claude', 'x-punch-session': '3f2a' } });
    const out = (await res.json()) as { event: BoardEvent; item: Item };
    expect(out.event.actor).toEqual({ user: 'aaron-t', via: 'claude', session: '3f2a' });
    expect(out.item.source).toMatchObject({ kind: 'chat', ref: 'session 3f2a' });
  });

  it('can only say an item came from chat, deferred work or the CLI', async () => {
    await setup();
    const token = await cliToken();
    const deferred = await call(`${path}/ops`, { method: 'POST', token, body: JSON.stringify({ op: 'create', title: 'later', source: 'claude-deferred' }) });
    expect(((await deferred.json()) as { item: Item }).item.source.kind).toBe('claude-deferred');
    const forged = await call(`${path}/ops`, { method: 'POST', token, body: JSON.stringify({ op: 'create', title: 'x', source: 'github' }) });
    expect(forged.status).toBe(400);
  });

  it("a Claude session's heartbeat reports what it holds, and ending it releases them (FR-24)", async () => {
    await setup();
    const token = await cliToken();
    const headers = { 'x-punch-via': 'claude', 'x-punch-session': 'abc' };
    const made = (await (await call(`${path}/ops`, { method: 'POST', token, headers, body: JSON.stringify({ op: 'create', title: 'mine', status: 'up_next' }) })).json()) as { item: Item };
    await call(`${path}/ops`, { method: 'POST', token, headers, body: JSON.stringify({ op: 'claim', id: made.item.id }) });
    const beat = (await (await call(`${path}/session`, { method: 'POST', token, headers, body: JSON.stringify({ action: 'heartbeat' }) })).json()) as { held: Item[] };
    expect(beat.held.map(i => i.id)).toEqual([made.item.id]);
    expect((await call(`${path}/session`, { method: 'POST', token, headers, body: JSON.stringify({ action: 'end' }) })).status).toBe(200);
    const snap = (await (await call(path, { token })).json()) as { items: Item[] };
    expect(snap.items.find(i => i.id === made.item.id)!.claim).toBeNull();
    expect((await call(`${path}/session`, { method: 'POST', token, body: JSON.stringify({ action: 'end' }) })).status).toBe(400);
  });

  it('can import a file of items, but only into the board it names, and not as a viewer', async () => {
    await setup();
    const token = await cliToken();
    const items = [{ id: 'BT-905', title: 'Quiz resume hardening', status: 'up_next' }]; // above what other tests create here
    const wrong = await call(`${path}/import`, { method: 'POST', token, body: JSON.stringify({ board: 'nnewberg/bulletin-bee', items }) });
    expect(wrong.status).toBe(400);
    const ok = await call(`${path}/import`, { method: 'POST', token, body: JSON.stringify({ board: 'futureleisurefoundation/big-talk', items }) });
    expect(await ok.json()).toEqual({ ok: true, ids: ['BT-905'] });
    const again = await call(`${path}/import`, { method: 'POST', token, body: JSON.stringify({ items }) });
    expect(again.status).toBe(409);
    const viewer = await call('/v1/boards/nnewberg/bulletin-bee/import', { method: 'POST', token, body: JSON.stringify({ items: [{ title: 'x', status: 'backlog' }] }) });
    expect(viewer.status).toBe(403);
  });

  it("can backfill closing PRs' head branches (PL-013), but not as a viewer or with a malformed body", async () => {
    await setup();
    const token = await cliToken();
    const heads = (board: string, body: unknown) => call(`/v1/boards/${board}/heads`, { method: 'POST', token, body: JSON.stringify(body) });
    expect(await (await heads('futureleisurefoundation/big-talk', { heads: { 9999: 'nothing-closed-by-it' } })).json()).toEqual({ ok: true, ids: [] });
    expect((await heads('futureleisurefoundation/big-talk', { heads: { main: 'x' } })).status).toBe(400);
    expect((await heads('futureleisurefoundation/big-talk', { heads: { 12: 42 } })).status).toBe(400);
    expect((await heads('futureleisurefoundation/big-talk', {})).status).toBe(400);
    // Not a plain object of PR → branch: a string or array would otherwise pass as {"0": …}.
    expect((await heads('futureleisurefoundation/big-talk', { heads: 'abc' })).status).toBe(400);
    expect((await heads('futureleisurefoundation/big-talk', { heads: ['x'] })).status).toBe(400);
    // Not a branch name.
    for (const ref of ['', 'two words', 'tab\there', 'line\nbreak', 'bell\u0007', 'a:b']) {
      expect((await heads('futureleisurefoundation/big-talk', { heads: { 12: ref } })).status).toBe(400);
    }
    expect((await heads('futureleisurefoundation/big-talk', { heads: { 12: 'feature/pl-013_done.branch-2' } })).status).toBe(200);
    expect((await heads('nnewberg/bulletin-bee', { heads: { 12: 'x' } })).status).toBe(403);
  });

  it('can be sent as a batch that stops at the first refusal', async () => {
    await setup();
    const token = await cliToken();
    const created = (await (await call(`${path}/ops`, { method: 'POST', token, body: JSON.stringify({ op: 'create', title: 'batch me' }) })).json()) as { item: Item };
    const id = created.item.id;
    const res = await call(`${path}/ops`, {
      method: 'POST',
      token,
      body: JSON.stringify([
        { op: 'note', id, text: 'first' },
        { op: 'note', id: 'BT-999', text: 'nope' },
        { op: 'note', id, text: 'never sent' },
      ]),
    });
    expect(res.status).toBe(404);
    const out = (await res.json()) as { ok: boolean; results: { ok: boolean }[] };
    expect(out.ok).toBe(false);
    expect(out.results.map(r => r.ok)).toEqual([true, false]);
  });

  it('accept IDs the way people type them', async () => {
    await setup();
    const token = await cliToken();
    const created = (await (await call(`${path}/ops`, { method: 'POST', token, body: JSON.stringify({ op: 'create', title: 'loose id' }) })).json()) as { item: Item };
    const loose = created.item.id.toLowerCase().replace(/-0+/, '-'); // BT-041 → bt-41
    const res = await call(`${path}/ops`, { method: 'POST', token, body: JSON.stringify({ op: 'note', id: loose, text: 'found it' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: Item }).item.id).toBe(created.item.id);
  });
});
