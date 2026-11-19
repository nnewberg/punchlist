import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Me, Snapshot } from '../shared/types';
import { ApiError, Client, NetworkError, readBoard } from './api';
import { getToken } from './config';
import { formatCompact } from './format';
import { applyInit, planInit, pluginSettingsObject } from './init';
import { boardFromCwd, repoRoot, type BoardRef } from './repo';
import { MARKETPLACE_REPO } from '../shared/setupPrompt';

// `punch setup` (PL-020): everything a repo and a machine need for Punchlist, checked in order. Each
// run fixes what it safely can and names the one next thing to do, so Claude (or a person) runs it
// again until it says "Setup complete". `--check` only reports, which makes it the health check.
// It never commits, and never touches anything outside the repo except with --link.

export type StepState = 'ok' | 'fixed' | 'action' | 'blocked' | 'skipped';

export interface Step {
  id: string;
  state: StepState;
  /** What's true now, in a line. */
  summary: string;
  /** For action and blocked: exactly what to do. */
  next?: string;
}

export interface SetupReport {
  done: boolean;
  /** The first step that needs doing, or null when setup is complete. */
  next: string | null;
  steps: Step[];
  /** Worth doing, but setup is complete without them. Claude asks the user first. */
  offers: string[];
  /** Set when this Claude session started before the plugin was on, so it hasn't loaded yet. */
  restart: string | null;
  /** The compact board, as proof that it all works. */
  board: string | null;
}

export interface SetupEnv {
  url: string;
  cwd: string;
  version: string;
  /** Report only: change nothing. */
  check?: boolean;
  /** Link the plugin's launcher into ~/.local/bin. */
  link?: boolean;
  /** Wait for the board to appear (after installing the GitHub App). */
  waitBoard?: boolean;
  waitMs?: number;
  pollMs?: number;
  /** Runs `claude` with these args in `cwd`; null when Claude Code's CLI isn't installed. */
  claude?: (args: string[], cwd: string) => string | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export const PLUGIN_ID = 'punchlist@punchlist';
/** Installs the plugin for this repo, adding the marketplace first when Claude Code doesn't have one called punchlist. */
export const INSTALL_ARGS = ['plugin', 'install', 'punchlist', '--marketplace', MARKETPLACE_REPO, '--scope', 'project'];
/** The same from the punchlist marketplace already there, whatever its source (re-adding one from another source is refused). */
export const INSTALL_FROM_MARKET_ARGS = ['plugin', 'install', PLUGIN_ID, '--scope', 'project'];
/** Brings Claude Code's copy of the marketplace up to date: one added without auto-update stays where it was added. */
export const REFRESH_ARGS = ['plugin', 'marketplace', 'update', 'punchlist'];
const updateArgs = (scope: string) => ['plugin', 'update', PLUGIN_ID, '--scope', scope];

/** -1, 0 or 1, comparing dotted version numbers. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function runClaude(args: string[], cwd: string): string | null {
  try {
    return execFileSync('claude', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === 'ENOENT') return null;
    throw new Error(`\`claude ${args.join(' ')}\` failed: ${(err.stderr || err.stdout || err.message).toString().trim().split('\n').slice(-3).join(' ')}`);
  }
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const sameOwner = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---- .claude/settings.json ----

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Adds the Punchlist marketplace and turns the plugin on, keeping everything else. A `punchlist`
 * marketplace that's already there (a local checkout, say) is left as it is.
 */
export function mergeSettings(existing: Json): Json {
  const want = pluginSettingsObject();
  const markets = isObj(existing.extraKnownMarketplaces) ? existing.extraKnownMarketplaces : {};
  const enabled = isObj(existing.enabledPlugins) ? existing.enabledPlugins : {};
  return {
    ...existing,
    extraKnownMarketplaces: { ...markets, ...('punchlist' in markets ? {} : want.extraKnownMarketplaces) },
    enabledPlugins: { ...enabled, [PLUGIN_ID]: true },
  };
}

// ---- Claude Code's plugin list ----

interface PluginEntry {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  projectPath?: string;
  projectEnabled?: boolean;
  installPath?: string;
}

function pluginHere(list: PluginEntry[], root: string): PluginEntry | undefined {
  const here = real(root);
  return list.find(p => p.id === PLUGIN_ID && ((p.scope === 'user' && p.enabled) || (p.projectPath && real(p.projectPath) === here && (p.projectEnabled ?? p.enabled))));
}

function listPlugins(env: SetupEnv, root: string): PluginEntry[] | null {
  const out = (env.claude ?? runClaude)(['plugin', 'list', '--json'], root);
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out) as unknown;
    return Array.isArray(parsed) ? (parsed as PluginEntry[]) : [];
  } catch {
    throw new Error('`claude plugin list --json` printed something that isn’t JSON.');
  }
}

