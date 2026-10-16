#!/usr/bin/env node
// Acceptance tests for GitHub sync (PRD §9.1 step 1, scenarios S4–S9), against the live Worker and the
// private sandbox repo. Each scenario adds fresh items with the built `punch`, does real work with `git`
// and `gh` in a throwaway clone, then waits for the board to show the result.
//
//   npm run acceptance                  every scenario
//   npm run acceptance -- S5 S9         just these
//
// Needs `punch login` (against PUNCH_URL, default production) and `gh` signed in with push access to
// the sandbox. Set SANDBOX=owner/repo to point elsewhere.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = process.env.SANDBOX ?? 'nnewberg/punchlist-sandbox';
const PUNCH = join(ROOT, 'cli/dist/punch.mjs');
const TIMEOUT_MS = Number(process.env.ACCEPTANCE_TIMEOUT_MS ?? 60_000);
// Tags this run's items and branches. The `r` keeps it from ever reading as an item ID in a branch name.
const run = `r${Date.now().toString(36)}`;

const dim = s => `\x1b[2m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;

// ---- Shell helpers ----

let dir;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const git = (...a) => sh('git', a);
const gh = (...a) => sh('gh', a);
const punch = (...a) => JSON.parse(sh(process.execPath, [PUNCH, ...a, '--json']));

// ---- Board helpers ----

async function add(title, status = 'next') {
  const r = punch('add', `${title} [${run}]`, '-s', status);
  if (!r.ok) throw new Error(`punch add failed: ${JSON.stringify(r)}`);
  return r.item.id;
}
const show = id => punch('show', id).item;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Polls the board until `check(item)` holds; fails with the last item seen. */
async function waitFor(id, what, check) {
  const start = Date.now();
  let it;
  for (;;) {
    it = show(id);
    try {
      if (check(it)) {
        console.log(`    ${green('✓')} ${id} ${what} ${dim(`(${((Date.now() - start) / 1000).toFixed(1)}s)`)}`);
        return it;
      }
    } catch {
      // not there yet
    }
    if (Date.now() - start > TIMEOUT_MS) {
      throw new Error(`${id} never ${what}. Last seen: ${JSON.stringify({ status: it.status, claim: it.claim, citations: it.citations, notes: it.notes.slice(-2) }, null, 2)}`);
    }
    await sleep(1500);
  }
}

const live = it => it.citations.filter(c => !c.reverted);
const closes = it => live(it).filter(c => c.kind === 'closes');
const pending = it => live(it).filter(c => c.kind === 'pending');

// ---- Git helpers ----

/** A real change (GitHub won't squash-merge a PR with no diff), committed with this message. */
function commit(message) {
  mkdirSync(join(dir, 'log'), { recursive: true });
  appendFileSync(join(dir, 'log', `${run}.txt`), `${message.split('\n')[0]}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}
function branch(name) {
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  git('checkout', '-q', '-b', name);
}
const push = name => git('push', '-q', '-u', 'origin', name);
function onMain() {
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
}
function openPr(head, title, body = '') {
  const url = gh('pr', 'create', '--repo', SANDBOX, '--base', 'main', '--head', head, '--title', title, '--body', body);
  return Number(/\/pull\/(\d+)/.exec(url)[1]);
}
/** Merges a PR. GitHub sometimes refuses a merge right after a PR opens ("Base branch was modified"), so it retries. */
function mergePr(n, how) {
  for (let attempt = 1; ; attempt++) {
    try {
      return gh('pr', 'merge', String(n), '--repo', SANDBOX, `--${how}`, '--delete-branch');
    } catch (e) {
      if (attempt >= 4 || !/Base branch was modified|not mergeable|try the merge again/i.test(String(e.stderr))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * attempt);
    }
  }
}

// ---- Scenarios ----

