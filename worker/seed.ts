import { generateNKeysBetween } from 'fractional-indexing';
import type { Actor, BoardEvent, Claim, Item, Status } from '../shared/types';

// Dev-only sample boards, taken from the Claude Design mock (Punchlist.dc.html) so the UI can be
// checked against it. Loaded into an empty board only when DEV_MODE is set.

type Who = { who: string; agent?: boolean; session?: string };
interface SeedItem {
  id: string;
  title: string;
  status: Status;
  tags?: string[];
  body?: string;
  claim?: { user: string; kind: Claim['kind']; ref?: string; age?: string };
  blocked?: { reason: string; age?: string };
  deps?: string[];
  deferred?: boolean;
  done?: { sha: string; pr?: number; age: string; inferred?: number; message?: string };
  /** A closing commit pushed to a branch, not merged yet (FR-31). */
  pending?: { sha: string; branch: string; age: string; message?: string };
  notes?: (Who & { age: string; text: string; commit?: string })[];
  /** Newest first, as in the design. */
  activity?: (Who & { text: string; ref?: string; msg?: string; age: string })[];
  created?: Who & { age: string };
}

const BT: SeedItem[] = [
  { id: 'BT-037', title: 'Nightly backup of Postgres to R2', status: 'backlog', tags: ['infra'], deferred: true,
    body: 'Filed from a chat session while working on BT-009. Daily pg_dump to the same bucket, 14-day retention.',
    activity: [{ who: 'nick', agent: true, session: '3f2a', text: 'Added from chat', age: '2m' }] },
  { id: 'BT-035', title: 'Glanceable conversation openers', status: 'backlog', tags: ['ux'],
    body: 'Show the first line of each opener on the home list so you can pick one without opening it.' },
  { id: 'BT-036', title: 'Export a conversation as PDF', status: 'backlog', tags: ['ios'] },
  { id: 'BT-029', title: 'Dark mode for the reader view', status: 'backlog', tags: ['ux', 'ios'] },
  { id: 'BT-031', title: 'Dedupe contacts imported twice from iCloud', status: 'backlog', tags: ['bug'] },
  { id: 'BT-030', title: '"Add to your profile" returns you to a profile that hasn\'t counted the conversation yet', status: 'up_next', tags: ['ux', 'profile'], deps: ['BT-007a'],
    body: [
      "Finishing a conversation and tapping Add to your profile returns you to a profile whose count hasn't moved. A pull-to-refresh fixes it, which is exactly the kind of thing people won't do.",
      '## Repro', '- Finish any conversation\n- Tap Add to your profile\n- Profile shows the old count (3) until you refresh',
      '## Likely cause', 'The recount runs before the write commits. The fix belongs in BT-007a; this item should wait on it and then verify the navigation path.',
      '```\nGET /profile/me\n→ counts.conversations = 3   (expected 4)\n```',
    ].join('\n\n'),
    notes: [
      { who: 'nick', age: '2d', text: 'Repro on iOS 18.1 and web. Count catches up after refresh.' },
      { who: 'nick', agent: true, session: '3f2a', age: '1d', text: 'Root cause confirmed: the recount fires before the write commits. Tracked in BT-007a; leaving this Up Next until it lands.' },
    ],
    activity: [
      { who: 'nick', agent: true, session: '3f2a', text: 'Pushed', ref: '2d9f3c1', msg: 'Add failing test for profile recount', age: '1d' },
      { who: 'nick', agent: true, session: '3f2a', text: 'Added dependency', ref: 'BT-007a', age: '1d' },
      { who: 'nick', agent: true, session: '3f2a', text: 'Moved to Up Next', age: '1d' },
      { who: 'nick', text: 'Created from chat', age: '2d' },
    ] },
  { id: 'BT-032', title: 'Invite email lands in Gmail Promotions', status: 'up_next', tags: ['backend'],
    body: 'Plain-text alternative, drop the tracking pixel, and move the CTA out of the first line.' },
  { id: 'BT-028', title: 'Onboarding: let people skip the photo step', status: 'up_next', tags: ['ios'],
    notes: [{ who: 'nick', age: '5h', text: 'copy approved; needs the feature flag wired' }] },
  { id: 'BT-014', title: 'Rate-limit the invite endpoint', status: 'in_progress', tags: ['backend'], claim: { user: 'aaron', kind: 'branch', ref: 'bt-014-rate-limit', age: '3h' },
    body: 'Invites are unauthenticated; a script can enumerate codes. Cap at 5/min per IP and 20/day per account.',
    activity: [
      { who: 'aaron', text: 'Opened', ref: 'PR #41', age: '20m' },
      { who: 'aaron', text: 'Pushed', ref: 'a0b3e77', msg: 'Tests for per-account cap', age: '1h' },
      { who: 'aaron', text: 'Pushed', ref: '1f8c2d4', msg: 'Add token-bucket middleware', age: '3h' },
      { who: 'aaron', text: 'Started on branch bt-014-rate-limit', age: '6h' },
      { who: 'nick', agent: true, session: '3f2a', text: 'Created from chat', age: '2d' },
    ] },
  { id: 'BT-007a', title: 'Recount conversations on profile write', status: 'in_progress', tags: ['backend'], claim: { user: 'nick', kind: 'session', ref: '3f2a', age: '40m' },
    body: 'Move the recount into the same transaction as the profile write so counts are correct on the next read.',
    notes: [{ who: 'nick', agent: true, session: '3f2a', age: '12m', text: 'Server side done in 7e1c9a2; migrating the two call sites now.', commit: '7e1c9a2' }],
    activity: [
      { who: 'nick', agent: true, session: '3f2a', text: 'Started', age: '40m' },
      { who: 'nick', agent: true, session: '3f2a', text: 'Split out of', ref: 'BT-030', age: '1d' },
    ] },
  { id: 'BT-021', title: 'Photo upload progress bar', status: 'in_progress', tags: ['ios'], claim: { user: 'nick', kind: 'branch', ref: 'bt-021-upload-progress', age: '1d' },
    body: 'Show determinate progress for uploads over 1 MB.',
    pending: { sha: '5c0a1d9e4b7f2a6c8d3e1f0a9b8c7d6e5f4a3b2c', branch: 'bt-021-upload-progress', age: '4h', message: 'Determinate upload progress' },
    activity: [{ who: 'github', text: 'Fix pending', ref: 'bt-021-upload-progress', msg: 'Determinate upload progress', age: '4h' }, { who: 'nick', text: 'Created', age: '3d' }] },
  { id: 'BT-033', title: 'Quiz progress nudge', status: 'done', tags: ['ios'], done: { sha: '64a1083', pr: 38, age: '2h' }, claim: { user: 'aaron', kind: 'branch', ref: 'bt-033-quiz-nudge' },
    activity: [{ who: 'github', text: 'Closed by', ref: 'PR #38', age: '2h' }, { who: 'aaron', text: 'Started on branch bt-033-quiz-nudge', age: '1d' }] },
  { id: 'BT-009', title: 'Retry failed photo uploads to R2', status: 'done', tags: ['ios', 'infra'], done: { sha: '4772d30', age: '3h', inferred: 0.86, message: 'retry R2 uploads with backoff' }, claim: { user: 'nick', kind: 'session', ref: '9d41' },
    body: 'Uploads to R2 fail silently on flaky networks. Retry 3× with backoff and surface a toast on final failure.',
    activity: [
      { who: 'github', text: 'Closed by push', ref: '4772d30', msg: 'retry R2 uploads with backoff', age: '3h' },
      { who: 'nick', agent: true, session: '9d41', text: 'Moved to In Progress', age: '1d' },
    ] },
  { id: 'BT-027', title: 'Push notification for a new reply', status: 'done', tags: ['ios'], done: { sha: 'b7d02e1', pr: 37, age: '1d' }, claim: { user: 'nick', kind: 'branch', ref: 'bt-027-reply-push' } },
  { id: 'BT-019', title: 'Crash opening an empty profile', status: 'done', tags: ['bug'], done: { sha: 'e71b0aa', pr: 35, age: '2d' }, claim: { user: 'aaron', kind: 'branch', ref: 'bt-019-empty-profile' } },
  // Older than the 14-day Done window, so "Show N older" has something to expand.
  { id: 'BT-008', title: 'Conversation list skeleton while loading', status: 'done', tags: ['ux'], done: { sha: 'cc16d77', age: '3w' } },
  { id: 'BT-006', title: 'Crash reporting for the iOS app', status: 'done', tags: ['ios', 'infra'], done: { sha: '91ab4c0', pr: 22, age: '4w' } },
  { id: 'BT-005', title: 'Invite flow through the share sheet', status: 'done', tags: ['ios'], done: { sha: '0d3e8f2', pr: 19, age: '5w' } },
  { id: 'BT-003', title: 'Move media storage to R2', status: 'done', tags: ['infra'], done: { sha: '7a61b9e', pr: 12, age: '7w' } },
  { id: 'BT-001', title: 'Sign in with Apple', status: 'done', tags: ['ios'], done: { sha: '3c90d14', pr: 4, age: '9w' } },
];