/** The plugin's folder in Claude Code's copy of the marketplace: a path that stays put across plugin updates. */
function marketplacePlugin(env: SetupEnv, root: string): MarketPlugin | null {
  let out: string | null;
  try {
    out = (env.claude ?? runClaude)(['plugin', 'marketplace', 'list', '--json'], root);
  } catch {
    return null;
  }
  if (!out) return null;
  try {
    const m = (JSON.parse(out) as { name?: string; installLocation?: string }[]).find(x => x.name === 'punchlist');
    const dir = m?.installLocation ? join(m.installLocation, 'plugins', 'punchlist') : null;
    if (!dir || !existsSync(join(dir, 'bin', 'punch'))) return null;
    let version: string | null = null;
    try {
      version = (JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string }).version ?? null;
    } catch {
      // no manifest: compare nothing
    }
    return { dir, version };
  } catch {
    return null;
  }
}

interface MarketPlugin {
  dir: string;
  version: string | null;
}

// ---- `punch` in a terminal ----

const isLauncher = (p: string) => existsSync(join(dirname(dirname(real(p))), 'cli-version'));

/** The first `punch` a terminal would run, ignoring the plugin's own bin that Claude's shell puts first. */
function terminalPunch(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || dir.includes(`${join('.claude', 'plugins')}`)) continue;
    const p = join(dir, 'punch');
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- Old tracking files worth importing ----

const TRACKING = /^(todos?|tasks|roadmap|plan|backlog|status|tickets)(\.(md|txt|org))?$/i;

export function trackingFiles(root: string): string[] {
  const found: string[] = [];
  const scan = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) if (TRACKING.test(n)) found.push(rel ? `${rel}/${n}` : n);
  };
  scan(root, '');
  scan(join(root, 'docs'), 'docs');
  return found.sort();
}

// ---- Is it on main? ----

