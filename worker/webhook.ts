import { citesAnything, parseMessage } from '../shared/github';
import { boardByRepoId, boardInfo } from './directory';
import { mergedPrFor, prCommits } from './github';
import type { GhCommit, GhFacts } from './ingest';

// Push, pull_request, create and delete webhooks (PRD FR-29). The Worker reads the payload, makes any
// GitHub calls itself, and hands the board's Durable Object one set of facts to apply (`ingest.ts`).
// The object never fetches (§8 cost rules), and it ignores a delivery it has seen before.

export const SYNC_EVENTS = new Set(['push', 'pull_request', 'create', 'delete']);

/** Most citing commits looked up per push for their PR; the PR event links the rest. */
const PR_LOOKUPS = 10;

interface Repo {
  id: number;
  name: string;
  owner: { login?: string; name?: string };
  default_branch: string;
}
interface Payload {
  installation?: { id: number };
  repository?: Repo;
  sender?: { login: string };
  // push
  ref?: string;
  deleted?: boolean;
  commits?: { id: string; message: string; author?: { username?: string } }[];
  // create, delete
  ref_type?: string;
  // pull_request
  action?: string;
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    merged: boolean;
    merge_commit_sha: string | null;
    head: { ref: string };
    base: { ref: string };
    user: { login: string } | null;
  };
}

const OPEN_ACTIONS = new Set(['opened', 'edited', 'reopened', 'synchronize', 'ready_for_review']);
const lower = (s: string | null | undefined) => s?.toLowerCase() ?? null;

/** Applies one sync webhook to its repo's board. Returns what happened, for the log. */
export async function syncFromGitHub(env: Env, event: string, delivery: string, p: Payload): Promise<string> {
  const repo = p.repository;
  if (!repo) return 'no repository';
  const board = await boardByRepoId(env, repo.id);
  if (!board) return 'no board';
  const installationId = p.installation?.id ?? board.installationId;
  const actor = lower(p.sender?.login) ?? 'github';

  let facts: GhFacts | null = null;
  if (event === 'push' && p.ref?.startsWith('refs/heads/')) {
    const branch = p.ref.slice('refs/heads/'.length);
    if (p.deleted) facts = { kind: 'branch', action: 'deleted', branch, actor };
    else {
      const isDefault = branch === repo.default_branch;
      const commits: GhCommit[] = (p.commits ?? []).map(c => ({ sha: c.id, message: c.message, author: lower(c.author?.username) }));
      // A commit on the default branch that cites something gets its PR now, so the citation links it.
      if (isDefault && installationId != null) {
        const citing = commits.filter(c => citesAnything(parseMessage(c.message, board.prefix))).slice(0, PR_LOOKUPS);
        await Promise.all(citing.map(async c => {
          const pr = await mergedPrFor(env, installationId, board.owner, board.repo, c.sha, branch).catch(e => (console.error('PR lookup failed', c.sha, e), null));
          if (pr) c.pr = pr;
        }));
      }
      facts = { kind: 'push', branch, isDefault, actor, commits };
    }
  } else if ((event === 'create' || event === 'delete') && p.ref_type === 'branch' && p.ref) {
    facts = { kind: 'branch', action: event === 'create' ? 'created' : 'deleted', branch: p.ref, actor };
  } else if (event === 'pull_request' && p.pull_request) {
    const pr = p.pull_request;
    const merged = p.action === 'closed' && pr.merged;
    if (merged || OPEN_ACTIONS.has(p.action ?? '')) {
      const commits = merged && installationId != null ? await prCommits(env, installationId, board.owner, board.repo, pr.number) : [];
      facts = {
        kind: 'pr',
        action: merged ? 'merged' : 'open',
        number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        branch: pr.head.ref,
        base: pr.base.ref,
        intoDefault: pr.base.ref === repo.default_branch,
        mergeSha: merged ? pr.merge_commit_sha : null,
        commits,
        author: lower(pr.user?.login),
        actor,
      };
    }
  }
  if (!facts) return 'ignored';

  const stub = env.BOARD.get(env.BOARD.idFromName(`repo:${board.repoId}`));
  const out = await stub.ingestGitHub(boardInfo(board), delivery, facts);
  return out.duplicate ? 'duplicate delivery' : `${out.changes} change(s)`;
}
