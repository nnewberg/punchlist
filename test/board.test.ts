import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoardInfo, ImportItem } from '../shared/types';

const info: BoardInfo = { owner: 'nnewberg', repo: 'punchlist', prefix: 'PL' };
const nick = { user: 'nick', via: 'web' as const };
const stub = (name = crypto.randomUUID()) => env.BOARD.get(env.BOARD.idFromName(name));

describe('BoardDO', () => {
  it('assigns sequential ids that never collide', async () => {
    const b = stub();
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => b.apply(info, { op: 'create', title: `t${i}` }, nick).then(r => (r.ok && 'event' in r ? r.item.id : null))),
    );
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual(['PL-001', 'PL-002', 'PL-003', 'PL-004', 'PL-005']);
  });

  it('serves events since a sequence number for reconnecting clients (FR-6)', async () => {
    const b = stub();
    await b.apply(info, { op: 'create', title: 'a' }, nick);
    const { seq } = await b.snapshot(info);
    await b.apply(info, { op: 'note', id: 'PL-001', text: 'hello' }, nick);
    const since = await b.eventsSince(info, seq);
    expect(since?.events.map(e => e.event.op)).toEqual(['note']);
    expect(since?.events[0]!.item.notes[0]!.text).toBe('hello');
  });

  it('undo is a new event that restores the earlier state (FR-15)', async () => {
    const b = stub();
    await b.apply(info, { op: 'create', title: 'a', status: 'up_next' }, nick);
    const moved = await b.apply(info, { op: 'move', id: 'PL-001', status: 'done' }, nick);
    if (!moved.ok || !('event' in moved)) throw new Error('move failed');
    const undone = await b.apply(info, { op: 'undo', seq: moved.event.seq }, nick);
    expect(undone.ok && 'event' in undone && undone.item.status).toBe('up_next');
    const hist = await b.history(info, 'PL-001');
    expect(hist.map(e => e.op)).toEqual(['restore', 'move', 'create']);
  });

  it('leaves reorders within a column out of the history, but still syncs them (PL-007)', async () => {
    const b = stub();
    await b.apply(info, { op: 'create', title: 'a', status: 'up_next' }, nick);
    await b.apply(info, { op: 'create', title: 'b', status: 'up_next' }, nick);
    const { seq } = await b.snapshot(info);
    await b.apply(info, { op: 'move', id: 'PL-002', status: 'up_next', beforeId: 'PL-001' }, nick);
    await b.apply(info, { op: 'move', id: 'PL-002', status: 'done' }, nick);
    const hist = await b.history(info, 'PL-002');
    expect(hist.map(e => e.meta?.text)).toEqual(['Closed', 'Created']);
    const since = await b.eventsSince(info, seq);
    expect(since?.events.map(e => e.event.meta?.text)).toEqual(['Reordered', 'Closed']);
  });

  it('persists across a restart of the object', async () => {
    const name = crypto.randomUUID();
    await stub(name).apply(info, { op: 'create', title: 'durable' }, nick);
    const snap = await stub(name).snapshot(info);
    expect(snap.items.map(i => i.title)).toEqual(['durable']);
  });

  it('seeds the sample board in dev mode', async () => {
    const snap = await stub('futureleisurefoundation/big-talk').snapshot({ owner: 'futureleisurefoundation', repo: 'big-talk', prefix: 'BT' });
    expect(snap.items.find(i => i.id === 'BT-030')?.depends_on).toEqual(['BT-007a']);
    const created = await stub('futureleisurefoundation/big-talk').apply({ owner: 'futureleisurefoundation', repo: 'big-talk', prefix: 'BT' }, { op: 'create', title: 'new' }, nick);
    expect(created.ok && 'event' in created && created.item.id).toBe('BT-038');
  });
});

