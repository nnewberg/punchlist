import { generateKeyBetween } from 'fractional-indexing';
import { COLUMNS, type Actor, type Citation, type EventMeta, type Item, type Op, type OpError, type Status } from './types';
import { shortSha } from './github';
import { person } from './config';

// Pure op application. The board Durable Object runs this authoritatively (FR-7); the web client
// runs the same code to show a change immediately and rebases pending ops on top of server events.

export interface ApplyCtx {
  actor: Actor;
  now: string;
  /** Required for `create`: the server assigns PREFIX-NNN, the client uses a temporary handle. */
  newId?: string;
}

export type ApplyResult =
  | { ok: true; before: Item | null; after: Item; meta: EventMeta; noop?: false }
  | { ok: true; noop: true; item: Item }
  | { ok: false; error: OpError };

export const STATUS_LABEL: Record<Status, string> = {
  backlog: 'Backlog',
  up_next: 'Up Next',
  in_progress: 'In Progress',
  done: 'Done',
  dropped: 'Deleted',
};

const fail = (code: 'not_found' | 'invalid', message: string): ApplyResult => ({ ok: false, error: { code, message } });
const isColumn = (s: string): s is Status => (COLUMNS as readonly string[]).includes(s) || s === 'dropped';

/** Items of one column in board order: rank ascending, except Done which is most-recently-closed first. */
export function columnItems(items: Iterable<Item>, status: Status, excludeId?: string): Item[] {
  const list = [...items].filter(i => i.status === status && i.id !== excludeId);
  if (status === 'done') return list.sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''));
  return list.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
}

/** A rank that places an item before `beforeId` in `status` (or at the end; `'top'` for the start). */
export function rankFor(items: Iterable<Item>, status: Status, beforeId: string | null | undefined | 'top', excludeId?: string): string {
  const col = [...items]
    .filter(i => i.status === status && i.id !== excludeId)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  let lo: string | null = col.length ? col[col.length - 1]!.rank : null;
  let hi: string | null = null;
  const idx = beforeId === 'top' ? 0 : beforeId ? col.findIndex(i => i.id === beforeId) : -1;
  if (idx >= 0 && col.length) {
    lo = idx > 0 ? col[idx - 1]!.rank : null;
    hi = col[idx]!.rank;
  }
  try {
    return generateKeyBetween(lo, hi);
  } catch {
    // Equal neighbouring ranks (shouldn't happen) — fall back to appending.
    return generateKeyBetween(col.length ? col[col.length - 1]!.rank : null, null);
  }
}

function setStatus(it: Item, status: Status, now: string) {
  if (it.status === status) return;
  it.prev_status = it.status;
  it.status = status;
  if (status === 'done') it.closed_at = now;
  else delete it.closed_at;
}

/** Where an item goes back to when it is reopened or its claim ends without a close (FR-28, S9). */
function returnColumn(it: Item): Status {
  const p = it.prev_status;
  if (p === 'backlog' || p === 'up_next') return p;
  if (p === 'in_progress' && it.claim) return 'in_progress';
  return 'up_next';
}

const cleanList = (xs: string[] | undefined) => [...new Set((xs ?? []).map(s => s.trim()).filter(Boolean))];

