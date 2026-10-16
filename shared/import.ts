import { idKey } from './ops';
import type { Actor, ImportItem, Item, Status } from './types';

// `punch import` (PRD §7.9): checks an import file against a board, and turns each entry into an item.
// The CLI runs the check for its dry run; the board's Durable Object runs it again before writing.

const STATUSES: Status[] = ['backlog', 'up_next', 'in_progress', 'done', 'dropped'];
export const MAX_IMPORT = 500;

export interface ImportPlan {
  /** Why the file can't be imported; nothing is written if there are any. */
  errors: string[];
  /** Each entry's ID, or null where the board will assign one. */
  ids: (string | null)[];
  /** The highest number the file uses, so new items start after it. */
  maxNum: number;
}

export function checkImport(prefix: string, existing: ReadonlyMap<string, Item>, items: ImportItem[]): ImportPlan {
  const errors: string[] = [];
  const ids: (string | null)[] = [];
  if (!Array.isArray(items) || !items.length) return { errors: ['The file has no items.'], ids, maxNum: 0 };
  if (items.length > MAX_IMPORT) errors.push(`At most ${MAX_IMPORT} items at a time; this has ${items.length}.`);

  // Every name already taken on the board, by ID or alias, compared loosely (BT-8 is BT-008).
  const taken = new Map<string, string>();
  for (const it of existing.values()) for (const n of [it.id, ...it.aliases]) taken.set(idKey(n), it.id);
  const own = /^([A-Za-z]+)-(\d{3,})$/;
  let maxNum = 0;

  items.forEach((it, i) => {
    const at = `Item ${i + 1}${it?.id ? ` (${it.id})` : ''}`;
    if (!it || typeof it.title !== 'string' || !it.title.trim()) errors.push(`${at}: needs a title.`);
    if (!STATUSES.includes(it?.status)) errors.push(`${at}: status must be one of ${STATUSES.join(', ')}.`);
    let id: string | null = null;
    if (it?.id !== undefined) {
      const m = own.exec(it.id);
      if (!m || m[1] !== prefix) errors.push(`${at}: an ID here looks like ${prefix}-001; anything else can be an alias.`);
      else {
        id = it.id;
        maxNum = Math.max(maxNum, Number(m[2]));
      }
    }
    ids.push(id);
    for (const n of [...(id ? [id] : []), ...(it?.aliases ?? [])]) {
      const prev = taken.get(idKey(n));
      if (prev) errors.push(`${at}: ${n} is already ${prev === n ? 'on the board or in this file' : `taken by ${prev}`}.`);
      else taken.set(idKey(n), id ?? `item ${i + 1}`);
    }
    if (it?.closed_at && it.status !== 'done') errors.push(`${at}: has closed_at but isn't done.`);
  });

  items.forEach((it, i) => {
    for (const d of it?.depends_on ?? []) if (!taken.has(idKey(d))) errors.push(`Item ${i + 1}${it.id ? ` (${it.id})` : ''}: depends on ${d}, which isn't on the board or in this file.`);
  });
  return { errors, ids, maxNum };
}

/** The item an import entry becomes, before the board gives it a rank. */
export function importedItem(spec: ImportItem, id: string, actor: Actor, now: string, rank: string): Item {
  const user = actor.user ?? 'import';
  const done = spec.status === 'done';
  const closedAt = done ? (spec.closed_at ?? now) : undefined;
  return {
    id,
    title: spec.title.trim(),
    body: spec.body ?? '',
    status: spec.status,
    rank,
    blocked: spec.blocked?.reason ? { reason: spec.blocked.reason, since: now } : null,
    tags: [...new Set((spec.tags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean))],
    depends_on: spec.depends_on ?? [],
    aliases: spec.aliases ?? [],
    source: { kind: 'import', actor: user },
    created_at: spec.created_at ?? now,
    created_by: user,
    claim: null,
    citations: (spec.citations ?? []).map(c => ({
      kind: 'closes' as const,
      ...(c.commit ? { commit: c.commit } : {}),
      ...(c.pr ? { pr: c.pr } : {}),
      how: 'manual' as const,
      confidence: null,
      at: c.at ?? closedAt ?? now,
      ...(c.message ? { message: c.message } : {}),
    })),
    notes: (spec.notes ?? []).map(n => ({
      at: n.at ?? now,
      actor: user,
      via: actor.via,
      ...(n.commit ? { commit: n.commit } : {}),
      ...(n.pr ? { pr: n.pr } : {}),
      text: n.text,
    })),
    body_version: 0,
    updated_at: now,
    ...(closedAt ? { closed_at: closedAt } : {}),
  };
}