const BB: SeedItem[] = [
  { id: 'BB-044', title: 'Retry logic for Apify backfills', status: 'backlog', tags: ['backend'], deferred: true,
    body: 'Backfills die on the first 429. Retry with jitter, then park the run instead of failing the whole batch.',
    activity: [{ who: 'kevin', agent: true, session: '9b1c', text: 'Added from chat', age: '5h' }] },
  { id: 'BB-026', title: 'Flyer images are slow to load', status: 'up_next', tags: ['perf'],
    notes: [{ who: 'nick', age: '6h', text: 'client cache fixed in b892a07; server-side thumbnails still pending', commit: 'b892a07' }],
    activity: [{ who: 'nick', text: 'Pushed', ref: 'b892a07', msg: 'Cache flyer images on the client', age: '6h' }, { who: 'nick', text: 'Created', age: '4d' }] },
  { id: 'BB-040', title: 'Ship to TestFlight', status: 'up_next', tags: ['release'], blocked: { reason: 'needs Apple Developer account', age: '2d' },
    body: 'Archive upload fails until the paid developer account is approved.',
    activity: [{ who: 'kevin', text: 'Marked blocked: needs Apple Developer account', age: '2d' }] },
  { id: 'BB-031', title: 'Geographic filtering for the event feed', status: 'in_progress', tags: ['backend', 'ios'], claim: { user: 'kevin', kind: 'session', ref: '9b1c', age: '2h' } },
  { id: 'BB-012', title: 'Tour dates from label accounts land as local events', status: 'in_progress', tags: ['bug'], claim: { user: 'kevin', kind: 'branch', ref: 'bb-012-tour-dates', age: '5h' } },
  { id: 'BB-018', title: 'Dedupe venues by street address', status: 'in_progress', tags: ['backend'], claim: { user: 'nick', kind: 'branch', ref: 'bb-018-venue-dedupe', age: '1d' } },
];

