import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConfig, setToken } from '../config';
import { compareVersions, formatSetup, INSTALL_ARGS, INSTALL_FROM_MARKET_ARGS, mergeSettings, REFRESH_ARGS, runSetup, trackingFiles, type SetupEnv } from '../setup';
import { checkFlags } from '../args';

// `punch setup` (PL-020): each step's check and fix, that a second run changes nothing, and that it
// always names exactly one next thing to do.

const URL_ = 'https://punch.test';
let repo: string;
let home: string;
let me: Record<string, unknown>;
let meStatus = 200;
let meCalls = 0;
let boardItems: unknown[] = [];

/** A fake `claude`: the plugin list it reports, and the commands it was asked to run. */
let plugins: Record<string, unknown>[];
let claudeCalls: string[][];
let marketplace: string | null;
let marketVersion = '0.4.0';

/** A marketplace copy on disk whose plugin is `version`. */
function market(version: string) {
  marketplace = mkdtempSync(join(tmpdir(), 'market-'));
  marketVersion = version;
  const dir = join(marketplace, 'plugins', 'punchlist');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, '.claude-plugin'));
  writeFileSync(join(dir, 'bin', 'punch'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(dir, 'cli-version'), `${version}\n`);
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'punchlist', version }));
  return join(dir, 'bin');
}
const claude: SetupEnv['claude'] = args => {
  claudeCalls.push(args);
  if (args.join(' ') === 'plugin list --json') return JSON.stringify(plugins);
  if (args.join(' ') === 'plugin marketplace list --json') return JSON.stringify(marketplace ? [{ name: 'punchlist', installLocation: marketplace }] : []);
  if (args.join(' ') === REFRESH_ARGS.join(' ')) return 'ok';
  if (args.join(' ') === 'plugin update punchlist@punchlist --scope project') {
    for (const p of plugins) p.version = marketVersion;
    return 'ok';
  }
  if (args.join(' ') === INSTALL_ARGS.join(' ') || args.join(' ') === INSTALL_FROM_MARKET_ARGS.join(' ')) {
    plugins.push({ id: 'punchlist@punchlist', version: '0.4.0', scope: 'project', enabled: true, projectPath: repo, projectEnabled: true });
    return 'ok';
  }
  throw new Error(`unexpected claude ${args.join(' ')}`);
};

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
const setup = (extra: Partial<SetupEnv> = {}) => runSetup({ url: URL_, cwd: repo, version: '0.4.0', claude, home, env: { PATH: '/usr/bin:/bin' }, ...extra });
const signIn = async () => {
  await setToken(URL_, 'pl_x');
  saveConfig({ url: URL_, user: 'nick' });
};
const step = (r: Awaited<ReturnType<typeof runSetup>>, id: string) => r.steps.find(s => s.id === id)!;
const board = { owner: 'nnewberg', repo: 'punchlist-sandbox', prefix: 'PS', role: 'edit' };