export function applyOp(items: ReadonlyMap<string, Item>, op: Op, ctx: ApplyCtx): ApplyResult {
  const { actor, now } = ctx;
  const user = actor.user ?? 'github';

  if (op.op === 'create') {
    const title = op.title.trim();
    if (!title) return fail('invalid', 'Title is required');
    if (!ctx.newId) return fail('invalid', 'No id available');
    const status = op.status && isColumn(op.status) ? op.status : 'backlog';
    const it: Item = {
      id: ctx.newId,
      title,
      body: op.body ?? '',
      status,
      rank: rankFor(items.values(), status, 'top'),
      blocked: null,
      tags: cleanList(op.tags).map(t => t.toLowerCase()),
      depends_on: [],
      aliases: [],
      source: { kind: op.source ?? (actor.via === 'claude' ? 'chat' : actor.via === 'cli' ? 'cli' : 'web'), actor: user, ...(actor.session ? { ref: `session ${actor.session}` } : {}) },
      created_at: now,
      created_by: user,
      claim: status === 'in_progress' ? { user, kind: actor.session ? 'session' : 'manual', ...(actor.session ? { ref: actor.session } : {}), since: now } : null,
      citations: [],
      notes: [],
      body_version: 0,
      updated_at: now,
      ...(status === 'done' ? { closed_at: now } : {}),
    };
    return { ok: true, before: null, after: it, meta: { text: actor.via === 'claude' ? 'Added from chat' : 'Created' } };
  }

  if (op.op === 'undo') return fail('invalid', 'undo is resolved by the board, not applied directly');

  const cur = items.get(op.id) ?? resolveId(items, op.id);
  if (!cur) return fail('not_found', `No item ${op.id}`);
  const it: Item = structuredClone(cur);
  let meta: EventMeta = {};

  switch (op.op) {
    case 'move': {
      if (!isColumn(op.status)) return fail('invalid', `Unknown status ${op.status}`);
      const from = it.status;
      const beforeId = op.beforeId && op.beforeId !== 'top' ? (resolveId(items, op.beforeId)?.id ?? op.beforeId) : op.beforeId;
      it.rank = op.status === 'done' ? it.rank : rankFor(items.values(), op.status, beforeId, it.id);
      setStatus(it, op.status, now);
      if (op.status === 'in_progress' && !it.claim) it.claim = { user, kind: 'manual', since: now }; // FR-11
      if ((op.status === 'backlog' || op.status === 'up_next') && from === 'in_progress') it.claim = null;
      if (op.status === 'dropped') it.claim = null;
      meta = {
        text:
          from === op.status ? 'Reordered'
          : op.status === 'in_progress' ? 'Started'
          : op.status === 'done' ? 'Closed'
          : `Moved to ${STATUS_LABEL[op.status]}`,
      };
      break;
    }
    case 'edit': {
      const parts: string[] = [];
      if (op.title !== undefined) {
        const t = op.title.trim();
        if (!t) return fail('invalid', 'Title is required');
        if (t !== it.title) { it.title = t; parts.push('title'); }
      }
      if (op.body !== undefined && op.body !== it.body) {
        if (op.baseBodyVersion !== undefined && op.baseBodyVersion !== it.body_version) {
          return {
            ok: false,
            error: {
              code: 'conflict',
              message: `${person(it.body_by).name} edited this. Review their changes.`,
              by: it.body_by,
              theirs: it.body,
              version: it.body_version,
            },
          };
        }
        it.body = op.body;
        it.body_version += 1;
        it.body_by = user;
        parts.push('description');
      }
      if (!parts.length) return { ok: true, noop: true, item: cur };
      meta = { text: `Edited the ${parts.join(' and ')}` };
      break;
    }
    case 'claim': {
      if (it.status === 'done' || it.status === 'dropped') return fail('invalid', 'Reopen the item before claiming it');
      const kind = op.kind ?? (actor.session ? 'session' : 'manual');
      const ref = op.ref ?? actor.session;
      const held = it.claim;
      if (held && held.user !== user && !op.steal) {
        return { ok: false, error: { code: 'claimed', message: `${person(held.user).name} already has ${it.id}`, holder: held } };
      }
      if (held && held.user === user && !op.steal) {
        if (held.kind === kind && held.ref === ref) return { ok: true, noop: true, item: cur };
        // A branch or a hand-made claim outlives any one session, so a session doesn't replace it.
        if (kind === 'session' && held.kind !== 'session') return { ok: true, noop: true, item: cur };
        // Two of your own Claude sessions working on one item is duplicated work too (FR-27).
        if (kind === 'session') return { ok: false, error: { code: 'claimed', message: `Your other Claude session has ${it.id}`, holder: held } };
      }
      const stolen = held && held.user !== user ? held.user : null;
      it.claim = { user, kind, ...(ref ? { ref } : {}), since: now };
      if (it.status !== 'in_progress') {
        it.rank = rankFor(items.values(), 'in_progress', null, it.id);
        setStatus(it, 'in_progress', now);
      }
      meta = { text: stolen ? `Took over from ${person(stolen).name}` : 'Started' };
      break;
    }
    case 'release': {
      if (!it.claim) return { ok: true, noop: true, item: cur };
      it.claim = null;
      if (it.status === 'in_progress') {
        const to = returnColumn(it) === 'in_progress' ? 'up_next' : returnColumn(it);
        it.rank = rankFor(items.values(), to, 'top', it.id);
        setStatus(it, to, now);
      }
      meta = { text: op.reason?.trim() || 'Released' };
      break;
    }
    case 'block': {
      const reason = op.reason.trim();
      if (!reason) return fail('invalid', 'A reason is required');
      it.blocked = { reason, since: now };
      meta = { text: `Marked blocked: ${reason}` };
      break;
    }
    case 'unblock': {
      if (!it.blocked) return { ok: true, noop: true, item: cur };
      it.blocked = null;
      meta = { text: 'Unblocked' };
      break;
    }
    case 'note': {
      const text = op.text.trim();
      if (!text) return fail('invalid', 'Note is empty');
      it.notes = [...it.notes, { at: now, actor: user, via: actor.via, ...(actor.session ? { session: actor.session } : {}), ...(op.commit ? { commit: op.commit } : {}), ...(op.pr ? { pr: op.pr } : {}), text }];
      meta = { text: 'Added a note' };
      break;
    }
    case 'tag': {
      const add = cleanList(op.add).map(t => t.toLowerCase());
      const remove = new Set(cleanList(op.remove).map(t => t.toLowerCase()));
      const next = [...it.tags.filter(t => !remove.has(t)), ...add.filter(t => !it.tags.includes(t))];
      if (next.join() === it.tags.join()) return { ok: true, noop: true, item: cur };
      it.tags = next;
      meta = { text: [add.length ? `Tagged ${add.join(', ')}` : '', remove.size ? `Removed tag ${[...remove].join(', ')}` : ''].filter(Boolean).join('; ') };
      break;
    }
    case 'depends': {
      const add = cleanList(op.add);
      for (const d of add) {
        const dep = resolveId(items, d);
        if (!dep) return fail('not_found', `No item ${d}`);
        if (dep.id === it.id) return fail('invalid', 'An item cannot depend on itself');
      }
      const resolved = add.map(d => resolveId(items, d)!.id);
      const remove = new Set(cleanList(op.remove));
      const next = [...it.depends_on.filter(d => !remove.has(d)), ...resolved.filter(d => !it.depends_on.includes(d))];
      if (next.join() === it.depends_on.join()) return { ok: true, noop: true, item: cur };
      it.depends_on = next;
      meta = { text: resolved.length ? `Added dependency` : 'Removed dependency', ref: (resolved[0] ?? [...remove][0]) };
      break;
    }
    case 'reopen': {
      if (it.status !== 'done' && it.status !== 'dropped') return { ok: true, noop: true, item: cur };
      const to = returnColumn(it);
      it.rank = rankFor(items.values(), to, 'top', it.id);
      setStatus(it, to, now);
      meta = { text: 'Reopened' };
      break;
    }
    case 'drop': {
      if (it.status === 'dropped') return { ok: true, noop: true, item: cur };
      it.claim = null;
      setStatus(it, 'dropped', now);
      meta = { text: 'Deleted' };
      break;
    }
    case 'cite': {
      const c = op.citation;
      const sameCommit = (x: Citation) => !!c.commit && x.commit === c.commit;
      if (c.kind === 'pending') {
        if (it.status === 'done' || it.status === 'dropped') return { ok: true, noop: true, item: cur };
        // One pending fix per branch (or per PR, before its branch is known): a force-push replaces it.
        const same = (x: Citation) => x.kind === 'pending' && (c.branch ? x.branch === c.branch : !!c.pr && x.pr === c.pr);
        const prev = it.citations.find(same);
        const next: Citation = { ...prev, ...c, pr: c.pr ?? prev?.pr, commit: c.commit ?? prev?.commit, branch: c.branch ?? prev?.branch, at: now };
        for (const k of ['pr', 'commit', 'branch', 'message'] as const) if (next[k] === undefined) delete next[k];
        if (prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...next, at: 0 })) return { ok: true, noop: true, item: cur };
        it.citations = [...it.citations.filter(x => !same(x)), next];
        meta = { text: 'Fix pending', ref: c.pr ? `PR #${c.pr}` : c.branch, ...(c.message ? { msg: c.message } : {}) };
        break;
      }
      // The same commit or PR seen twice (push and PR events both report a merge) counts once.
      if (it.citations.some(x => x.kind === 'closes' && !x.reverted && (sameCommit(x) || (!!c.pr && x.pr === c.pr)))) {
        return { ok: true, noop: true, item: cur };
      }
      const closing = it.status !== 'done' && it.status !== 'dropped';
      // Once it's closed, a pending fix has landed or no longer matters.
      it.citations = [...it.citations.filter(x => !(closing && x.kind === 'pending')), { ...c, at: now }];
      if (closing) {
        if (!it.claim && c.author) it.claim = { user: c.author, kind: 'manual', since: now };
        setStatus(it, 'done', now);
        it.blocked = null;
      }
      const ref = c.pr ? `PR #${c.pr}` : shortSha(c.commit);
      meta = { text: closing ? (c.how === 'branch' ? 'Closed by merging its branch' : c.pr ? 'Closed by' : 'Closed by push') : 'Also fixed by', ref, ...(c.message ? { msg: c.message } : {}) };
      break;
    }
    case 'link_pr': {
      const shas = new Set(op.commits);
      let linked = false;
      let headed = false;
      // Pending fixes are left alone: the merge either closes the item, which drops them, or ends their branch.
      // A push to main may have closed the item before the merge event arrived, so the head branch is added here too.
      it.citations = it.citations.map(x => {
        if (x.kind !== 'closes' || !((x.commit && shas.has(x.commit)) || x.pr === op.pr)) return x;
        const y = { ...x };
        // A different PR brings its own head branch; the same PR only fills in a missing one.
        if (y.pr !== op.pr) {
          y.pr = op.pr;
          if (op.head) y.head = op.head;
          else delete y.head;
          linked = true;
        } else if (op.head && !y.head) {
          y.head = op.head;
          headed = true;
        }
        return y;
      });
      it.notes = it.notes.map(n => (n.commit && shas.has(n.commit) && n.pr !== op.pr ? ((linked = true), { ...n, pr: op.pr }) : n));
      if (!linked && !headed) return { ok: true, noop: true, item: cur };
      meta = linked ? { text: 'Linked to', ref: `PR #${op.pr}` } : { text: 'Recorded the branch', ref: op.head };
      break;
    }
    case 'revert': {
      const hit = (x: Citation) =>
        x.kind === 'closes' && !x.reverted && ((!!x.commit && op.commits.some(s => x.commit!.startsWith(s) || s.startsWith(x.commit!))) || (!!x.pr && op.prs.includes(x.pr)));
      if (!it.citations.some(hit)) return { ok: true, noop: true, item: cur };
      it.citations = it.citations.map(x => (hit(x) ? { ...x, reverted: true } : x));
      const stillClosed = it.citations.some(x => x.kind === 'closes' && !x.reverted);
      const reopen = it.status === 'done' && !stillClosed;
      it.notes = [...it.notes, { at: now, actor: user, via: actor.via, commit: op.by.commit, text: `Reverted in ${shortSha(op.by.commit)}${op.by.message ? `: ${op.by.message}` : ''}` }];
      if (reopen) {
        const to = it.prev_status === 'backlog' || it.prev_status === 'up_next' ? it.prev_status : 'up_next';
        it.claim = null;
        it.rank = rankFor(items.values(), to, 'top', it.id);
        setStatus(it, to, now);
      }
      meta = { text: reopen ? 'Reopened by a revert' : 'Close reverted', ref: shortSha(op.by.commit), ...(op.by.message ? { msg: op.by.message } : {}) };
      break;
    }
    case 'branch_end': {
      const pending = it.citations.filter(x => x.kind === 'pending' && x.branch === op.branch);
      const held = it.claim?.kind === 'branch' && it.claim.ref === op.branch && it.status !== 'done' && it.status !== 'dropped';
      if (!pending.length && !held && !op.note) return { ok: true, noop: true, item: cur };
      it.citations = it.citations.filter(x => !pending.includes(x));
      if (held) {
        it.claim = null;
        if (it.status === 'in_progress') {
          const to = returnColumn(it) === 'in_progress' ? 'up_next' : returnColumn(it);
          it.rank = rankFor(items.values(), to, 'top', it.id);
          setStatus(it, to, now);
        }
      }
      if (op.note) it.notes = [...it.notes, { at: now, actor: user, via: actor.via, text: op.note }];
      meta = { text: held ? 'Branch ended; released' : 'Branch ended', ref: op.branch };
      break;
    }
    case 'restore': {
      Object.assign(it, structuredClone(op.fields));
      for (const [k, v] of Object.entries(op.fields)) if (v === undefined) delete (it as unknown as Record<string, unknown>)[k];
      meta = { text: 'Undid a change', undoOf: op.undoOf };
      break;
    }
  }

  it.updated_at = now;
  return { ok: true, before: cur, after: it, meta };
}

/** `BT-030`, `bt-30` and `BT030` are the same item; so is any of its aliases. */
export const idKey = (ref: string) => {
  const m = /^([a-z]+)-?0*(\d+)([a-z]*)$/i.exec(ref.trim());
  return m ? `${m[1]!.toUpperCase()}-${m[2]}${m[3]!.toLowerCase()}` : ref.trim().toUpperCase();
};

export function resolveId(items: ReadonlyMap<string, Item>, ref: string): Item | undefined {
  const direct = items.get(ref);
  if (direct) return direct;
  const key = idKey(ref);
  const upper = ref.trim().toUpperCase();
  for (const it of items.values()) if (idKey(it.id) === key) return it;
  for (const it of items.values()) if (it.aliases.some(a => a.toUpperCase() === upper || idKey(a) === key)) return it;
  return undefined;
}

/** Fields that differ between two versions of an item — the inverse patch used by undo (FR-15). */
export function inversePatch(before: Item, after: Item): Partial<Item> {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('updated_at');
  for (const k of keys) {
    const b = (before as unknown as Record<string, unknown>)[k];
    const a = (after as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) patch[k] = b === undefined ? undefined : structuredClone(b);
  }
  return patch as Partial<Item>;
}
