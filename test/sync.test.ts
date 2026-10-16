import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoardInfo, Item, Op } from '../shared/types';
import { gh, INSTALL, useProdWorker, webhook } from './harness';

// GitHub keeps the board honest (FR-26–34): signed push, pull_request, create and delete webhooks go
// through the Worker as production runs it, with a fake GitHub behind `fetch`. Each test gets its own repo.

useProdWorker();

let nextRepo = 9100;
/** A distinct 40-hex SHA for each number, distinct in its first characters too. */
const sha = (n: number) => (n * 2654435761 % 2 ** 32).toString(16).padStart(8, '0').repeat(5);

async function newRepo(name = 'big-talk', prefix = 'BT') {
  const id = nextRepo++;
  const repoName = `${name}-${id}`;
  await env.DB.prepare(`INSERT INTO boards (repo_id, owner, repo, prefix, installation_id, archived_at, created_at) VALUES (?, 'nnewberg', ?, ?, ?, NULL, ?)`)
    .bind(id, repoName, prefix, INSTALL, new Date().toISOString()).run();
  const info: BoardInfo = { owner: 'nnewberg', repo: repoName, prefix };
  const stub = env.BOARD.get(env.BOARD.idFromName(`repo:${id}`));
  const repository = { id, name: repoName, owner: { login: 'nnewberg' }, default_branch: 'main' };
  const base = { installation: { id: INSTALL }, repository, sender: { login: 'Nick' } };

  return {
    info,
    async add(title: string, status: Item['status'] = 'up_next', ops: Op[] = []) {
      const r = await stub.apply(info, { op: 'create', title, status: status as 'up_next' }, { user: 'nick', via: 'web' });
      if (!r.ok || !('event' in r)) throw new Error('create failed');
      for (const op of ops) await stub.apply(info, { ...op, id: r.item.id } as Op, { user: 'nick', via: 'web' });
      return r.item.id;
    },
    async item(id: string) {
      return (await stub.snapshot(info)).items.find(i => i.id === id)!;
    },
    async history(id: string) {
      return stub.history(info, id);
    },
    push(branch: string, commits: { sha: string; message: string; author?: string }[], extra: Record<string, unknown> = {}, delivery?: string) {
      return webhook('push', { ...base, ref: `refs/heads/${branch}`, commits: commits.map(c => ({ id: c.sha, message: c.message, author: { username: c.author ?? 'nick' } })), ...extra }, { delivery });
    },
    branch(event: 'create' | 'delete', ref: string, sender = 'Nick') {
      return webhook(event, { ...base, sender: { login: sender }, ref, ref_type: 'branch' });
    },
    pr(action: string, pr: { number: number; title?: string; body?: string; head: string; merged?: boolean; merge_commit_sha?: string; base?: string }) {
      return webhook('pull_request', {
        ...base,
        action,
        number: pr.number,
        pull_request: { number: pr.number, title: pr.title ?? `PR ${pr.number}`, body: pr.body ?? '', merged: !!pr.merged, merge_commit_sha: pr.merge_commit_sha ?? null, head: { ref: pr.head }, base: { ref: pr.base ?? 'main' }, user: { login: 'Nick' } },
      });
    },
  };
}

describe('webhook intake (FR-29)', () => {
  it('rejects a bad signature and ignores repos without a board', async () => {
    expect((await webhook('push', {}, { secret: 'wrong' })).status).toBe(401);
    expect((await webhook('push', { repository: { id: 1, name: 'x', owner: { login: 'nnewberg' }, default_branch: 'main' }, ref: 'refs/heads/main', commits: [] })).status).toBe(204);
  });

  it('a repeated delivery changes nothing', async () => {
    const r = await newRepo();
    const id = await r.add('Retry uploads');
    await r.push('feature', [{ sha: sha(1), message: `Fixes ${id}` }], {}, 'delivery-1');
    await r.push('feature', [{ sha: sha(2), message: `Fixes ${id}` }], {}, 'delivery-1');
    expect((await r.item(id)).citations).toMatchObject([{ kind: 'pending', commit: sha(1) }]);
  });

  it('a commit already handled on the default branch is not applied twice', async () => {
    const r = await newRepo();
    const id = await r.add('Retry uploads');
    await r.push('main', [{ sha: sha(1), message: `Part of ${id}` }]);
    await r.push('main', [{ sha: sha(1), message: `Part of ${id}` }]);
    expect((await r.item(id)).notes).toHaveLength(1);
  });

  it('ignores tags', async () => {
    const r = await newRepo();
    const id = await r.add('Tagged');
    expect((await webhook('push', { repository: { id: nextRepo - 1, name: r.info.repo, owner: { login: 'nnewberg' }, default_branch: 'main' }, ref: 'refs/tags/v1', commits: [{ id: sha(1), message: `Closes ${id}`, author: {} }] })).status).toBe(204);
    expect((await r.item(id)).status).toBe('up_next');
  });
});