beforeEach(() => {
  process.env.PUNCH_HOME = mkdtempSync(join(tmpdir(), 'punch-'));
  process.env.PUNCH_NO_KEYCHAIN = '1';
  home = mkdtempSync(join(tmpdir(), 'home-'));
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'repo-')));
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:nnewberg/punchlist-sandbox.git');
  me = { user: 'nick', boards: [board], people: {}, installUrl: 'https://github.com/apps/punchlist-board/installations/new', dev: false, allowedOwners: ['nnewberg', 'futureleisurefoundation'] };
  meStatus = 200;
  meCalls = 0;
  boardItems = [{ id: 'PS-001', title: 'Geo filter', body: '', status: 'up_next', rank: 'a0', blocked: null, tags: [], depends_on: [], aliases: [], source: { kind: 'cli', actor: 'nick' }, created_at: '2026-10-01T00:00:00Z', created_by: 'nick', claim: null, citations: [], notes: [], body_version: 0, updated_at: '2026-10-01T00:00:00Z' }];
  plugins = [];
  claudeCalls = [];
  marketplace = null;
  marketVersion = '0.4.0';
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/v1/me') {
      meCalls++;
      return new Response(JSON.stringify(meStatus === 200 ? me : { error: 'unauthorized' }), { status: meStatus });
    }
    if (path === '/v1/boards/nnewberg/punchlist-sandbox') return new Response(JSON.stringify({ board: { owner: 'nnewberg', repo: 'punchlist-sandbox', prefix: 'PS' }, items: boardItems, seq: 1, viewers: [] }));
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('punch setup', () => {
  it('asks for sign-in first, and says exactly how', async () => {
    const r = await setup();
    expect(r.done).toBe(false);
    expect(step(r, 'signin').state).toBe('action');
    expect(r.next).toMatch(/punch login --start.*punch login --finish/);
    expect(step(r, 'board').state).toBe('skipped');
  });

  it('treats an expired sign-in the same way', async () => {
    await signIn();
    meStatus = 401;
    const r = await setup();
    expect(step(r, 'signin')).toMatchObject({ state: 'action', summary: expect.stringMatching(/expired/) });
  });

  it('writes the settings, installs the plugin, adds the pointer, shows the board and offers a PR', async () => {
    await signIn();
    const r = await setup();
    expect(r.done).toBe(true);
    expect(step(r, 'settings').state).toBe('fixed');
    expect(step(r, 'plugin').state).toBe('fixed');
    expect(step(r, 'claude-md').state).toBe('fixed');
    expect(claudeCalls).toContainEqual(INSTALL_ARGS);
    const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
    expect(settings).toEqual({
      extraKnownMarketplaces: { punchlist: { source: { source: 'github', repo: 'nnewberg/punchlist' }, autoUpdate: true } },
      enabledPlugins: { 'punchlist@punchlist': true },
    });
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain('<!-- punchlist -->');
    expect(r.board).toContain('PS-001');
    expect(r.offers.join('\n')).toMatch(/commit \.claude\/settings\.json and CLAUDE\.md on a new branch and open a PR/);
    const text = formatSetup(r);
    expect(text).toContain('Setup complete.');
    expect(text).toContain('PS-001');
  });

  it('changes nothing on a second run', async () => {
    await signIn();
    await setup();
    const before = readFileSync(join(repo, '.claude', 'settings.json'), 'utf8') + readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    claudeCalls = [];
    const r = await setup();
    expect(r.steps.filter(s => s.state === 'fixed')).toEqual([]);
    expect(claudeCalls).not.toContainEqual(INSTALL_ARGS);
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8') + readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(before);
  });

  it('only reports with --check', async () => {
    await signIn();
    const r = await setup({ check: true });
    expect(r.done).toBe(false);
    expect(step(r, 'settings').state).toBe('action');
    expect(step(r, 'plugin').state).toBe('action');
    expect(existsSync(join(repo, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    expect(claudeCalls).not.toContainEqual(INSTALL_ARGS);
  });

  it('keeps settings that are already there, and a punchlist marketplace someone pointed elsewhere', async () => {
    const mine = { permissions: { allow: ['Bash(npm test)'] }, extraKnownMarketplaces: { punchlist: { source: { source: 'directory', path: '/dev/punchlist' } } }, enabledPlugins: { 'other@x': true, 'punchlist@punchlist': false } };
    expect(mergeSettings(mine)).toEqual({ ...mine, enabledPlugins: { 'other@x': true, 'punchlist@punchlist': true } });
  });

  it("won't touch a settings file that isn't JSON", async () => {
    await signIn();
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{ nope');
    const r = await setup();
    expect(step(r, 'settings').state).toBe('blocked');
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{ nope');
  });

  it('sends the user to install the App when there is no board, without saying whether one exists', async () => {
    await signIn();
    me.boards = [];
    const r = await setup();
    expect(step(r, 'board').state).toBe('action');
    expect(r.next).toMatch(/isn't installed on nnewberg\/punchlist-sandbox, or nick can't see it/);
    expect(r.next).toContain('https://github.com/apps/punchlist-board/installations/new');
    expect(r.next).toContain('punch setup --wait-board');
  });

  it('waits for the board with --wait-board', async () => {
    await signIn();
    me.boards = [];
    setTimeout(() => (me.boards = [board]), 20);
    const r = await setup({ waitBoard: true, pollMs: 10, waitMs: 2_000 });
    expect(step(r, 'board').state).toBe('ok');
    expect(meCalls).toBeGreaterThan(1);
  });

  it('gives up waiting with a clear message', async () => {
    await signIn();
    me.boards = [];
    const r = await setup({ waitBoard: true, pollMs: 5, waitMs: 30 });
    expect(step(r, 'board')).toMatchObject({ state: 'blocked', next: expect.stringMatching(/Still no board/) });
  });

  it('says plainly when Punchlist does not serve the owner', async () => {
    await signIn();
    me.boards = [];
    me.allowedOwners = ['futureleisurefoundation'];
    const r = await setup();
    expect(step(r, 'board')).toMatchObject({ state: 'blocked', next: expect.stringMatching(/only makes boards for repos owned by futureleisurefoundation/) });
  });

  it('stops outside a GitHub repo', async () => {
    await signIn();
    git('remote', 'set-url', 'origin', 'https://gitlab.com/x/y.git');
    const r = await setup();
    expect(step(r, 'repo').state).toBe('blocked');
    expect(r.next).toMatch(/isn't on github.com/);
  });

  it('carries on without Claude Code, and says how to get the plugin', async () => {
    await signIn();
    const r = await setup({ claude: () => null });
    expect(step(r, 'plugin').state).toBe('skipped');
    expect(r.offers.join('\n')).toMatch(/approve the Punchlist plugin/);
  });

  it('reports a failed plugin install instead of throwing', async () => {
    await signIn();
    const r = await setup({ claude: args => { if (args[1] === 'list') return '[]'; throw new Error('`claude plugin install` failed: no network'); } });
    expect(step(r, 'plugin')).toMatchObject({ state: 'blocked', next: expect.stringMatching(/no network/) });
  });

  it('says to start a new session when this one began before the plugin was on', async () => {
    await signIn();
    const r = await setup({ env: { PATH: '/usr/bin:/bin', CLAUDECODE: '1' } });
    expect(r.restart).toMatch(/start a new Claude Code session/);
    const loaded = await setup({ env: { PATH: '/usr/bin:/bin', CLAUDECODE: '1', PUNCH_PLUGIN_DATA: '/x' } });
    expect(loaded.restart).toBeNull();
  });

  it('links the launcher into ~/.local/bin with --link', async () => {
    await signIn();
    const bin = market('0.4.0');
    const before = await setup();
    expect(before.offers.join('\n')).toMatch(/punch setup --link/);
    const r = await setup({ link: true });
    expect(step(r, 'terminal').state).toBe('fixed');
    expect(readlinkSync(join(home, '.local', 'bin', 'punch'))).toBe(join(bin, 'punch'));
    expect(step(r, 'terminal').summary).toMatch(/isn't on your PATH yet/);
    const again = await setup({ env: { PATH: `${join(home, '.local', 'bin')}:/usr/bin:/bin` } });
    expect(step(again, 'terminal').state).toBe('ok');
  });

  it('offers to import old tracking only when the board is empty', async () => {
    await signIn();
    writeFileSync(join(repo, 'TODO.md'), '- [ ] something\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'ROADMAP.md'), '# later\n');
    expect(trackingFiles(repo)).toEqual(['TODO.md', 'docs/ROADMAP.md']);
    expect((await setup()).offers.join('\n')).not.toMatch(/punch import/);
    boardItems = [];
    expect((await setup()).offers.join('\n')).toMatch(/TODO\.md, docs\/ROADMAP\.md look like existing tracking/);
  });

  it('knows when the settings are already on the default branch', async () => {
    await signIn();
    await setup();
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'setup');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r = await setup();
    expect(r.offers.join('\n')).not.toMatch(/open a PR|not on/);
  });

  it('installs from a punchlist marketplace that is already there, whatever its source', async () => {
    await signIn();
    market('0.4.0');
    const r = await setup();
    expect(step(r, 'plugin').state).toBe('fixed');
    expect(claudeCalls).toContainEqual(INSTALL_FROM_MARKET_ARGS);
    expect(claudeCalls).not.toContainEqual(INSTALL_ARGS);
  });

  it('refreshes the marketplace before checking the plugin, but not with --check', async () => {
    await signIn();
    await setup();
    expect(claudeCalls[0]).toEqual(REFRESH_ARGS);
    claudeCalls = [];
    await setup({ check: true });
    expect(claudeCalls).not.toContainEqual(REFRESH_ARGS);
  });

  it('updates a plugin older than the marketplace, and says to start a new session', async () => {
    await signIn();
    market('0.4.0');
    plugins = [{ id: 'punchlist@punchlist', version: '0.3.3', scope: 'project', enabled: true, projectPath: repo, projectEnabled: true }];
    const checked = await setup({ check: true });
    expect(step(checked, 'plugin')).toMatchObject({ state: 'action', summary: 'The Punchlist plugin here is 0.3.3; 0.4.0 is out' });
    const r = await setup({ env: { PATH: '/usr/bin:/bin', CLAUDECODE: '1', PUNCH_PLUGIN_DATA: '/x' } });
    expect(step(r, 'plugin')).toMatchObject({ state: 'fixed', summary: 'Updated the Punchlist plugin from 0.3.3 to 0.4.0' });
    expect(r.restart).toMatch(/just updated.*new Claude Code session/);
    expect(step(await setup(), 'plugin').state).toBe('ok');
  });

  it('compares versions by number', () => {
    expect(compareVersions('0.3.10', '0.4.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('refuses flags it does not read', () => {
    expect(() => checkFlags('setup', { check: true, link: true, 'wait-board': true, json: true })).not.toThrow();
    expect(() => checkFlags('setup', { yes: true })).toThrow(/doesn't take --yes/);
  });
});
