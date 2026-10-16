import { env } from 'cloudflare:test';
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
