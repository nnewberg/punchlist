import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoardInfo } from '../shared/types';

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
