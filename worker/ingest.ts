import { branchRefs, parseMessage, revertedPr, subject } from '../shared/github';
import { resolveId } from '../shared/ops';
import type { Actor, Citation, Item, Op } from '../shared/types';

// What a GitHub event does to a board (PRD FR-26, FR-28, FR-30, FR-31, FR-33). The Worker turns each
// webhook into these facts, doing any GitHub lookups itself; the board's Durable Object runs `ingest`
// in one transaction, with no fetches (§8 cost rules). Every change is an ordinary op, so it lands in
// the event log, reaches open boards live, and can be undone.
//
// The rules:
// - Only the default branch closes items. Elsewhere a `Closes` adds a pending citation (a badge).
// - A branch named for an item claims it for the pusher; merging or deleting the branch ends the claim.
//   A merged branch closes the item it's named for unless the PR said `Refs` for it (decided 2026-10-16).
// - A merged PR's number is attached to its commits' citations; a revert reopens what it undid.

export interface GhCommit {
  sha: string;
  message: string;
  /** GitHub login of the commit's author, when GitHub knows it. */
  author: string | null;
  /** The merged PR this commit came through, when the Worker looked it up. */
  pr?: number;
}

export type GhFacts =
  | { kind: 'push'; branch: string; isDefault: boolean; actor: string; commits: GhCommit[] }
  | { kind: 'branch'; action: 'created' | 'deleted'; branch: string; actor: string }
  | {
      kind: 'pr';
      action: 'open' | 'merged';
      number: number;
      title: string;
      body: string;
      /** The PR's head branch. */
      branch: string;
      /** The branch it merges into, and whether that's the default branch. */
      base: string;
      intoDefault: boolean;
      mergeSha: string | null;
      /** The PR's commits; fetched only for a merge. */
      commits: GhCommit[];
      author: string | null;
      actor: string;
    };

export interface IngestHost {
  readonly items: ReadonlyMap<string, Item>;
  readonly prefix: string;
  apply(op: Op, actor: Actor): void;
  /**
   * Records a commit: the PR it came through, whether it's that PR's merge (or squash) commit, and
   * whether it's on the default branch. Returns false if it had already landed there (dedupe by SHA).
   */
  rememberCommit(sha: string, o: { pr?: number; merge?: boolean; onDefault?: boolean }): boolean;
  /** The PR a commit came through, by full or abbreviated SHA; with `mergeOnly`, only if it's the PR's merge commit. */
  commitPr(sha: string, mergeOnly?: boolean): number | null;
}

const gh = (user: string | null): Actor => ({ user: user?.toLowerCase() ?? null, via: 'github' });
const open = (it: Item) => it.status !== 'done' && it.status !== 'dropped';

