import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// The plugin's launcher, plugins/punchlist/bin/punch (PL-020): it finds a Node.js 20+ by itself,
// installs the pinned CLI with that node's npm, and works behind a symlink. Fake `node` and `npm`
// scripts stand in for real ones, so nothing touches the network.

const LAUNCHER = resolve(__dirname, '../../plugins/punchlist/bin/punch');
const WANT = readFileSync(resolve(__dirname, '../../plugins/punchlist/cli-version'), 'utf8').trim();

let home: string;
let log: string;

/** A fake node that reports `major`, and logs which node ran which script when it runs one. */
function fakeNode(dir: string, major: number): string {
  mkdirSync(dir, { recursive: true });
  const node = join(dir, 'node');
  writeFileSync(node, `#!/bin/sh
if [ "$1" = "-e" ]; then printf ${major}; exit 0; fi
echo "ran $0 $*" >> "${log}"
`);
  chmodSync(node, 0o755);
  // Its npm lays down a stub CLI package, and records which node was first on its PATH.
  const npm = join(dir, 'npm');
  writeFileSync(npm, `#!/bin/sh
if [ -n "$FAKE_NPM_FAIL" ]; then printf '%s\\n' "$FAKE_NPM_FAIL" >&2; exit 1; fi
prefix=; spec=
while [ $# -gt 0 ]; do case $1 in --prefix) prefix=$2; shift ;; @nnewberg/*) spec=$1 ;; esac; shift; done
v=\${spec##*@}
mkdir -p "$prefix/node_modules/@nnewberg/punchlist/dist"
printf '{\\n  "version": "%s"\\n}\\n' "$v" > "$prefix/node_modules/@nnewberg/punchlist/package.json"
echo "npm $0 installed $v with node $(command -v node)" >> "${log}"
`);
  chmodSync(npm, 0o755);
  return node;
}

function run(args: string[], env: Record<string, string> = {}, launcher = LAUNCHER) {
  const r = spawnSync('sh', [launcher, ...args], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin', PUNCH_SYSTEM_NODES: '', CLAUDE_PLUGIN_DATA: join(home, 'data'), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'launcher-'));
  log = join(home, 'log');
});

describe('the plugin launcher', () => {
  it("uses the newest nvm node that's 20 or later when PATH has none, and installs with its own npm", () => {
    fakeNode(join(home, '.nvm/versions/node/v18.20.0/bin'), 18);
    fakeNode(join(home, '.nvm/versions/node/v20.16.0/bin'), 20);
    const n22 = fakeNode(join(home, '.nvm/versions/node/v22.22.0/bin'), 22);
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.log).toContain(`npm ${join(home, '.nvm/versions/node/v22.22.0/bin/npm')} installed ${WANT} with node ${n22}`);
    expect(r.log).toContain(`ran ${n22} ${join(home, 'data/cli/node_modules/@nnewberg/punchlist/dist/punch.mjs')} --version`);
    expect(readFileSync(join(home, 'data/node-path'), 'utf8').trim()).toBe(n22);
  });

  it('prefers a new enough node on PATH', () => {
    fakeNode(join(home, '.nvm/versions/node/v26.0.0/bin'), 26);
    const mine = fakeNode(join(home, 'mybin'), 20);
    const r = run(['whoami'], { PATH: `${join(home, 'mybin')}:/usr/bin:/bin` });
    expect(r.log).toContain(`ran ${mine} `);
  });

  it('skips a too-old node on PATH for a newer one elsewhere', () => {
    fakeNode(join(home, 'old'), 18);
    const brew = fakeNode(join(home, 'brew'), 24);
    const r = run(['whoami'], { PATH: `${join(home, 'old')}:/usr/bin:/bin`, PUNCH_SYSTEM_NODES: join(home, 'brew/node') });
    expect(r.log).toContain(`ran ${brew} `);
  });

  it("says what it found and how to fix it when there's no Node 20+", () => {
    fakeNode(join(home, 'old'), 18);
    const r = run(['list'], { PATH: `${join(home, 'old')}:/usr/bin:/bin` });
    expect(r.code).toBe(1);
    expect(r.err).toContain('punch: needs Node.js 20 or later.');
    expect(r.err).toContain(`${join(home, 'old/node')} (Node 18)`);
    expect(r.err).toMatch(/brew install node.*nvm install 22/);
  });

  it('tells Claude at session start instead of failing the session', () => {
    const r = run(['hook', 'session-start']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Punchlist: the plugin needs Node.js 20 or later, so the board isn't loaded this session\. Tell the user once\. It couldn't find Node\.js/);
  });

  it.each([
    ['the version is not published yet', 'npm error code ETARGET\nnpm error notarget No matching version found for @nnewberg/punchlist@9.9.9.', /that version isn't on npm yet[\s\S]*npm publish/],
    ['npm cannot reach the registry', 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed', /npm couldn't reach the registry[\s\S]*internet connection/],
    ['npm fails some other way', 'npm error code EACCES\nnpm error permission denied', /npm said: npm error code EACCES npm error permission denied/],
  ])('says what went wrong when %s', (_why, npmSays, said) => {
    fakeNode(join(home, '.nvm/versions/node/v22.0.0/bin'), 22);
    const r = run(['list'], { FAKE_NPM_FAIL: npmSays });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(said);
    const hook = run(['hook', 'session-start'], { FAKE_NPM_FAIL: npmSays });
    expect(hook.code).toBe(0);
    expect(hook.out).toMatch(/^Punchlist: the plugin couldn't install punch .*, so the board isn't loaded this session\. Tell the user once\./);
    expect(hook.out).toMatch(said);
  });

  it('remembers the node it chose, and installs only once', () => {
    fakeNode(join(home, '.nvm/versions/node/v22.0.0/bin'), 22);
    run(['list']);
    const r = run(['list']);
    expect(r.log.match(/^npm /gm)).toHaveLength(1);
    expect(r.log.match(/^ran /gm)).toHaveLength(2);
  });

  it('works behind a symlink, with its own folder outside Claude Code', () => {
    const n = fakeNode(join(home, '.nvm/versions/node/v22.0.0/bin'), 22);
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    const link = join(home, '.local/bin/punch');
    symlinkSync(LAUNCHER, link);
    const r = run(['list'], { CLAUDE_PLUGIN_DATA: '' }, link);
    expect(r.code).toBe(0);
    expect(r.log).toContain(`ran ${n} ${join(home, '.config/punchlist/cli/node_modules/@nnewberg/punchlist/dist/punch.mjs')} list`);
  });

  it('follows a relative symlink too', () => {
    fakeNode(join(home, '.nvm/versions/node/v22.0.0/bin'), 22);
    mkdirSync(join(home, 'a/b'), { recursive: true });
    symlinkSync(LAUNCHER, join(home, 'a/real'));
    symlinkSync('../real', join(home, 'a/b/punch'));
    expect(run(['list'], {}, join(home, 'a/b/punch')).code).toBe(0);
  });

  it('runs a development build with PUNCH_CLI', () => {
    const n = fakeNode(join(home, 'dev'), 22);
    const r = run(['list'], { PATH: `${join(home, 'dev')}:/usr/bin:/bin`, PUNCH_CLI: '/src/punch.mjs' });
    expect(r.log).toContain(`ran ${n} /src/punch.mjs list`);
  });

  it('passes the syntax check', () => {
    expect(spawnSync('sh', ['-n', LAUNCHER]).status).toBe(0);
  });
});