describe('explicit closes (FR-30, FR-34) — S5', () => {
  it('one commit on main closes two items, each linked to the commit and its PR', async () => {
    const r = await newRepo();
    const a = await r.add('Rate-limit invites');
    const b = await r.add('Invite copy');
    gh.prOf[sha(5)] = 41;
    await r.push('main', [{ sha: sha(5), message: `Invite limits (#41)\n\nCloses: ${a}, ${b}`, author: 'aaron' }]);
    for (const id of [a, b]) {
      const it = await r.item(id);
      expect(it.status).toBe('done');
      expect(it.citations).toMatchObject([{ kind: 'closes', commit: sha(5), pr: 41, how: 'explicit', author: 'aaron', branch: 'main' }]);
    }
    const hist = await r.history(a);
    expect(hist[0]).toMatchObject({ op: 'cite', actor: { user: 'aaron', via: 'github' }, meta: { text: 'Closed by', ref: 'PR #41' } });
  });

  it("a merged PR's description closes items too, and the push of the same merge counts once", async () => {
    const r = await newRepo();
    const id = await r.add('Auto-close on merge');
    await r.pr('closed', { number: 7, body: `Resolves ${id}`, head: 'feature', merged: true, merge_commit_sha: sha(7) });
    gh.prOf[sha(7)] = 7;
    await r.push('main', [{ sha: sha(7), message: `Auto-close (#7)\n\nResolves ${id}` }]);
    const it = await r.item(id);
    expect(it.status).toBe('done');
    expect(it.citations).toHaveLength(1);
    expect(it.citations[0]).toMatchObject({ kind: 'closes', commit: sha(7), pr: 7 });
  });

  it('closing an item that is already done just adds the link', async () => {
    const r = await newRepo();
    const id = await r.add('Already done', 'done');
    await r.push('main', [{ sha: sha(3), message: `Fixes ${id}` }]);
    const it = await r.item(id);
    expect(it.status).toBe('done');
    expect(it.citations).toHaveLength(1);
    expect((await r.history(id))[0]!.meta?.text).toBe('Also fixed by');
  });

  it('a close from GitHub can be undone like any other change (FR-15)', async () => {
    const r = await newRepo();
    const id = await r.add('Undo me');
    await r.push('main', [{ sha: sha(6), message: `Fixes ${id}` }]);
    const [closed] = await r.history(id);
    const stub = env.BOARD.get(env.BOARD.idFromName(`repo:${nextRepo - 1}`));
    await stub.apply(r.info, { op: 'undo', seq: closed!.seq }, { user: 'nick', via: 'web' });
    const it = await r.item(id);
    expect(it.status).toBe('up_next');
    expect(it.citations).toEqual([]);
  });

  it('IDs from another board, and unknown IDs, are ignored', async () => {
    const r = await newRepo();
    const id = await r.add('Mine');
    await r.push('main', [{ sha: sha(4), message: 'Fixes BB-1, BT-999' }]);
    expect((await r.item(id)).status).toBe('up_next');
  });
});

describe('pending on a branch (FR-31) — S6', () => {
  it('a closing trailer on a branch adds a pending fix, and landing on main closes it', async () => {
    const r = await newRepo();
    const id = await r.add('Empty profile crash');
    await r.push('bugfix', [{ sha: sha(10), message: `Guard nil profile\n\nCloses: ${id}` }]);
    let it = await r.item(id);
    expect(it.status).toBe('up_next');
    expect(it.citations).toMatchObject([{ kind: 'pending', branch: 'bugfix', commit: sha(10) }]);

    // A force-push replaces the pending fix rather than stacking another.
    await r.push('bugfix', [{ sha: sha(11), message: `Guard nil profile\n\nCloses: ${id}` }], { forced: true });
    expect((await r.item(id)).citations).toMatchObject([{ kind: 'pending', commit: sha(11) }]);

    await r.push('main', [{ sha: sha(11), message: `Guard nil profile\n\nCloses: ${id}` }]);
    it = await r.item(id);
    expect(it.status).toBe('done');
    expect(it.citations).toMatchObject([{ kind: 'closes', commit: sha(11) }]);
  });

  it("an open PR's description adds a pending fix with its number", async () => {
    const r = await newRepo();
    const id = await r.add('Quiz nudge');
    await r.pr('opened', { number: 12, body: `Closes ${id}`, head: 'quiz' });
    expect((await r.item(id)).citations).toMatchObject([{ kind: 'pending', pr: 12, branch: 'quiz' }]);
  });

  it('deleting the branch drops its pending fix', async () => {
    const r = await newRepo();
    const id = await r.add('Abandoned fix');
    await r.push('try-it', [{ sha: sha(12), message: `Fixes ${id}` }]);
    await r.branch('delete', 'try-it');
    expect((await r.item(id)).citations).toEqual([]);
  });
});