export function ingest(host: IngestHost, f: GhFacts) {
  const resolve = (refs: string[]): Item[] => {
    const seen = new Map<string, Item>();
    for (const r of refs) {
      const it = resolveId(host.items, r);
      if (it) seen.set(it.id, it);
    }
    return [...seen.values()];
  };
  const current = (id: string) => host.items.get(id)!;
  const each = (op: (it: Item) => Op | null, actor: Actor) => {
    for (const it of [...host.items.values()]) {
      const o = op(it);
      if (o) host.apply(o, actor);
    }
  };
  const close = (it: Item, citation: Omit<Citation, 'at' | 'kind' | 'confidence'>, actor: Actor) =>
    host.apply({ op: 'cite', id: it.id, citation: { kind: 'closes', confidence: null, ...citation } }, actor);

  /** A branch named for items claims them for whoever pushed it (FR-26), never taking one from someone else (FR-27). */
  const claimFor = (branch: string, login: string) => {
    const user = login.toLowerCase();
    for (const it of resolve(branchRefs(branch, host.prefix))) {
      if (!open(it)) continue;
      const c = it.claim;
      if (!c || (c.user === user && c.kind !== 'branch')) {
        host.apply({ op: 'claim', id: it.id, kind: 'branch', ref: branch }, gh(user));
      } else if (c.user !== user) {
        const text = `${user} pushed branch ${branch}, but ${c.user} has ${it.id}.`;
        if (!it.notes.some(n => n.text === text)) host.apply({ op: 'note', id: it.id, text }, gh(user));
      }
    }
  };

  /** Ends a branch for every item it touched: its claim and any pending fix on it (FR-28). */
  const endBranch = (branch: string, actor: Actor) =>
    each(it => (it.citations.some(c => c.kind === 'pending' && c.branch === branch) || (it.claim?.kind === 'branch' && it.claim.ref === branch && open(it)) ? { op: 'branch_end', id: it.id, branch } : null), actor);

  const revert = (commits: string[], prs: number[], by: { commit: string; message?: string }, actor: Actor) =>
    each(it => (it.citations.some(c => c.kind === 'closes' && !c.reverted) ? { op: 'revert', id: it.id, commits, prs, by } : null), actor);

  switch (f.kind) {
    case 'push': {
      if (!f.isDefault) {
        claimFor(f.branch, f.actor);
        for (const c of f.commits) {
          for (const it of resolve(parseMessage(c.message, host.prefix).closes)) {
            host.apply({ op: 'cite', id: it.id, citation: { kind: 'pending', commit: c.sha, branch: f.branch, how: 'explicit', confidence: null, ...(c.author ? { author: c.author } : {}), message: subject(c.message) } }, gh(c.author ?? f.actor));
          }
        }
        return;
      }
      for (const c of f.commits) {
        if (!host.rememberCommit(c.sha, { onDefault: true, pr: c.pr })) continue;
        const pr = c.pr ?? host.commitPr(c.sha) ?? undefined;
        const r = parseMessage(c.message, host.prefix);
        const actor = gh(c.author ?? f.actor);
        const msg = subject(c.message);
        if (r.reverts.length) {
          // Reverting a PR's merge commit undoes the whole PR; reverting one of its commits undoes just that commit.
          const prs = r.reverts.map(s => host.commitPr(s, true)).filter((n): n is number => n != null);
          revert(r.reverts, prs, { commit: c.sha, message: msg }, actor);
        }
        const closed = resolve(r.closes);
        for (const it of closed) close(current(it.id), { commit: c.sha, ...(pr ? { pr } : {}), branch: f.branch, how: 'explicit', ...(c.author ? { author: c.author } : {}), message: msg }, actor);
        for (const it of resolve([...r.refs, ...r.mentions])) {
          if (closed.some(x => x.id === it.id)) continue;
          host.apply({ op: 'note', id: it.id, text: msg, commit: c.sha, ...(pr ? { pr } : {}) }, actor);
        }
      }
      return;
    }

    case 'branch':
      if (f.action === 'created') claimFor(f.branch, f.actor);
      else endBranch(f.branch, gh(f.actor));
      return;

    case 'pr': {
      if (!f.intoDefault) return;
      const text = `${f.title}\n\n${f.body}`;
      const r = parseMessage(text, host.prefix);
      const actor = gh(f.actor);

      if (f.action === 'open') {
        for (const it of resolve(r.closes)) {
          host.apply({ op: 'cite', id: it.id, citation: { kind: 'pending', pr: f.number, branch: f.branch, how: 'explicit', confidence: null, ...(f.author ? { author: f.author } : {}), message: f.title } }, actor);
        }
        return;
      }

      // Merged into the default branch.
      const merge = f.mergeSha ?? undefined;
      const shas = [...(merge ? [merge] : []), ...f.commits.map(c => c.sha)];
      for (const sha of shas) host.rememberCommit(sha, { pr: f.number, merge: sha === merge });
      each(it => (it.citations.some(c => c.commit && shas.includes(c.commit)) || it.notes.some(n => n.commit && shas.includes(n.commit)) ? { op: 'link_pr', id: it.id, pr: f.number, commits: shas } : null), actor);

      const undid = revertedPr(f.body);
      if (undid != null || /^Revert "/.test(f.title)) {
        if (undid != null && merge) revert([], [undid], { commit: merge, message: f.title }, actor);
        endBranch(f.branch, actor);
        return;
      }

      const by = { pr: f.number, branch: f.base, ...(f.author ? { author: f.author } : {}) };
      for (const it of resolve(r.closes)) close(current(it.id), { ...(merge ? { commit: merge } : {}), ...by, how: 'explicit', message: f.title }, actor);
      // The PR's own commits may say Closes too; a squash merge can drop their messages from main.
      const partial = new Set(resolve(r.refs).map(i => i.id));
      for (const c of f.commits) {
        const cr = parseMessage(c.message, host.prefix);
        for (const it of resolve(cr.closes)) close(current(it.id), { commit: c.sha, ...by, how: 'explicit', message: subject(c.message) }, actor);
        for (const it of resolve(cr.refs)) partial.add(it.id);
      }
      // A branch named for an item closes it when merged, unless it said the work was partial.
      for (const it of resolve(branchRefs(f.branch, host.prefix))) {
        const now = current(it.id);
        if (!open(now)) continue;
        if (partial.has(now.id)) {
          host.apply({ op: 'branch_end', id: now.id, branch: f.branch, note: `${f.branch} was merged in PR #${f.number} as partial progress (Refs), so ${now.id} stays open.` }, actor);
        } else {
          close(now, { ...(merge ? { commit: merge } : {}), ...by, how: 'branch', message: f.title }, actor);
        }
      }
      endBranch(f.branch, actor);
      return;
    }
  }
}
