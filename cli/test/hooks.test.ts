import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../shared/types';
import { saveConfig, setToken } from '../config';
import { RULES, runHook, stampFile } from '../hooks';

// The Claude Code plugin's hooks (FR-24): what Claude sees at the start of a session, and the calls
// that keep its claims alive and release them.

const URL_ = 'https://punch.test';
let calls: { method: string; path: string; body?: unknown; session?: string }[] = [];
let status = 200;
let online = true;
let repo: string;

const it_ = (id: string, title: string, extra: Partial<Item> = {}): Item => ({
  id, title, body: '', status: 'up_next', rank: 'a0', blocked: null, tags: [], depends_on: [], aliases: [], source: { kind: 'cli', actor: 'nick' },
  created_at: '2026-10-01T00:00:00Z', created_by: 'nick', claim: null, citations: [], notes: [], body_version: 0, updated_at: '2026-10-01T00:00:00Z', ...extra,
});
const items = [
  it_('PS-001', 'Geo filter', { status: 'in_progress', claim: { user: 'kevin', kind: 'session', ref: 'aaaaaaaa-1111', since: '2026-10-16T00:00:00Z' } }),
  it_('PS-002', 'Retry uploads', { status: 'in_progress', claim: { user: 'nick', kind: 'session', ref: 'sess-1', since: '2026-10-16T00:00:00Z' } }),
  it_('PS-003', 'Quiz nudge'),
];

beforeEach(async () => {
  process.env.PUNCH_HOME = mkdtempSync(join(tmpdir(), 'punch-'));
  process.env.PUNCH_NO_KEYCHAIN = '1';
  repo = mkdtempSync(join(tmpdir(), 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:nnewberg/punchlist-sandbox.git'], { cwd: repo });
  calls = [];
  status = 200;
  online = true;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!online) throw new TypeError('fetch failed');
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), ...(headers.get('x-punch-session') ? { session: headers.get('x-punch-session')! } : {}) });
    if (status !== 200) return new Response(JSON.stringify({ error: 'not_found' }), { status });
    if (path.endsWith('/session')) return new Response(JSON.stringify({ ok: true, held: items.filter(i => i.claim?.ref === headers.get('x-punch-session')) }));
    return new Response(JSON.stringify({ board: { owner: 'nnewberg', repo: 'punchlist-sandbox', prefix: 'PS' }, items, seq: 3, viewers: [] }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const signIn = async () => {
  await setToken(URL_, 'pl_x');
  saveConfig({ url: URL_, user: 'nick' });
};

describe('session-start', () => {
  it("gives Claude's shell the session and the plugin's punch, then shows the rules and the board", async () => {
    await signIn();
    const envFile = join(repo, 'env.sh');
    writeFileSync(envFile, '');
    const out = await runHook('session-start', { session_id: 'sess-1', cwd: repo, source: 'startup' }, { url: URL_, envFile, pluginRoot: "/plugins/it's here", pluginData: '/data' });
    expect(readFileSync(envFile, 'utf8')).toBe(`export PUNCH_SESSION='sess-1'\nexport PATH='/plugins/it'\\''s here/bin':"$PATH"\nexport PUNCH_PLUGIN_DATA='/data'\n`);
    expect(out.startsWith(RULES)).toBe(true);
    expect(out).toContain('PS-001 Geo filter [kevin · claude session aaaaaaaa]');
    expect(out).toContain('PS-002 Retry uploads [nick (you) · this session]');
    expect(out).toContain('You are signed in as nick. This session holds PS-002.');
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /v1/boards/nnewberg/punchlist-sandbox', 'POST /v1/boards/nnewberg/punchlist-sandbox/session']);
    expect(calls[1]).toMatchObject({ body: { action: 'heartbeat' }, session: 'sess-1' });
  });

  it('says once how to sign in when punch is not signed in', async () => {
    const out = await runHook('session-start', { session_id: 's', cwd: repo }, { url: URL_ });
    expect(out).toMatch(/isn't signed in.*\/punch login/);
    expect(calls).toEqual([]);
  });

  it('says to ignore the board when the repo has none', async () => {
    await signIn();
    status = 404;
    expect(await runHook('session-start', { session_id: 's', cwd: repo }, { url: URL_ })).toMatch(/no board for nnewberg\/punchlist-sandbox/);
  });

  it('says nothing outside a GitHub repo', async () => {
    await signIn();
    expect(await runHook('session-start', { session_id: 's', cwd: tmpdir() }, { url: URL_ })).toBe('');
  });

  it('falls back to the saved board when offline', async () => {
    await signIn();
    await runHook('session-start', { session_id: 's', cwd: repo }, { url: URL_ });
    online = false;
    const out = await runHook('session-start', { session_id: 's', cwd: repo }, { url: URL_ });
    expect(out).toContain('Offline: this is the board as of');
    expect(out).toContain('PS-003 Quiz nudge');
  });
});

describe('heartbeat and session-end', () => {
  it('heartbeats at most every 5 minutes', async () => {
    await signIn();
    await runHook('heartbeat', { session_id: 'sess-1', cwd: repo }, { url: URL_ });
    await runHook('heartbeat', { session_id: 'sess-1', cwd: repo }, { url: URL_ });
    expect(calls).toHaveLength(1);
    const old = new Date(Date.now() - 6 * 60_000);
    utimesSync(stampFile('sess-1'), old, old);
    await runHook('heartbeat', { session_id: 'sess-1', cwd: repo }, { url: URL_ });
    expect(calls).toHaveLength(2);
  });

  it("releases the session's claims when it ends, and never throws", async () => {
    await signIn();
    await runHook('session-end', { session_id: 'sess-1', cwd: repo }, { url: URL_ });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/boards/nnewberg/punchlist-sandbox/session', body: { action: 'end' }, session: 'sess-1' });
    online = false;
    await expect(runHook('session-end', { session_id: 'sess-1', cwd: repo }, { url: URL_ })).resolves.toBe('');
  });
});