export const SEEDS: Record<string, SeedItem[]> = {
  'futureleisurefoundation/big-talk': BT,
  'nnewberg/bulletin-bee': BB,
};

const UNIT: Record<string, number> = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
const ago = (now: number, a: string) => new Date(now - Number(a.slice(0, -1)) * UNIT[a.slice(-1)]!).toISOString();
const actorOf = (w: Who): Actor =>
  w.who === 'github' ? { user: null, via: 'github' } : { user: w.who, via: w.agent ? 'claude' : 'web', ...(w.session ? { session: w.session } : {}) };

export function buildSeed(key: string, now = Date.now()): { items: Item[]; events: Omit<BoardEvent, 'seq'>[] } | null {
  const seed = SEEDS[key];
  if (!seed) return null;
  const ranks = new Map<string, string>();
  for (const status of ['backlog', 'up_next', 'in_progress', 'done'] as const) {
    const col = seed.filter(s => s.status === status);
    generateNKeysBetween(null, null, col.length).forEach((r, i) => ranks.set(col[i]!.id, r));
  }

  const items: Item[] = [];
  const events: Omit<BoardEvent, 'seq'>[] = [];
  for (const s of seed) {
    const activity = s.activity ?? [
      ...(s.done ? [{ who: 'github', text: s.done.pr ? 'Closed by' : 'Closed by push', ref: s.done.pr ? `PR #${s.done.pr}` : s.done.sha, age: s.done.age }] : []),
      { who: 'nick', text: 'Created', age: s.done ? bump(s.done.age) : '3d' },
    ];
    const createdEv = activity[activity.length - 1]!;
    const created_at = ago(now, createdEv.age);
    const creator = createdEv.who === 'github' ? 'nick' : createdEv.who;
    items.push({
      id: s.id,
      title: s.title,
      body: s.body ?? '',
      status: s.status,
      rank: ranks.get(s.id)!,
      blocked: s.blocked ? { reason: s.blocked.reason, since: ago(now, s.blocked.age ?? '1d') } : null,
      tags: s.tags ?? [],
      depends_on: s.deps ?? [],
      aliases: [],
      source: s.deferred
        ? { kind: 'claude-deferred', actor: creator, ref: `session ${activity[0]!.session ?? ''}`.trim() }
        : { kind: createdEv.agent || /chat/.test(createdEv.text) ? 'chat' : 'web', actor: creator },
      created_at,
      created_by: creator,
      claim: s.claim ? { user: s.claim.user, kind: s.claim.kind, ...(s.claim.ref ? { ref: s.claim.ref } : {}), since: ago(now, s.claim.age ?? (s.done ? bump(s.done.age) : '1d')) } : null,
      citations: s.done
        ? [{ kind: 'closes', commit: s.done.sha, ...(s.done.pr ? { pr: s.done.pr } : {}), branch: 'main', how: s.done.inferred ? 'inferred' : 'explicit', confidence: s.done.inferred ?? null, at: ago(now, s.done.age), ...(s.done.message ? { message: s.done.message } : {}) }]
        : s.pending
          ? [{ kind: 'pending', commit: s.pending.sha, branch: s.pending.branch, how: 'explicit', confidence: null, at: ago(now, s.pending.age), ...(s.pending.message ? { message: s.pending.message } : {}) }]
          : [],
      notes: (s.notes ?? []).map(n => ({ at: ago(now, n.age), actor: n.who, via: n.agent ? 'claude' : 'web', ...(n.session ? { session: n.session } : {}), ...(n.commit ? { commit: n.commit } : {}), text: n.text })),
      body_version: 0,
      ...(s.status === 'done' ? { prev_status: 'in_progress' as const, closed_at: ago(now, s.done!.age) } : {}),
      ...(s.status === 'in_progress' ? { prev_status: 'up_next' as const } : {}),
      updated_at: ago(now, activity[0]!.age),
    });
    for (const a of [...activity].reverse()) {
      events.push({ ts: ago(now, a.age), actor: actorOf(a), item_id: s.id, op: 'seed', meta: { text: a.text, ...(a.ref ? { ref: a.ref } : {}), ...(a.msg ? { msg: a.msg } : {}) }, undoable: false });
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { items, events };
}

/** A slightly older age, for synthesising a "Created" event before a close. */
function bump(a: string): string {
  const n = Number(a.slice(0, -1));
  return `${n * 2}${a.slice(-1)}`;
}