const scenarios = {
  async S4() {
    console.log('  A pushed branch named for an item claims it; deleting the branch releases it (FR-26, FR-28)');
    const id = await add('S4 geo filter', 'backlog');
    const name = `${id.toLowerCase()}-geo-filter-${run}`;
    branch(name);
    commit('Start the geo filter');
    push(name);
    const me = punch('whoami').user;
    await waitFor(id, `is In Progress, held by ${me} on ${name}`, it => it.status === 'in_progress' && it.claim?.kind === 'branch' && it.claim.ref === name && it.claim.user === me);
    git('push', '-q', 'origin', '--delete', name);
    await waitFor(id, 'is released back to Backlog', it => it.status === 'backlog' && !it.claim);
  },

  async S5() {
    console.log('  One merge closes two items, each linked to the commit and PR (FR-30, FR-33), for each merge method');
    for (const how of ['squash', 'merge', 'rebase']) {
      const a = await add(`S5 ${how} rate-limit invites`);
      const b = await add(`S5 ${how} invite copy`);
      const name = `s5-${how}-${run}`;
      branch(name);
      commit(`Invite limits (${how})\n\nCloses: ${a}, ${b}`);
      push(name);
      const pr = openPr(name, `Invite limits (${how})`);
      mergePr(pr, how);
      for (const id of [a, b]) await waitFor(id, `is Done, closed by PR #${pr} (${how})`, it => it.status === 'done' && closes(it).some(c => c.pr === pr && c.commit) && !pending(it).length);
    }
  },

  async S6() {
    console.log('  A fix on a branch shows as pending, and closes the item once merged (FR-31)');
    const id = await add('S6 empty profile crash');
    const name = `s6-fix-${run}`;
    branch(name);
    const sha = commit(`Guard a nil profile\n\nFixes: ${id}`);
    push(name);
    await waitFor(id, `shows a pending fix on ${name}, still in Up Next`, it => it.status === 'up_next' && pending(it).some(c => c.branch === name && c.commit === sha));
    const pr = openPr(name, 'Guard a nil profile');
    mergePr(pr, 'squash');
    await waitFor(id, `is Done via PR #${pr}, with no pending fix left`, it => it.status === 'done' && closes(it).some(c => c.pr === pr) && !pending(it).length);

    const id2 = await add('S6 quiz nudge (PR description)');
    const name2 = `s6-pr-body-${run}`;
    branch(name2);
    commit('Nudge after two days');
    push(name2);
    const pr2 = openPr(name2, 'Quiz nudge', `Closes ${id2}`);
    await waitFor(id2, `shows a pending fix in PR #${pr2}`, it => it.status === 'up_next' && pending(it).some(c => c.pr === pr2));
    mergePr(pr2, 'squash');
    await waitFor(id2, `is Done via PR #${pr2}`, it => it.status === 'done' && closes(it).some(c => c.pr === pr2));
  },

  async S7() {
    console.log(dim('  Inferred closes (FR-32) come in step 3 of §9.1; skipped.'));
  },

  async S8() {
    console.log('  Partial progress adds a note citing the commit, and never closes (FR-30)');
    const id = await add('S8 thumbnails');
    onMain();
    const sha = commit(`Server half of thumbnails\n\nRefs: ${id}`);
    git('push', '-q', 'origin', 'main');
    await waitFor(id, 'has a note citing the commit and is still open', it => it.status === 'up_next' && it.notes.some(n => n.commit === sha));

    const id2 = await add('S8 thumbnails client', 'backlog');
    const name = `${id2.toLowerCase()}-client-half-${run}`;
    branch(name);
    commit(`Client half, more to do\n\nRefs: ${id2}`);
    push(name);
    await waitFor(id2, 'is claimed by its branch', it => it.claim?.ref === name);
    const pr = openPr(name, 'Client half of thumbnails');
    mergePr(pr, 'squash');
    await waitFor(id2, 'stays open after the merge, released, with a note', it => it.status === 'backlog' && !it.claim && it.notes.some(n => n.text.includes('partial progress')));

    console.log('  …while a branch named for an item, merged without Refs, closes it');
    const id3 = await add('S8 tidy invites');
    const name3 = `${id3.toLowerCase()}-tidy-${run}`;
    branch(name3);
    commit('Tidy the invite screen');
    push(name3);
    const pr3 = openPr(name3, 'Tidy invites');
    mergePr(pr3, 'squash');
    await waitFor(id3, `is Done via its branch, PR #${pr3}`, it => it.status === 'done' && closes(it).some(c => c.how === 'branch' && c.pr === pr3));
  },

  async S9() {
    console.log('  A revert reopens the item; reopening by hand keeps the history (FR-33, FR-15)');
    const id = await add('S9 retry uploads', 'backlog');
    onMain();
    const sha = commit(`Retry uploads with backoff\n\nFixes ${id}`);
    git('push', '-q', 'origin', 'main');
    await waitFor(id, 'is Done', it => it.status === 'done');
    git('revert', '--no-edit', sha);
    git('push', '-q', 'origin', 'main');
    await waitFor(id, 'is back in Backlog after the revert, its close marked reverted', it => it.status === 'backlog' && it.citations.some(c => c.commit === sha && c.reverted));

    const id2 = await add('S9 quiz nudge');
    const name = `s9-quiz-${run}`;
    branch(name);
    commit('Quiz nudge');
    push(name);
    const pr = openPr(name, 'Quiz nudge', `Closes ${id2}`);
    mergePr(pr, 'squash');
    await waitFor(id2, `is Done via PR #${pr}`, it => it.status === 'done');
    // What GitHub's Revert button does, through its API.
    const nodeId = gh('pr', 'view', String(pr), '--repo', SANDBOX, '--json', 'id', '-q', '.id');
    const revert = JSON.parse(gh('api', 'graphql', '-f', `query=mutation { revertPullRequest(input: {pullRequestId: "${nodeId}"}) { revertPullRequest { number } } }`));
    const revertPr = revert.data.revertPullRequest.revertPullRequest.number;
    mergePr(revertPr, 'squash');
    await waitFor(id2, `reopens when revert PR #${revertPr} merges`, it => it.status === 'up_next' && it.citations.some(c => c.pr === pr && c.reverted));

    const id3 = await add('S9 wrong close');
    punch('close', id3);
    punch('reopen', id3);
    const history = punch('show', id3).history.map(e => e.meta?.text);
    if (!(history[0] === 'Reopened' && history[1] === 'Closed')) throw new Error(`${id3} history is ${JSON.stringify(history)}`);
    console.log(`    ${green('✓')} ${id3} keeps the close and the reopen in its history`);
  },
};

// ---- Run ----

const wanted = process.argv.slice(2).map(s => s.toUpperCase());
const picked = Object.keys(scenarios).filter(k => !wanted.length || wanted.includes(k));
if (!picked.length) {
  console.error(`No scenarios match ${wanted.join(' ')}. There are ${Object.keys(scenarios).join(', ')}.`);
  process.exit(2);
}

dir = mkdtempSync(join(tmpdir(), 'punchlist-acceptance-'));
let failed = 0;
try {
  sh('gh', ['repo', 'clone', SANDBOX, dir, '--', '-q'], { cwd: ROOT });
  console.log(dim(`Run ${run} on ${SANDBOX}, board as ${punch('whoami').user}`));
  for (const name of picked) {
    console.log(`\n${name}`);
    try {
      await scenarios[name]();
    } catch (e) {
      failed++;
      console.log(`    ${red('✗')} ${e.stderr?.toString().trim() || e.message}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? red(`\n${failed} of ${picked.length} scenarios failed`) : green(`\nAll ${picked.length} scenarios passed`));
process.exit(failed ? 1 : 0);
