#!/usr/bin/env node
// Acceptance tests for the Claude Code plugin (PRD §9.1 step 2: S1, S2, S4 and S10), against the live
// Worker and the sandbox repo. Each scenario runs headless Claude Code (`claude -p`) in a clone of the
// sandbox with this checkout's plugin and freshly built CLI, then checks what the board shows.
//
//   npm run acceptance:plugin               every scenario
//   npm run acceptance:plugin -- S1 S4      just these
//
// Person A is whoever `punch login` signed in. Person B, a second GitHub account with write access to
// the sandbox, is signed in under its own PUNCH_HOME:
//
//   PUNCH_HOME=~/.config/punchlist-b punch login
//   PUNCH_HOME_B=~/.config/punchlist-b npm run acceptance:plugin
//
// Without PUNCH_HOME_B, person A's other session plays B, which checks the same-person warning instead.
// Model calls are real: about a dollar a run with Sonnet. MODEL picks another model.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = process.env.SANDBOX ?? 'nnewberg/punchlist-sandbox';
const PUNCH = join(ROOT, 'cli/dist/punch.mjs');
const PLUGIN = join(ROOT, 'plugins/punchlist');
const MODEL = process.env.MODEL ?? 'sonnet';
const HOME_B = process.env.PUNCH_HOME_B;
const run = `r${Date.now().toString(36)}`;

const dim = s => `\x1b[2m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;

// ---- Helpers ----

let dir;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, ...opts }).trim();

/** The built `punch`, as person A (or B with `as: 'b'`), optionally inside a Claude session. */
function punch(args, { as = 'a', session } = {}) {
  const env = { ...process.env, ...(as === 'b' && HOME_B ? { PUNCH_HOME: HOME_B } : {}), ...(session ? { PUNCH_SESSION: session } : {}) };
  delete env.CLAUDE_ENV_FILE;
  if (!session) delete env.PUNCH_SESSION;
  return JSON.parse(sh(process.execPath, [PUNCH, ...args, '--json'], { env }));
}
const show = id => punch(['show', id]);
/** Items whose title carries this run's tag and these words. */
const findItems = words => punch(['search', `${words} ${run}`]).matches.map(m => m.item).filter(i => i.title.includes(run));

/** Headless Claude Code with the plugin. Returns its reply, its session id and the shell commands it ran. */
function claude(prompt, { as = 'a', tools = 'Bash(punch *)' } = {}) {
  const env = { ...process.env, PUNCH_CLI: PUNCH, ...(as === 'b' && HOME_B ? { PUNCH_HOME: HOME_B } : {}) };
  delete env.PUNCH_SESSION;
  delete env.CLAUDECODE;
  const args = ['-p', prompt, '--plugin-dir', PLUGIN, '--model', MODEL, '--output-format', 'stream-json', '--verbose'];
  if (tools) args.push('--allowedTools', tools);
  const out = sh('claude', args, { env, timeout: 300_000 });
  const events = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  if (!init?.plugins?.some(p => p.path === PLUGIN)) throw new Error(`The plugin didn't load: ${JSON.stringify(init?.plugin_errors ?? init?.plugins)}`);
  const commands = events.filter(e => e.type === 'assistant').flatMap(e => e.message.content).filter(c => c.type === 'tool_use').map(c => c.input?.command ?? c.name);
  const text = events.find(e => e.type === 'result')?.result ?? '';
  console.log(dim(`      claude${as === 'b' ? ' as B' : ''}: ${commands.join(' ; ') || '(no commands)'}`));
  return { text, session: init.session_id, commands };
}