describe('partial progress (FR-30) — S8', () => {
  it('Refs and bare mentions on main add a dated note citing the commit, and never close', async () => {
    const r = await newRepo();
    const id = await r.add('Thumbnails');
    gh.prOf[sha(20)] = 30;
    await r.push('main', [{ sha: sha(20), message: `Server half of thumbnails\n\nRefs: ${id}` }, { sha: sha(21), message: `Tidy, follow-up to ${id}` }]);
    const it = await r.item(id);
    expect(it.status).toBe('up_next');
    expect(it.notes).toMatchObject([
      { text: 'Server half of thumbnails', commit: sha(20), pr: 30, actor: 'nick', via: 'github' },
      { text: `Tidy, follow-up to ${id}`, commit: sha(21) },
    ]);
  });

  it('mentions on a feature branch wait until they land', async () => {
    const r = await newRepo();
    const id = await r.add('Thumbnails');
    await r.push('feature', [{ sha: sha(22), message: `Refs: ${id}` }]);
    expect((await r.item(id)).notes).toEqual([]);
  });
});

describe('PR links and reverts (FR-33) — S9', () => {
  it("a merged PR's number is attached to citations from its commits", async () => {
    const r = await newRepo();
    const id = await r.add('Retry uploads');
    await r.push('main', [{ sha: sha(30), message: `Retry with backoff\n\nFixes ${id}` }]);
    expect((await r.item(id)).citations[0]!.pr).toBeUndefined();
    gh.prCommits[31] = [{ sha: sha(30), message: `Retry with backoff\n\nFixes ${id}`, author: 'nick' }];
    await r.pr('closed', { number: 31, head: 'retry', merged: true, merge_commit_sha: sha(32) });
    expect((await r.item(id)).citations).toMatchObject([{ kind: 'closes', commit: sha(30), pr: 31 }]);
  });

  it('a revert of the closing commit reopens the item into its old column, keeping the history', async () => {
    const r = await newRepo();
    const id = await r.add('Retry uploads', 'backlog');
    await r.push('main', [{ sha: sha(40), message: `Fixes ${id}` }]);
    expect((await r.item(id)).status).toBe('done');
    await r.push('main', [{ sha: sha(41), message: `Revert "Fixes ${id}"\n\nThis reverts commit ${sha(40)}.` }]);
    const it = await r.item(id);
    expect(it.status).toBe('backlog');
    expect(it.citations).toMatchObject([{ kind: 'closes', commit: sha(40), reverted: true }]);
    expect(it.notes.at(-1)!.text).toContain('Reverted in');
    expect((await r.history(id)).map(e => e.meta?.text)).toEqual(['Reopened by a revert', 'Closed by push', 'Created']);
  });

  it('reverting a merge commit reopens what its PR closed', async () => {
    const r = await newRepo();
    const id = await r.add('Retry uploads');
    gh.prCommits[44] = [{ sha: sha(42), message: `Fixes ${id}`, author: 'nick' }];
    await r.pr('closed', { number: 44, head: 'retry', merged: true, merge_commit_sha: sha(43) });
    expect((await r.item(id)).status).toBe('done');
    await r.push('main', [{ sha: sha(45), message: `Revert "Merge pull request #44"\n\nThis reverts commit ${sha(43).slice(0, 12)}, reversing\nchanges made to ${sha(1)}.` }]);
    expect((await r.item(id)).status).toBe('up_next');
  });

  it('reverting one commit of a merged PR reopens only what that commit closed', async () => {
    const r = await newRepo();
    const a = await r.add('First fix');
    const b = await r.add('Second fix');
    gh.prCommits[46] = [{ sha: sha(46), message: `Fixes ${a}`, author: 'nick' }, { sha: sha(47), message: `Fixes ${b}`, author: 'nick' }];
    await r.pr('closed', { number: 46, head: 'two-fixes', merged: true, merge_commit_sha: sha(48) });
    await r.push('main', [{ sha: sha(49), message: `Revert "Fixes ${a}"\n\nThis reverts commit ${sha(46)}.` }]);
    expect((await r.item(a)).status).toBe('up_next');
    expect((await r.item(b)).status).toBe('done');
  });

  it("GitHub's Revert button: a merged revert PR reopens what the reverted PR closed", async () => {
    const r = await newRepo();
    const id = await r.add('Quiz nudge');
    await r.pr('closed', { number: 50, body: `Closes ${id}`, head: 'quiz', merged: true, merge_commit_sha: sha(50) });
    await r.pr('closed', { number: 51, title: 'Revert "Quiz nudge"', body: `Reverts nnewberg/${r.info.repo}#50`, head: 'revert-50-quiz', merged: true, merge_commit_sha: sha(51) });
    const it = await r.item(id);
    expect(it.status).toBe('up_next');
    expect(it.citations[0]).toMatchObject({ pr: 50, reverted: true });
  });
});