describe('assigning (PL-006)', () => {
  // A board with its own name, and who can edit it as the Worker last checked (FR-2).
  async function boardWith(roles: Record<string, 'edit' | 'view'>) {
    const repo = `assign-${crypto.randomUUID().slice(0, 8)}`;
    const repoId = Math.floor(Math.random() * 1e9);
    const t = new Date().toISOString();
    const ids: Record<string, number> = { nick: 1, aaron: 2, kevin: 3 };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO boards (repo_id, owner, repo, prefix, installation_id, archived_at, created_at) VALUES (?, 'nnewberg', ?, 'AS', NULL, NULL, ?)`).bind(repoId, repo, t),
      ...Object.entries(ids).map(([login, id]) => env.DB.prepare(`INSERT OR IGNORE INTO users (id, login, name, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)`).bind(id, login, login === 'aaron' ? 'Aaron Smith' : null, t)),
      ...Object.entries(roles).map(([login, role]) => env.DB.prepare(`INSERT INTO access (user_id, repo_id, role, checked_at) VALUES (?, ?, ?, ?)`).bind(ids[login]!, repoId, role, t)),
    ]);
    const b = stub();
    const at: BoardInfo = { owner: 'nnewberg', repo, prefix: 'AS' };
    await b.apply(at, { op: 'create', title: 'x', status: 'up_next' }, nick);
    return { b, at };
  }

  it('assigns someone who can edit the board, by their name in the history', async () => {
    const { b, at } = await boardWith({ nick: 'edit', aaron: 'edit' });
    const out = await b.apply(at, { op: 'claim', id: 'AS-001', user: 'aaron' }, nick);
    expect(out.ok && out.item.claim).toMatchObject({ user: 'aaron', kind: 'manual' });
    expect((await b.history(at, 'AS-001'))[0]!.meta?.text).toBe('Assigned to Aaron Smith');
  });

  it('refuses a viewer, or someone with no access', async () => {
    const { b, at } = await boardWith({ nick: 'edit', kevin: 'view' });
    for (const user of ['kevin', 'mallory']) {
      const out = await b.apply(at, { op: 'claim', id: 'AS-001', user }, nick);
      expect(!out.ok && out.error.code).toBe('invalid');
    }
    expect((await b.snapshot(at)).items[0]!.claim).toBeNull();
  });

  it('applies ops in the order they arrive, even when an assignment waits on the directory', async () => {
    const { b, at } = await boardWith({ nick: 'edit', aaron: 'edit' });
    await Promise.all([b.apply(at, { op: 'claim', id: 'AS-001', user: 'aaron' }, nick), b.apply(at, { op: 'release', id: 'AS-001' }, nick)]);
    expect((await b.snapshot(at)).items[0]!.claim).toBeNull();
  });
});

describe('Claude session claims (FR-24, FR-28)', () => {
  const HOUR = 3600_000;
  const claude = (session: string, user = 'nick') => ({ user, via: 'claude' as const, session });

  async function claimed(b: ReturnType<typeof stub>, title: string, session = 's1', user = 'nick') {
    const made = await b.apply(info, { op: 'create', title, status: 'up_next' }, nick);
    if (!made.ok || !('event' in made)) throw new Error('create failed');
    const out = await b.apply(info, { op: 'claim', id: made.item.id }, claude(session, user));
    if (!out.ok || !('event' in out)) throw new Error('claim failed');
    return { id: made.item.id, since: Date.parse(out.item.claim!.since) };
  }
  const status = async (b: ReturnType<typeof stub>, id: string) => (await b.snapshot(info)).items.find(i => i.id === id)!;

  it('a claim made in a Claude session is a session claim, and sets an alarm for when it could lapse', async () => {
    const b = stub();
    const { id, since } = await claimed(b, 'retry uploads');
    expect((await status(b, id)).claim).toMatchObject({ user: 'nick', kind: 'session', ref: 's1' });
    const alarm = await runInDurableObject(b, (_, state) => state.storage.getAlarm());
    expect(alarm).toBe(since + 2 * HOUR);
  });

  it('lapses after two hours without a heartbeat, back to the column it came from', async () => {
    const b = stub();
    const { id, since } = await claimed(b, 'retry uploads');
    expect(await b.expireClaims(since + 2 * HOUR - 60_000)).toBe(0);
    expect(await b.expireClaims(since + 2 * HOUR + 1)).toBe(1);
    const it = await status(b, id);
    expect(it.claim).toBeNull();
    expect(it.status).toBe('up_next');
    const [last] = await b.history(info, id);
    expect(last).toMatchObject({ op: 'release', actor: { user: 'nick', via: 'reconciler' } });
    expect(last!.meta?.text).toMatch(/lapsed/);
  });

  it('a heartbeat keeps the claim alive for two hours from the heartbeat', async () => {
    const b = stub();
    const { id, since } = await claimed(b, 'retry uploads');
    const state = await b.session(info, claude('s1'), 'heartbeat', since + 90 * 60_000);
    expect(state.held.map(i => i.id)).toEqual([id]);
    expect(await b.expireClaims(since + 2 * HOUR + 1)).toBe(0);
    expect(await b.expireClaims(since + 90 * 60_000 + 2 * HOUR + 1)).toBe(1);
  });

  it("ending a session releases only that session's claims", async () => {
    const b = stub();
    const mine = await claimed(b, 'one', 's1');
    const other = await claimed(b, 'two', 's2');
    const kevins = await claimed(b, 'three', 's1', 'kevin');
    await b.session(info, claude('s1'), 'end');
    expect((await status(b, mine.id)).claim).toBeNull();
    expect((await status(b, other.id)).claim).toMatchObject({ ref: 's2' });
    expect((await status(b, kevins.id)).claim).toMatchObject({ user: 'kevin' });
    expect((await b.history(info, mine.id))[0]!.meta?.text).toBe('Released when the Claude session ended');
  });

  it('branch and hand-made claims never lapse', async () => {
    const b = stub();
    await b.apply(info, { op: 'create', title: 'manual', status: 'in_progress' }, nick);
    const { id } = await claimed(b, 'branch');
    await b.apply(info, { op: 'claim', id, kind: 'branch', ref: `nick/${id}` }, { user: 'nick', via: 'github' });
    expect(await b.expireClaims(Date.now() + 10 * HOUR)).toBe(0);
  });
});

describe('import (PRD §7.9)', () => {
  const bt: BoardInfo = { owner: 'acme', repo: 'talk', prefix: 'BT' }; // not a seeded sample board
  const items: ImportItem[] = [
    { id: 'BT-001', title: 'Glanceable openers', status: 'done', closed_at: '2026-08-06T00:00:00Z', citations: [{ commit: '44f9d9c', message: 'BT-001: the title is the opener' }], why: 'merged in 44f9d9c' },
    { id: 'BT-036', title: 'Continue the quiz', status: 'up_next', aliases: ['BT-007a'], depends_on: ['BT-001'] },
    { id: 'BT-035', title: 'Pre-event blast', status: 'in_progress', notes: [{ text: 'Scheduling not started' }], why: 'generator built' },
    { title: 'Bump the deploy Action off Node 20', status: 'backlog', depends_on: ['bt-7a'] },
  ];

  it('keeps the IDs, numbers new items after the highest, and records why', async () => {
    const b = stub();
    const out = await b.importItems(bt, items, nick);
    expect(out).toEqual({ ok: true, ids: ['BT-001', 'BT-036', 'BT-035', 'BT-037'] });
    const snap = await b.snapshot(bt);
    const get = (id: string) => snap.items.find(i => i.id === id)!;
    expect(get('BT-001')).toMatchObject({ status: 'done', closed_at: '2026-08-06T00:00:00Z', source: { kind: 'import' } });
    expect(get('BT-001').citations[0]).toMatchObject({ kind: 'closes', commit: '44f9d9c', how: 'manual' });
    expect(get('BT-035')).toMatchObject({ status: 'in_progress', claim: null });
    expect(get('BT-037').depends_on).toEqual(['BT-036']);
    expect((await b.history(bt, 'BT-001'))[0]!.meta?.text).toBe('Imported: merged in 44f9d9c');
    const next = await b.apply(bt, { op: 'create', title: 'after the import' }, nick);
    expect(next.ok && 'event' in next && next.item.id).toBe('BT-038');
  });

  it('a reorder that claims an unclaimed in-progress item stays in its history', async () => {
    const b = stub();
    await b.importItems(bt, items, nick);
    await b.apply(bt, { op: 'move', id: 'BT-035', status: 'in_progress', beforeId: 'top' }, nick);
    expect((await b.history(bt, 'BT-035'))[0]!.op).toBe('move');
  });

  it('an alias finds its item', async () => {
    const b = stub();
    await b.importItems(bt, items, nick);
    const out = await b.apply(bt, { op: 'note', id: 'BT-007a', text: 'still wanted' }, nick);
    expect(out.ok && out.item.id).toBe('BT-036');
  });

  it('writes nothing if any item clashes with the board', async () => {
    const b = stub();
    await b.apply(bt, { op: 'create', title: 'made before the import' }, nick); // BT-001
    const out = await b.importItems(bt, items, nick);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.errors.join(' ')).toMatch(/BT-001 is already/);
    expect((await b.snapshot(bt)).items).toHaveLength(1);
  });

  it('an import can be undone item by item', async () => {
    const b = stub();
    await b.importItems(bt, items, nick);
    const [ev] = await b.history(bt, 'BT-035');
    const out = await b.apply(bt, { op: 'undo', seq: ev!.seq }, nick);
    expect(out.ok && 'event' in out && out.item.status).toBe('dropped');
  });
});
