import { describe, expect, it } from 'vitest';
import type { Item, Snapshot, Status } from '../../shared/types';
import { formatCompact, formatList } from '../format';

const now = new Date().toISOString();
function item(n: number, status: Status, extra: Partial<Item> = {}): Item {
  return {
    id: `BT-${String(n).padStart(3, '0')}`,
    title: `Item ${n}: ${'a fairly long title that goes on for a while '.repeat(2)}`,
    body: 'x'.repeat(2000),
    status,
    rank: `a${String(n).padStart(3, '0')}`,
    blocked: null,
    tags: ['ux'],
    depends_on: [],
    aliases: [],
    source: { kind: 'web', actor: 'nick' },
    created_at: now,
    created_by: 'nick',
    claim: null,
    citations: [],
    notes: [{ at: now, actor: 'nick', via: 'web', text: 'a note that should never reach the compact view' }],
    body_version: 0,
    updated_at: now,
    ...(status === 'done' ? { closed_at: now } : {}),
    ...extra,
  };
}

function board(): Snapshot {
  const items: Item[] = [];
  let n = 1;
  for (let i = 0; i < 6; i++) items.push(item(n++, 'in_progress', { claim: { user: 'aaron', kind: 'branch', ref: `bt-${n}-thing`, since: now } }));
  for (let i = 0; i < 12; i++) items.push(item(n++, 'up_next', i === 0 ? { blocked: { reason: 'needs Apple Developer account', since: now } } : {}));
  for (let i = 0; i < 30; i++) items.push(item(n++, 'backlog'));
  for (let i = 0; i < 12; i++) items.push(item(n++, 'done'));
  return { board: { owner: 'futureleisurefoundation', repo: 'big-talk', prefix: 'BT' }, items, seq: 1, viewers: [] };
}

describe('compact board (FR-18)', () => {
  const out = formatCompact(board());

  it('fits in about 1,500 tokens for a 60-item board', () => {
    // ~4 characters per token.
    expect(out.length / 4).toBeLessThan(1500);
  });

  it('shows who holds what, what is blocked, and how much backlog is left out', () => {
    expect(out).toContain('BT-001');
    expect(out).toContain('[aaron · branch bt-2-thing]');
    expect(out).toContain('BT-007: needs Apple Developer account');
    expect(out).toContain('… 20 more');
    expect(out).not.toContain('a note that should never');
    expect(out).not.toMatch(/BT-05[0-9]/); // Done stays out
  });
});

describe('list', () => {
  it('shows only the asked-for column', () => {
    const out = formatList(board(), { status: 'in_progress' });
    expect(out).toContain('In Progress');
    expect(out).not.toContain('Backlog');
  });
});
