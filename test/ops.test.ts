import { describe, expect, it } from 'vitest';
import { workBranch } from '../shared/derive';
import { applyOp, columnItems, inversePatch } from '../shared/ops';
import type { Actor, Item, Op } from '../shared/types';

const nick: Actor = { user: 'nick', via: 'web' };
const aaron: Actor = { user: 'aaron', via: 'web' };

function board() {
  const items = new Map<string, Item>();
  let n = 1;
  let clock = 0;
  const run = (op: Op, actor: Actor = nick, editors?: ReadonlyMap<string, string | null>) => {
    const res = applyOp(items, op, { actor, now: new Date(Date.UTC(2026, 9, 16, 0, 0, clock++)).toISOString(), newId: `PL-${String(n).padStart(3, '0')}`, ...(editors ? { editors } : {}) });
    if (res.ok && !res.noop) {
      if (op.op === 'create') n++;
      items.set(res.after.id, res.after);
    }
    return res;
  };
  return { items, run };
}

describe('applyOp', () => {
  it('creates items at the top of their column', () => {
    const b = board();
    b.run({ op: 'create', title: 'first', status: 'up_next' });
    b.run({ op: 'create', title: 'second', status: 'up_next' });
    expect(columnItems(b.items.values(), 'up_next').map(i => i.title)).toEqual(['second', 'first']);
  });

  it('orders moves within a column by fractional rank', () => {
    const b = board();
    for (const t of ['c', 'b', 'a']) b.run({ op: 'create', title: t, status: 'up_next' });
    // a, b, c → move c before a
    b.run({ op: 'move', id: 'PL-001', status: 'up_next', beforeId: 'PL-003' });
    expect(columnItems(b.items.values(), 'up_next').map(i => i.title)).toEqual(['c', 'a', 'b']);
    // move c to the end
    b.run({ op: 'move', id: 'PL-001', status: 'up_next', beforeId: null });
    expect(columnItems(b.items.values(), 'up_next').map(i => i.title)).toEqual(['a', 'b', 'c']);
  });

  it('claims for the mover when dropped into In Progress (FR-11) and releases back', () => {
    const b = board();
    b.run({ op: 'create', title: 'x', status: 'up_next' });
    b.run({ op: 'move', id: 'PL-001', status: 'in_progress' }, aaron);
    expect(b.items.get('PL-001')!.claim?.user).toBe('aaron');
    b.run({ op: 'release', id: 'PL-001' }, aaron);
    const it = b.items.get('PL-001')!;
    expect(it.claim).toBeNull();
    expect(it.status).toBe('up_next');
  });

  it("refuses a claim your other Claude session holds, unless stolen; the same session claiming again changes nothing", () => {
    const b = board();
    b.run({ op: 'create', title: 'x', status: 'up_next' });
    const s1: Actor = { user: 'nick', via: 'claude', session: 's1' };
    b.run({ op: 'claim', id: 'PL-001' }, s1);
    expect(b.run({ op: 'claim', id: 'PL-001' }, s1)).toMatchObject({ ok: true, noop: true });
    const res = b.run({ op: 'claim', id: 'PL-001' }, { ...s1, session: 's2' });
    expect(!res.ok && res.error).toMatchObject({ code: 'claimed', message: 'Your other Claude session has PL-001' });
    b.run({ op: 'claim', id: 'PL-001', steal: true }, { ...s1, session: 's2' });
    expect(b.items.get('PL-001')!.claim).toMatchObject({ kind: 'session', ref: 's2' });
  });

  it("a session claim doesn't replace your own branch or hand-made claim", () => {
    const b = board();
    b.run({ op: 'create', title: 'x', status: 'up_next' });
    b.run({ op: 'claim', id: 'PL-001', kind: 'branch', ref: 'nick/pl-001' }, { user: 'nick', via: 'github' });
    expect(b.run({ op: 'claim', id: 'PL-001' }, { user: 'nick', via: 'claude', session: 's1' })).toMatchObject({ ok: true, noop: true });
    b.run({ op: 'create', title: 'y', status: 'up_next' });
    b.run({ op: 'claim', id: 'PL-002' }, nick);
    expect(b.run({ op: 'claim', id: 'PL-002' }, { user: 'nick', via: 'claude', session: 's1' })).toMatchObject({ ok: true, noop: true });
    expect(b.items.get('PL-002')!.claim).toMatchObject({ kind: 'manual' });
  });

  it('refuses a claim held by someone else unless stolen (FR-27)', () => {
    const b = board();
    b.run({ op: 'create', title: 'x' });
    b.run({ op: 'claim', id: 'PL-001' }, aaron);
    const res = b.run({ op: 'claim', id: 'PL-001' }, nick);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('claimed');
    const stolen = b.run({ op: 'claim', id: 'PL-001', steal: true }, nick);
    expect(stolen.ok && !stolen.noop && stolen.meta.text).toBe('Took over from Aaron');
    expect(b.items.get('PL-001')!.claim?.user).toBe('nick');
  });

  describe('assigning someone else (PL-006)', () => {
    const editors = new Map<string, string | null>([['nick', 'Nick Newberg'], ['aaron', 'Aaron Smith'], ['kevin', null]]); // no name: shown as person() shows them
    const text = (res: ReturnType<ReturnType<typeof board>['run']>) => (res.ok && !res.noop ? res.meta.text : res);

    it('is a hand-made claim for them that starts the item, like their own claim', () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'up_next' });
      expect(text(b.run({ op: 'claim', id: 'PL-001', user: '@Aaron' }, nick, editors))).toBe('Assigned to Aaron Smith');
      const it = b.items.get('PL-001')!;
      expect(it.claim).toMatchObject({ user: 'aaron', kind: 'manual' });
      expect(it.status).toBe('in_progress');
      // Assigning whoever already has it changes nothing.
      expect(b.run({ op: 'claim', id: 'PL-001', user: 'aaron' }, nick, editors)).toMatchObject({ ok: true, noop: true });
    });

    it("from a Claude session, isn't tied to that session", () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'up_next' });
      b.run({ op: 'claim', id: 'PL-001', user: 'aaron' }, { user: 'nick', via: 'claude', session: 's1' }, editors);
      expect(b.items.get('PL-001')!.claim).toEqual({ user: 'aaron', kind: 'manual', since: expect.any(String) });
    });

    it('makes a Claude session’s claim, which lapses, a lasting one for that person', () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'up_next' });
      b.run({ op: 'claim', id: 'PL-001' }, { user: 'aaron', via: 'claude', session: 's1' });
      expect(text(b.run({ op: 'claim', id: 'PL-001', user: 'aaron' }, nick, editors))).toBe('Assigned to Aaron Smith');
      expect(b.items.get('PL-001')!.claim).toEqual({ user: 'aaron', kind: 'manual', since: expect.any(String) });
    });

    it('releasing someone else’s claim reads as unassigning them; your own, as releasing it', () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'up_next' });
      b.run({ op: 'claim', id: 'PL-001', user: 'aaron' }, nick, editors);
      expect(text(b.run({ op: 'release', id: 'PL-001' }, nick, editors))).toBe('Unassigned Aaron Smith');
      b.run({ op: 'claim', id: 'PL-001' }, nick);
      expect(text(b.run({ op: 'release', id: 'PL-001' }, nick))).toBe('Released');
    });

    it('naming yourself is an ordinary claim', () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'up_next' });
      expect(text(b.run({ op: 'claim', id: 'PL-001', user: 'Nick' }, nick))).toBe('Started');
      expect(b.items.get('PL-001')!.claim?.user).toBe('nick');
    });

    it('hands over your own claim freely; taking a third person’s needs steal and is recorded (FR-27)', () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'up_next' });
      b.run({ op: 'claim', id: 'PL-001' }, nick);
      expect(text(b.run({ op: 'claim', id: 'PL-001', user: 'aaron' }, nick, editors))).toBe('Assigned to Aaron Smith');
      const refused = b.run({ op: 'claim', id: 'PL-001', user: 'kevin' }, nick, editors);
      expect(!refused.ok && refused.error).toMatchObject({ code: 'claimed', message: 'Aaron Smith already has PL-001' });
      expect(text(b.run({ op: 'claim', id: 'PL-001', user: 'kevin', steal: true }, nick, editors))).toBe('Reassigned from Aaron Smith to Kevin');
      expect(b.items.get('PL-001')!.claim?.user).toBe('kevin');
      // Taking it yourself reads as it does today.
      expect(text(b.run({ op: 'claim', id: 'PL-001', steal: true }, nick, editors))).toBe('Took over from Kevin');
    });

    it('refuses someone who cannot edit the board, or anyone when the editors are unknown', () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'up_next' });
      const stranger = b.run({ op: 'claim', id: 'PL-001', user: 'mallory' }, nick, editors);
      expect(!stranger.ok && stranger.error.code).toBe('invalid');
      expect(!stranger.ok && stranger.error.message).toMatch(/^mallory can’t be assigned PL-001: only people who can edit this board can/);
      expect(b.run({ op: 'claim', id: 'PL-001', user: 'aaron' }, nick).ok).toBe(false);
      expect(b.items.get('PL-001')!.claim).toBeNull();
    });

    it('needs the item to be open, like any claim', () => {
      const b = board();
      b.run({ op: 'create', title: 'x', status: 'done' });
      expect(b.run({ op: 'claim', id: 'PL-001', user: 'aaron' }, nick, editors).ok).toBe(false);
    });
  });

  it('rejects a stale body edit with the other person’s text (FR-8)', () => {
    const b = board();
    b.run({ op: 'create', title: 'x' });
    b.run({ op: 'edit', id: 'PL-001', body: 'aaron text', baseBodyVersion: 0 }, aaron);
    const res = b.run({ op: 'edit', id: 'PL-001', body: 'nick text', baseBodyVersion: 0 }, nick);
    expect(!res.ok && res.error).toMatchObject({ code: 'conflict', by: 'aaron', theirs: 'aaron text', version: 1 });
    // Different fields still merge: a title change with no body goes through.
    expect(b.run({ op: 'edit', id: 'PL-001', title: 'renamed' }, nick).ok).toBe(true);
  });

  it('reopens a closed item to the column it came from (S9)', () => {
    const b = board();
    b.run({ op: 'create', title: 'x', status: 'backlog' });
    b.run({ op: 'move', id: 'PL-001', status: 'done' });
    expect(b.items.get('PL-001')!.closed_at).toBeDefined();
    b.run({ op: 'reopen', id: 'PL-001' });
    const it = b.items.get('PL-001')!;
    expect(it.status).toBe('backlog');
    expect(it.closed_at).toBeUndefined();
  });

  it("shows only the current close's branch on a Done card (PL-013)", () => {
    const b = board();
    const github: Actor = { user: 'nick', via: 'github' };
    const close = (c: { commit: string; pr?: number; head?: string }) =>
      b.run({ op: 'cite', id: 'PL-001', citation: { kind: 'closes', branch: 'main', how: 'explicit', confidence: null, ...c } }, github);
    b.run({ op: 'create', title: 'x', status: 'up_next' });
    close({ commit: 'a'.repeat(40), pr: 93, head: 'branch-try-1' });
    expect(workBranch(b.items.get('PL-001')!)).toBe('branch-try-1');
    // Reopened, then closed again by a direct push to main: no branch, not the earlier PR's.
    b.run({ op: 'reopen', id: 'PL-001' });
    close({ commit: 'b'.repeat(40) });
    expect(b.items.get('PL-001')!.status).toBe('done');
    expect(workBranch(b.items.get('PL-001')!)).toBeUndefined();
    // A push that also fixes it after a PR closed it keeps the PR's branch.
    b.run({ op: 'reopen', id: 'PL-001' });
    close({ commit: 'c'.repeat(40), pr: 94, head: 'branch-try-2' });
    close({ commit: 'd'.repeat(40) });
    expect(workBranch(b.items.get('PL-001')!)).toBe('branch-try-2');
  });

  it("relinking a close to a different PR takes that PR's head branch (PL-013)", () => {
    const b = board();
    const github: Actor = { user: 'nick', via: 'github' };
    const commit = 'e'.repeat(40);
    b.run({ op: 'create', title: 'x', status: 'up_next' });
    b.run({ op: 'cite', id: 'PL-001', citation: { kind: 'closes', commit, pr: 91, branch: 'main', head: 'branch-a', how: 'explicit', confidence: null } }, github);
    // Stacked PRs, squash-merged: #92's merge carries the same commit.
    b.run({ op: 'link_pr', id: 'PL-001', pr: 92, commits: [commit], head: 'branch-b' }, github);
    expect(b.items.get('PL-001')!.citations).toMatchObject([{ pr: 92, head: 'branch-b' }]);
    // The same PR again only fills in a missing head.
    expect(b.run({ op: 'link_pr', id: 'PL-001', pr: 92, commits: [commit], head: 'branch-c' }, github)).toMatchObject({ ok: true, noop: true });
  });

  it('builds an inverse patch that restores the earlier item', () => {
    const b = board();
    b.run({ op: 'create', title: 'x', status: 'backlog' });
    const res = b.run({ op: 'move', id: 'PL-001', status: 'done' });
    if (!res.ok || res.noop) throw new Error('move failed');
    const patch = inversePatch(res.before!, res.after);
    expect(patch).toMatchObject({ status: 'backlog', closed_at: undefined });
    b.run({ op: 'restore', id: 'PL-001', fields: patch, undoOf: 2 });
    expect(b.items.get('PL-001')!.status).toBe('backlog');
    expect('closed_at' in b.items.get('PL-001')!).toBe(false);
  });

  it('treats no-change edits as no-ops', () => {
    const b = board();
    b.run({ op: 'create', title: 'x' });
    expect(b.run({ op: 'edit', id: 'PL-001', title: 'x' })).toMatchObject({ ok: true, noop: true });
  });
});
