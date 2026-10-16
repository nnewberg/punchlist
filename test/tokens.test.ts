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
