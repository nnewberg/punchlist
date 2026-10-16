import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, flush, outboxCount, readBoard, write } from '../api';

// FR-9: writes made offline wait in an outbox and go out in order; reads fall back to the cache.

const b = { owner: 'nnewberg', repo: 'punchlist' };
let online = true;
let posted: unknown[] = [];
let nextId = 1;
const snapshot = { board: { ...b, prefix: 'PL' }, items: [], seq: 0, viewers: [] };

beforeEach(() => {
  process.env.PUNCH_HOME = mkdtempSync(join(tmpdir(), 'punch-'));
  online = true;
  posted = [];
  nextId = 1;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!online) throw new TypeError('fetch failed');
    if (init?.method === 'POST') {
      const ops = JSON.parse(String(init.body)) as { op: string; id?: string; title?: string }[];
      posted.push(...ops);
      const results = ops.map(op => ({ ok: true, item: { id: op.id ?? `PL-00${nextId++}`, title: op.title ?? 'x' } }));
      return new Response(JSON.stringify({ ok: true, results }), { status: 200 });
    }
    return new Response(JSON.stringify(snapshot), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const client = () => new Client({ url: 'https://punch.test', token: 'pl_x' });

describe('outbox', () => {
  it('queues writes while offline and sends them in order later', async () => {
    online = false;
    expect(await write(client(), b, 'add "one"', [{ op: 'create', title: 'one' }])).toEqual({ sent: false, queued: true });
    await write(client(), b, 'note on PL-001', [{ op: 'note', id: 'PL-001', text: 'hi' }]);
    expect(outboxCount(b)).toBe(2);

    online = true;
    const report = await flush(client(), b);
    expect(report?.sent.map(s => s.label)).toEqual(['add "one"', 'note on PL-001']);
    expect(report?.sent[0]!.results[0]).toMatchObject({ ok: true, item: { id: 'PL-001' } });
    expect(posted.map(p => (p as { op: string }).op)).toEqual(['create', 'note']);
    expect(outboxCount(b)).toBe(0);
  });

  it('keeps what it could not send', async () => {
    online = false;
    await write(client(), b, 'add "one"', [{ op: 'create', title: 'one' }]);
    expect((await flush(client(), b))?.remaining).toBe(1);
  });
});

describe('cache', () => {
  it('serves the last board it saw when the server is unreachable', async () => {
    await readBoard(client(), b);
    online = false;
    const read = await readBoard(client(), b);
    expect(read.offlineSince).toBeTruthy();
    expect(read.snapshot.board.prefix).toBe('PL');
  });

  it('says so when there is nothing cached', async () => {
    online = false;
    await expect(readBoard(client(), b)).rejects.toThrow(/no saved copy/);
  });
});
