#!/usr/bin/env node
// One-off backfill for PL-013: Done cards show the branch the work was done on, which for an item
// closed by a merged PR is that PR's head branch. Closes citations made before Punchlist recorded it
// carry the PR number but no head branch; this fills them in.
//
//   node scripts/backfill-heads.mjs owner/repo [--url https://punchlist.<subdomain>.workers.dev] [--apply]
//
// Reads the board with your `punch` token (from `punch login`, or PUNCH_TOKEN), asks GitHub for each
// closing PR's head branch with `gh api` (so `gh` must be signed in with access to the repo), and
// prints what it would record. With --apply it sends that to the board, which records each as an
// ordinary `link_pr` event: it only fills in citations that have no head branch yet, shows up in the
// items' history, and can be undone. Running it twice changes nothing the second time.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const slug = args.find(a => /^[\w.-]+\/[\w.-]+$/.test(a));
const urlAt = args.indexOf('--url');
const apply = args.includes('--apply');
if (!slug) {
  console.error('Usage: node scripts/backfill-heads.mjs owner/repo [--url https://…] [--apply]');
  process.exit(1);
}
const [owner, repo] = slug.split('/');

// The same settings and token `punch` uses (cli/config.ts).
const home = process.env.PUNCH_HOME;
const configDir = home ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'punchlist');
const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const base = (urlAt >= 0 ? args[urlAt + 1] : process.env.PUNCH_URL ?? readJson(join(configDir, 'config.json'))?.url ?? 'https://punchlist.nnewberg.workers.dev').replace(/\/+$/, '');

async function token() {
  if (process.env.PUNCH_TOKEN) return process.env.PUNCH_TOKEN;
  if (!process.env.PUNCH_NO_KEYCHAIN) {
    try {
      const { Entry } = await import('@napi-rs/keyring');
      const t = new Entry('punchlist', home ? `${base}#${home}` : base).getPassword();
      if (t) return t;
    } catch {
      // fall through to the file
    }
  }
  const file = join(configDir, `token-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
}

const auth = await token();
if (!auth) {
  console.error(`No punch token for ${base}. Run \`punch login\`, or set PUNCH_TOKEN.`);
  process.exit(1);
}
const boardUrl = `${base}/v1/boards/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
async function api(method, path, body) {
  const res = await fetch(`${boardUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'x-punch-via': 'cli', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${boardUrl}${path}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// Every closing PR whose citation has no head branch yet, and the items it closed.
const { items } = await api('GET', '');
const need = new Map();
for (const it of items) {
  for (const c of it.citations) {
    if (c.kind !== 'closes' || !c.pr || c.head) continue;
    need.set(c.pr, [...new Set([...(need.get(c.pr) ?? []), it.id])]);
  }
}
if (!need.size) {
  console.log(`Nothing to backfill on ${owner}/${repo}.`);
  process.exit(0);
}

const heads = {};
for (const [pr, ids] of [...need].sort((a, b) => a[0] - b[0])) {
  let ref = null;
  try {
    ref = execFileSync('gh', ['api', `repos/${owner}/${repo}/pulls/${pr}`, '--jq', '.head.ref'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
  } catch (e) {
    console.warn(`PR #${pr}: couldn't look it up (${String(e.stderr ?? e.message).trim()}); skipped`);
    continue;
  }
  if (!ref) continue;
  heads[pr] = ref;
  console.log(`PR #${pr} → ${ref}  (${ids.join(', ')})`);
}

if (!apply) {
  console.log(`\n${Object.keys(heads).length} PR(s). Dry run: nothing sent. Run again with --apply to record them.`);
  process.exit(0);
}
const out = await api('POST', '/heads', { heads });
console.log(`\nRecorded head branches on ${out.ids.length} item(s): ${out.ids.join(', ') || 'none'}`);