function check(what, ok, detail) {
  if (!ok) throw new Error(`${what}${detail ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}` : ''}`);
  console.log(`    ${green('✓')} ${what}`);
}

const login = { a: null, b: null };
/** B's live Claude session: a claim made "in Kevin's open Claude window". */
const liveB = `live-b-${run}`;

// ---- Scenarios ----

const scenarios = {
  async S1() {
    console.log('  Add by chat, and a near-duplicate becomes a note (FR-21)');
    const title = `Rate-limit the invite endpoint of the ${run} service`;
    const added = claude(`Add "${title}" to the todo list.`);
    const [it, ...extra] = findItems('rate limit invite endpoint');
    check('one new item, added from chat in that Claude session', it && !extra.length && it.source.kind === 'chat' && it.source.ref === `session ${added.session}`, it ?? 'no item found');
    const second = claude(`We keep getting hammered on invites in the ${run} service. Put rate limiting for its invite endpoint on the punchlist.`);
    const after = findItems('rate limit invite endpoint');
    const notes = show(it.id).item.notes.filter(n => n.session === second.session);
    check(`no duplicate: ${it.id} got a note instead`, after.length === 1 && notes.length > 0, { items: after.map(i => i.id), reply: second.text });
  },

  async S2() {
    console.log('  Work Claude leaves for later is filed, never lost (S2)');
    const r = claude(
      `Create the file notes-${run}/hello.md containing one line: "hello". The notes-${run} folder will also need a README explaining what it's for, but leave that for later; don't write it now.`,
      { tools: 'Bash(punch *),Write,Edit' },
    );
    const snap = punch(['list']);
    const filed = snap.items.filter(i => i.source.kind === 'claude-deferred' && i.source.ref === `session ${r.session}`);
    check('the README work is filed as deferred, and the reply says so', filed.length >= 1 && /PS-\d+/.test(r.text), { filed: filed.map(i => i.title), reply: r.text });
  },

  async S4() {
    const b = HOME_B ? login.b : `${login.a}'s other session`;
    console.log(`  An agent claims before working, releases at the end, and won't take an item someone has (FR-26, FR-27; B is ${b})`);
    const x = punch(['add', `S4 geo filter ${run}`, '-s', 'next']).item.id;
    const r = claude(`Start working on ${x}. For now just claim it on the board; don't change any files.`, { as: 'b' });
    const history = show(x).history;
    const claimed = history.find(e => e.op === 'claim' && e.actor.via === 'claude' && e.actor.session === r.session);
    check(`${x} was claimed in that Claude session`, !!claimed, history.map(e => `${e.op} ${e.meta?.text ?? ''}`));
    check(`…and released when the session ended`, history[0]?.meta?.text === 'Released when the Claude session ended' && !show(x).item.claim, history[0]);

    // B is now working on X in a Claude window that's still open.
    punch(['start', x], { as: 'b', session: liveB });
    const a = claude(`Please fix ${x} now; start on it.`);
    const it = show(x).item;
    const named = HOME_B ? new RegExp(login.b, 'i') : /other (Claude )?session/i;
    check(`${x} stays with B, and A's Claude says who has it`, it.claim?.ref === liveB && named.test(a.text), { claim: it.claim, reply: a.text });
    punch(['release', x], { as: 'b', session: liveB });
  },

  async S10() {
    console.log('  A new session already knows the board: who holds what, and what is next (S10)');
    const held = punch(['add', `S10 held thing ${run}`, '-s', 'next']).item.id;
    punch(['start', held], { as: 'b', session: liveB });
    const top = punch(['add', `S10 top of up next ${run}`, '-s', 'next']).item.id;
    punch(['move', top, 'next', '--top']);
    const r = claude(`Without running any commands: who holds ${held} on the board, and which item is at the top of Up Next? Answer with the GitHub login and the item ID.`, { tools: '' });
    const holder = HOME_B ? login.b : login.a;
    check('answered from the board it was given at the start', r.commands.length === 0 && r.text.toLowerCase().includes(holder.toLowerCase()) && r.text.includes(top), { reply: r.text });
    punch(['release', held], { as: 'b', session: liveB });
  },
};

// ---- Run ----

const wanted = process.argv.slice(2).map(s => s.toUpperCase());
const picked = Object.keys(scenarios).filter(k => !wanted.length || wanted.includes(k));
if (!picked.length) {
  console.error(`No scenarios match ${wanted.join(' ')}. There are ${Object.keys(scenarios).join(', ')}.`);
  process.exit(2);
}

dir = mkdtempSync(join(tmpdir(), 'punchlist-plugin-'));
let failed = 0;
try {
  sh('gh', ['repo', 'clone', SANDBOX, dir, '--', '-q'], { cwd: ROOT });
  login.a = punch(['whoami']).user;
  login.b = HOME_B ? punch(['whoami'], { as: 'b' }).user : login.a;
  console.log(dim(`Run ${run} on ${SANDBOX} with ${MODEL}: A is ${login.a}, B is ${HOME_B ? login.b : `${login.a} (no PUNCH_HOME_B)`}`));
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