function defaultRef(root: string): string | null {
  const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
  if (head) return head.replace(/^refs\/remotes\//, '');
  // Nothing fetched from origin, so nothing to compare against (and no need to ask it).
  if (!git(['for-each-ref', '--count=1', 'refs/remotes/origin'], root)) return null;
  // A clone without origin/HEAD (or a default branch that isn't main or master): ask origin.
  const remote = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(git(['ls-remote', '--symref', 'origin', 'HEAD'], root) ?? '')?.[1];
  for (const r of [...(remote ? [`origin/${remote}`] : []), 'origin/main', 'origin/master']) if (git(['rev-parse', '--verify', '--quiet', r], root)) return r;
  return null;
}

// ---- Claude Code's user settings: the punchlist marketplace's auto-update ----

/**
 * `claude plugin marketplace add` (and `install --marketplace`) declare the marketplace in the user's
 * settings without auto-update, so its copy, and the plugin installed from it, would stay at the
 * version setup installed. A repo's own entry asks for auto-update, but the user's entry is the one
 * Claude Code added. This turns auto-update on for punchlist's entry only.
 */
function userSettingsPath(penv: NodeJS.ProcessEnv, home: string) {
  return join(penv.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json');
}

// ---- The steps ----

const LOGIN_NEXT =
  'Sign in: run `punch login --start`, show the user the code and the GitHub link it prints, then run `punch login --finish` (it waits up to 10 minutes for them). Then run `punch setup` again.';

export async function runSetup(env: SetupEnv): Promise<SetupReport> {
  const steps: Step[] = [];
  const offers: string[] = [];
  const penv = env.env ?? process.env;
  const home = env.home ?? homedir();
  const fix = !env.check;
  const add = (s: Step) => {
    steps.push(s);
    return s;
  };
  const skip = (id: string, why: string) => add({ id, state: 'skipped', summary: why });

  // 1. This machine
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20
    ? { id: 'node', state: 'ok', summary: `punch ${env.version} on Node ${process.versions.node} (${process.execPath})` }
    : { id: 'node', state: 'blocked', summary: `Node ${process.versions.node} is too old`, next: 'punch needs Node 20 or later. Install it with `brew install node` or `nvm install 22`, then run `punch setup` again.' });

  // 2. The repo
  const root = repoRoot(env.cwd);
  const b: BoardRef | null = root ? boardFromCwd(env.cwd) : null;
  if (!root) add({ id: 'repo', state: 'blocked', summary: 'Not inside a git repo', next: 'Run `punch setup` from inside the repo you want a board for.' });
  else if (!b) add({ id: 'repo', state: 'blocked', summary: `${root} has no GitHub origin`, next: "Punchlist boards come from GitHub repos, and this repo's `origin` isn't on github.com. Run setup in a GitHub repo." });
  else add({ id: 'repo', state: 'ok', summary: `${b.owner}/${b.repo} (${root})` });

  // 3. Signed in
  let me: Me | null = null;
  let client: Client | null = null;
  const token = await getToken(env.url);
  if (!token) add({ id: 'signin', state: 'action', summary: 'Not signed in on this machine', next: LOGIN_NEXT });
  else {
    client = new Client({ url: env.url, token });
    try {
      me = await client.request<Me>('GET', '/v1/me');
      add({ id: 'signin', state: 'ok', summary: `Signed in as ${me.user}` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) add({ id: 'signin', state: 'action', summary: 'The sign-in on this machine expired or was revoked', next: LOGIN_NEXT });
      else if (e instanceof NetworkError) add({ id: 'signin', state: 'blocked', summary: `Can't reach ${env.url}`, next: `Punchlist (${env.url}) can't be reached from here: ${e.message}. Check the connection, then run \`punch setup\` again.` });
      else throw e;
    }
  }

  // 4. The board
  let snapshot: Snapshot | null = null;
  if (!b || !me || !client) skip('board', 'Waiting on the steps above');
  else {
    const find = (m: Me) => m.boards.find(x => sameOwner(x.owner, b.owner) && sameOwner(x.repo, b.repo));
    let entry = find(me);
    if (!entry && env.waitBoard) {
      const until = Date.now() + (env.waitMs ?? 10 * 60_000);
      while (!entry && Date.now() < until) {
        await new Promise(r => setTimeout(r, env.pollMs ?? 3_000));
        try {
          me = await client.request<Me>('GET', '/v1/me'); // also has the server re-check installs
          entry = find(me);
        } catch (e) {
          // A dropped connection while they're on GitHub: keep waiting. A revoked sign-in won't fix itself.
          if (e instanceof ApiError && e.status === 401) break;
          if (!(e instanceof NetworkError) && !(e instanceof ApiError && e.status >= 500)) throw e;
        }
      }
    }
    const allowed = (me as Me & { allowedOwners?: string[] }).allowedOwners; // newer servers say who they serve
    if (entry) {
      snapshot = (await readBoard(client, b)).snapshot;
      add({ id: 'board', state: 'ok', summary: `Board ${entry.prefix} at ${env.url}/${b.owner}/${b.repo}${entry.role === 'view' ? ' (you can only view it)' : ''}` });
    } else if (allowed && !allowed.some(a => sameOwner(a, b.owner))) {
      add({ id: 'board', state: 'blocked', summary: `Punchlist doesn't serve repos owned by ${b.owner}`, next: `This Punchlist only makes boards for repos owned by ${allowed.join(' or ')}, so ${b.owner}/${b.repo} can't have one yet. Whoever runs this Punchlist can add ${b.owner} to ALLOWED_OWNERS.` });
    } else if (!me.installUrl) {
      add({ id: 'board', state: 'blocked', summary: `No board for ${b.owner}/${b.repo}`, next: "This Punchlist's GitHub App isn't set up yet, so it can't make boards. Whoever runs it needs to finish its setup." });
    } else if (env.waitBoard) {
      add({ id: 'board', state: 'blocked', summary: `The board for ${b.owner}/${b.repo} didn't appear`, next: `Still no board for ${b.owner}/${b.repo} that ${me.user} can see. Check that the Punchlist Board App is installed on that repo (${me.installUrl}) and that ${me.user} can read the repo on GitHub, then run \`punch setup --wait-board\` again.` });
    } else {
      add({
        id: 'board',
        state: 'action',
        summary: `No board for ${b.owner}/${b.repo} that ${me.user} can see`,
        next: `Either the Punchlist GitHub App isn't installed on ${b.owner}/${b.repo}, or ${me.user} can't see it. If the user can manage that repo on GitHub, have them install the App on it: ${me.installUrl} (choose ${b.owner}, then ${b.repo}). Then run \`punch setup --wait-board\`, which waits for the board to appear.`,
      });
    }
  }

  // 5. .claude/settings.json: what makes Claude Code offer the plugin to everyone who opens the repo
  const settingsPath = root ? join(root, '.claude', 'settings.json') : null;
  let settingsChanged = false;
  if (!root || !settingsPath) skip('settings', 'Waiting on the repo');
  else {
    let current: Json = {};
    let readable = true;
    if (existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
        if (isObj(parsed)) current = parsed;
        else readable = false;
      } catch {
        readable = false;
      }
    }
    const merged = mergeSettings(current);
    if (!readable) add({ id: 'settings', state: 'blocked', summary: '.claude/settings.json isn’t a JSON object', next: `${settingsPath} can't be read as JSON, so setup won't touch it. Fix it by hand, then run \`punch setup\` again.` });
    else if (JSON.stringify(merged) === JSON.stringify(current)) add({ id: 'settings', state: 'ok', summary: '.claude/settings.json offers the plugin to everyone who opens the repo' });
    else if (!fix) add({ id: 'settings', state: 'action', summary: ".claude/settings.json doesn't turn the plugin on", next: 'Run `punch setup` to add the Punchlist plugin to .claude/settings.json.' });
    else {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
      settingsChanged = true;
      add({ id: 'settings', state: 'fixed', summary: 'Added the Punchlist plugin to .claude/settings.json' });
    }
  }

  // 6. The plugin, installed and on for this folder
  let plugins: PluginEntry[] | null = null;
  let pluginChanged = false;
  let pluginWasOn = false;
  /** The plugin as it ends up for this folder. */
  let installed: PluginEntry | undefined;
  // Claude Code's copy of the marketplace, read once per run (after the refresh): each `claude` call is slow.
  let market: MarketPlugin | null | undefined;
  const marketNow = () => (market === undefined ? (market = root ? marketplacePlugin(env, root) : null) : market);
  if (!root) skip('plugin', 'Waiting on the repo');
  else {
    if (fix) {
      try {
        (env.claude ?? runClaude)(REFRESH_ARGS, root);
      } catch {
        // not added yet (the install below adds it), or offline: check what's there
      }
    }
    plugins = listPlugins(env, root);
    if (plugins === null) {
      add({ id: 'plugin', state: 'skipped', summary: "Claude Code's `claude` command isn't on this PATH, so the plugin wasn't checked" });
      offers.push('Open this repo in Claude Code and approve the Punchlist plugin when it asks.');
    } else {
      let here = pluginHere(plugins, root);
      pluginWasOn = !!here;
      installed = here;
      let failed: string | null = null;
      const install = marketNow() ? INSTALL_FROM_MARKET_ARGS : INSTALL_ARGS;
      if (!here && fix) {
        try {
          (env.claude ?? runClaude)(install, root);
          plugins = listPlugins(env, root) ?? [];
          here = pluginHere(plugins, root);
          installed = here;
          market = undefined; // installing can add the marketplace
        } catch (e) {
          failed = (e as Error).message;
        }
        if (failed) add({ id: 'plugin', state: 'blocked', summary: "The plugin couldn't be installed", next: `${failed}. Show the user this, and run \`claude ${install.join(' ')}\` yourself to see the whole message.` });
        else if (here) {
          pluginChanged = true;
          add({ id: 'plugin', state: 'fixed', summary: `Installed the Punchlist plugin${here.version ? ` ${here.version}` : ''} for this repo` });
        }
        else add({ id: 'plugin', state: 'blocked', summary: 'The plugin installed but still isn’t on for this folder', next: `\`claude ${install.join(' ')}\` ran, but \`claude plugin list --json\` doesn't show ${PLUGIN_ID} enabled for ${root}. Show the user that output.` });
      } else if (!here) add({ id: 'plugin', state: 'action', summary: "The Punchlist plugin isn't on for this folder", next: `Run \`punch setup\` (it runs \`claude ${install.join(' ')}\`).` });
      else {
        // On, but older than the marketplace's: an old plugin can miss what setup needs (it had no `setup` before 0.4.0).
        const latest = marketNow()?.version;
        if (latest && here.version && compareVersions(here.version, latest) < 0) {
          const args = updateArgs(here.scope ?? 'project');
          if (!fix) add({ id: 'plugin', state: 'action', summary: `The Punchlist plugin here is ${here.version}; ${latest} is out`, next: `Run \`punch setup\` (it runs \`claude ${args.join(' ')}\`).` });
          else {
            try {
              (env.claude ?? runClaude)(args, root);
              const now = pluginHere(listPlugins(env, root) ?? [], root);
              installed = now ?? here;
              if (now?.version && compareVersions(now.version, latest) >= 0) {
                pluginChanged = true;
                add({ id: 'plugin', state: 'fixed', summary: `Updated the Punchlist plugin from ${here.version} to ${now.version}` });
              }
              else add({ id: 'plugin', state: 'blocked', summary: `The Punchlist plugin is still ${now?.version ?? here.version}`, next: `\`claude ${args.join(' ')}\` ran, but the plugin for ${root} is still ${now?.version ?? here.version}, not ${latest}. Show the user \`claude plugin list --json\`.` });
            } catch (e) {
              add({ id: 'plugin', state: 'blocked', summary: "The plugin couldn't be updated", next: `${(e as Error).message}. Show the user this.` });
            }
          }
        } else add({ id: 'plugin', state: 'ok', summary: `The Punchlist plugin${here.version ? ` ${here.version}` : ''} is on for this repo` });
      }
    }
  }
  // PUNCH_PLUGIN_DATA is what the plugin's session start gives Claude's shell, so without it the plugin
  // didn't load here: either it was off when the session started, or its session start failed.
  const restart = !penv.CLAUDECODE
    ? null
    : pluginChanged
      ? 'The plugin was just installed or updated, and Claude Code loads it in the next session. Tell the user to start a new Claude Code session in this repo: the board then appears at the start of every session.'
      : !penv.PUNCH_PLUGIN_DATA && pluginWasOn
        ? "The plugin is on for this repo but didn't load in this Claude Code session, so its session start may have failed. Tell the user to start a new session; if the board still doesn't appear, its first message says why (for example, no Node.js 20 found)."
        : !penv.PUNCH_PLUGIN_DATA
          ? 'This Claude Code session started before the plugin was on, so it hasn’t loaded here. Tell the user to start a new Claude Code session in this repo: the board then appears at the start of every session.'
          : null;

  // 6b. Auto-update for the punchlist marketplace in Claude Code's user settings
  {
    const path = userSettingsPath(penv, home);
    let user: Json | null = null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      user = isObj(parsed) ? parsed : null;
    } catch {
      user = null; // none, or not JSON: leave it alone
    }
    const markets = user && isObj(user.extraKnownMarketplaces) ? user.extraKnownMarketplaces : null;
    const entry = markets && isObj(markets.punchlist) ? markets.punchlist : null;
    if (user && markets && entry && entry.autoUpdate !== true) {
      if (!fix) add({ id: 'auto-update', state: 'action', summary: "The punchlist marketplace doesn't auto-update", next: `Run \`punch setup\` to turn on auto-update for the punchlist marketplace in ${path}.` });
      else {
        writeFileSync(path, `${JSON.stringify({ ...user, extraKnownMarketplaces: { ...markets, punchlist: { ...entry, autoUpdate: true } } }, null, 2)}\n`);
        add({ id: 'auto-update', state: 'fixed', summary: 'Turned on auto-update for the punchlist marketplace, so the plugin keeps itself current' });
      }
    }
  }

  // 7. The CLAUDE.md pointer
  let pointerChanged = false;
  if (!root || !b) skip('claude-md', 'Waiting on the repo');
  else {
    const plan = planInit(root, env.url, b);
    if (plan.already) add({ id: 'claude-md', state: 'ok', summary: 'CLAUDE.md points at the board' });
    else if (!fix) add({ id: 'claude-md', state: 'action', summary: "CLAUDE.md doesn't point at the board", next: 'Run `punch setup` to add the board pointer to CLAUDE.md.' });
    else {
      applyInit(plan);
      pointerChanged = true;
      add({ id: 'claude-md', state: 'fixed', summary: `Added the board pointer to ${plan.exists ? '' : 'a new '}CLAUDE.md` });
    }
  }

  // 8. `punch` in a terminal
  const localBin = join(home, '.local', 'bin');
  const linkPath = join(localBin, 'punch');
  const onPath = (penv.PATH ?? '').split(delimiter).some(d => d && real(d) === real(localBin));
  const pathHint = onPath ? '' : ` ${localBin} isn't on your PATH yet: add \`export PATH="$HOME/.local/bin:$PATH"\` to your shell profile.`;
  const linked = (() => {
    try {
      return lstatSync(linkPath).isSymbolicLink() && isLauncher(linkPath);
    } catch {
      return false;
    }
  })();
  const shadow = terminalPunch(penv);
  if (env.link && !linked && root) {
    const m = marketNow();
    const target = m ? join(m.dir, 'bin', 'punch') : null;
    if (!target) add({ id: 'terminal', state: 'blocked', summary: "Couldn't find the plugin's launcher to link", next: 'Install the plugin first (`punch setup` does), then run `punch setup --link` again.' });
    else if (existsSync(linkPath)) add({ id: 'terminal', state: 'blocked', summary: `${linkPath} already exists`, next: `${linkPath} is something else, so setup won't replace it. Remove it, then run \`punch setup --link\` again.` });
    else {
      mkdirSync(localBin, { recursive: true });
      symlinkSync(target, linkPath);
      add({ id: 'terminal', state: 'fixed', summary: `Linked ${linkPath} to the plugin marketplace's punch.${pathHint}` });
    }
  } else if (linked) {
    const first = shadow && real(shadow) !== real(linkPath) ? shadow : null;
    if (first) offers.push(`A different \`punch\` at ${first} comes first on your PATH, ahead of ${linkPath}. If it's an old global install, remove it with \`npm rm -g @nnewberg/punchlist\`.`);
    else if (pathHint) offers.push(pathHint.trim());
    // The link runs the marketplace copy's launcher; the plugin is installed from that copy, and step 6
    // updates the plugin whenever it's behind, so both pin the same CLI. Say so if they've drifted.
    const pin = (dir: string) => {
      try {
        return readFileSync(join(dir, 'cli-version'), 'utf8').trim();
      } catch {
        return null;
      }
    };
    const terminalPin = pin(dirname(dirname(real(linkPath))));
    const pluginPin = installed?.installPath ? pin(installed.installPath) : null;
    if (terminalPin && pluginPin && terminalPin !== pluginPin) offers.push(`\`punch\` in a terminal pins punch ${terminalPin}, but the plugin pins ${pluginPin}. Run \`punch setup\` again (without --check) to update the plugin.`);
    add({ id: 'terminal', state: 'ok', summary: `\`punch\` in a terminal runs the plugin marketplace's punch (${linkPath})` });
  } else {
    const other = shadow && !isLauncher(shadow) ? ` It would replace the separate \`punch\` at ${shadow}, which can drift from the plugin's version (remove that with \`npm rm -g @nnewberg/punchlist\`).` : '';
    offers.push(`Run \`punch setup --link\` so \`punch\` works in a terminal too, running the same version as the plugin.${other}`);
    add({ id: 'terminal', state: 'skipped', summary: "`punch` isn't linked for terminals (optional)" });
  }

  // 9. Old tracking to bring in
  if (root && snapshot && !snapshot.items.length) {
    const files = trackingFiles(root);
    if (files.length) offers.push(`The board is empty, and ${files.join(', ')} look${files.length === 1 ? 's' : ''} like existing tracking. Offer to import ${files.length === 1 ? 'it' : 'them'} with \`punch import\` (the punchlist skill says how).`);
  }

  // 10. Shared on main, so everyone who pulls gets it
  if (root && settingsPath) {
    const rel = ['.claude/settings.json', 'CLAUDE.md'];
    const ignored = git(['check-ignore', '.claude/settings.json'], root);
    const dirty = git(['status', '--porcelain', '--', ...rel], root);
    const ref = defaultRef(root);
    const onMain = ref ? (git(['show', `${ref}:.claude/settings.json`], root) ?? '').includes(PLUGIN_ID) : false;
    if (ignored) offers.push('.gitignore ignores .claude/settings.json, so teammates won’t get the plugin from the repo. Offer to un-ignore it (for example `!.claude/settings.json` after the ignore line).');
    else if (dirty || settingsChanged || pointerChanged) offers.push(`Offer to commit ${rel.join(' and ')} on a new branch and open a PR. Once it's on ${ref ?? 'the default branch'}, everyone who pulls gets the plugin: they approve it once and sign in once.`);
    else if (!onMain) offers.push(`.claude/settings.json is committed but not on ${ref ?? 'the default branch'} yet. Teammates get the plugin once it's merged.`);
  }

  // 11. Proof
  const blocking = steps.find(s => s.state === 'action' || s.state === 'blocked');
  const board = snapshot ? formatCompact(snapshot, { me: me?.user }) : null;
  return { done: !blocking, next: blocking?.next ?? null, steps, offers, restart, board };
}

const MARK: Record<StepState, string> = { ok: '✓', fixed: '✓', action: '→', blocked: '✗', skipped: '·' };

export function formatSetup(r: SetupReport): string {
  const out = r.steps.map(s => `${MARK[s.state]} ${s.summary}`);
  if (!r.done) {
    out.push('', `Next: ${r.next}`);
    return out.join('\n');
  }
  if (r.board) out.push('', r.board);
  out.push('', 'Setup complete.');
  if (r.restart) out.push(r.restart);
  if (r.offers.length) out.push('', 'Also worth doing (ask the user first):', ...r.offers.map(x => `  - ${x}`));
  return out.join('\n');
}