describe('branch claims (FR-26, FR-27, FR-28) — S4', () => {
  it('pushing a branch named for an item claims it for the pusher; deleting the branch releases it', async () => {
    const r = await newRepo();
    const id = await r.add('Geo filter', 'backlog');
    const branch = `${id.toLowerCase()}-geo-filter`;
    await r.branch('create', branch, 'Kevin');
    let it = await r.item(id);
    expect(it.status).toBe('in_progress');
    expect(it.claim).toMatchObject({ user: 'kevin', kind: 'branch', ref: branch });

    // The push that follows the create doesn't add another event.
    const before = (await r.history(id)).length;
    await r.push(branch, [{ sha: sha(60), message: 'wip' }], { created: true, sender: { login: 'Kevin' } });
    expect((await r.history(id)).length).toBe(before);

    await r.branch('delete', branch, 'Kevin');
    it = await r.item(id);
    expect(it.status).toBe('backlog');
    expect(it.claim).toBeNull();
  });

  it("doesn't take an item someone else holds; it says so in a note, once", async () => {
    const r = await newRepo();
    const id = await r.add('Geo filter', 'up_next', [{ op: 'claim', id: '' }]);
    await r.branch('create', `${id}-mine-too`, 'Kevin');
    await r.push(`${id}-mine-too`, [{ sha: sha(61), message: 'wip' }], { sender: { login: 'Kevin' } });
    const it = await r.item(id);
    expect(it.claim).toMatchObject({ user: 'nick', kind: 'manual' });
    expect(it.notes.map(n => n.text)).toEqual([`kevin pushed branch ${id}-mine-too, but nick has ${id}.`]);
  });

  it("turns the pusher's own session claim into a branch claim, which outlives the session", async () => {
    const r = await newRepo();
    const id = await r.add('Geo filter', 'up_next', [{ op: 'claim', id: '', kind: 'session', ref: '3f2a' }]);
    await r.branch('create', `nick/${id}`);
    expect((await r.item(id)).claim).toMatchObject({ user: 'nick', kind: 'branch', ref: `nick/${id}` });
  });

  it('merging the branch closes the item it is named for, marked "via branch"', async () => {
    const r = await newRepo();
    const id = await r.add('Rate-limit invites');
    const branch = `${id.toLowerCase()}-rate-limit`;
    await r.branch('create', branch);
    gh.prCommits[70] = [{ sha: sha(70), message: 'Add limiter', author: 'nick' }];
    await r.pr('closed', { number: 70, title: 'Rate limiting', head: branch, merged: true, merge_commit_sha: sha(71) });
    const it = await r.item(id);
    expect(it.status).toBe('done');
    expect(it.claim).toMatchObject({ user: 'nick', kind: 'branch' });
    expect(it.citations).toMatchObject([{ kind: 'closes', how: 'branch', pr: 70, commit: sha(71) }]);
  });

  it('…unless the PR said Refs for it: then the claim ends and the item stays open, with a note', async () => {
    const r = await newRepo();
    const id = await r.add('Thumbnails', 'backlog');
    const branch = `${id.toLowerCase()}-server-half`;
    await r.branch('create', branch);
    gh.prCommits[72] = [{ sha: sha(72), message: `Server half\n\nRefs: ${id}`, author: 'nick' }];
    await r.pr('closed', { number: 72, head: branch, merged: true, merge_commit_sha: sha(73) });
    const it = await r.item(id);
    expect(it.status).toBe('backlog');
    expect(it.claim).toBeNull();
    expect(it.notes.at(-1)!.text).toContain('partial progress');
  });

  it('tags and the default branch never claim', async () => {
    const r = await newRepo();
    const id = await r.add('Tag me');
    await webhook('create', { installation: { id: INSTALL }, repository: { id: nextRepo - 1, name: r.info.repo, owner: { login: 'nnewberg' }, default_branch: 'main' }, sender: { login: 'nick' }, ref: `${id}-release`, ref_type: 'tag' });
    expect((await r.item(id)).claim).toBeNull();
  });
});
