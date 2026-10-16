import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item } from '../shared/types';
import { ApiError, boardPath, Client, NetworkError, readBoard } from './api';
import { configDir, getToken, loadConfig } from './config';
import { formatCompact } from './format';
import { boardFromCwd, type BoardRef } from './repo';

// `punch hook <event>`: what the Claude Code plugin's hooks run (FR-24). Claude Code passes the
// session as JSON on stdin. A hook never fails loudly: a broken board must not break a Claude session.
// - session-start: tells Claude's shell its session (so its `punch` calls record it, FR-4), then
//   prints the plugin's rules (its rules.md, so they change with the plugin, not the CLI) and the
//   compact board into Claude's context (S10).
// - heartbeat (UserPromptSubmit, Stop): keeps this session's claims alive, at most every 5 minutes.
// - session-end: releases this session's claims (FR-28).

export interface HookInput {
  session_id?: string;
  cwd?: string;
  /** SessionStart: startup, resume, clear or compact. */
  source?: string;
}

export interface HookEnv {
  url: string;
  /** Claude Code's file of `export` lines that its Bash tool sources (SessionStart only). */
  envFile?: string;
  pluginRoot?: string;
  pluginData?: string;
}

const HEARTBEAT_EVERY_MS = 5 * 60_000;
const HOOK_TIMEOUT_MS = 4_000;

/** The rules Claude follows every session, from the plugin. */
function rules(env: HookEnv): string | null {
  if (!env.pluginRoot) return null;
  try {
    return readFileSync(join(env.pluginRoot, 'rules.md'), 'utf8').trim();
  } catch {
    return null;
  }
}

const cleanSession = (s: string | undefined) => s?.replace(/[^\w.:-]/g, '').slice(0, 64) || undefined;
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Lets Claude's Bash commands find this plugin's `punch` first and record the session. */
export function writeSessionEnv(env: HookEnv, session: string) {
  if (!env.envFile) return;
  const lines = [`export PUNCH_SESSION=${sh(session)}`];
  if (env.pluginRoot) lines.push(`export PATH=${sh(join(env.pluginRoot, 'bin'))}:"$PATH"`);
  if (env.pluginData) lines.push(`export PUNCH_PLUGIN_DATA=${sh(env.pluginData)}`);
  appendFileSync(env.envFile, `${lines.join('\n')}\n`);
}

export const stampFile = (session: string) => join(configDir(), 'sessions', session);

async function sessionCall(client: Client, b: BoardRef, action: 'heartbeat' | 'end'): Promise<Item[] | null> {
  const out = await client.request<{ held: Item[] }>('POST', `${boardPath(b)}/session`, { action }, b);
  if (action === 'heartbeat') {
    mkdirSync(join(configDir(), 'sessions'), { recursive: true });
    writeFileSync(stampFile(client.session!), '');
  }
  return out.held;
}

export async function sessionStart(input: HookInput, env: HookEnv): Promise<string> {
  const session = cleanSession(input.session_id);
  if (session) writeSessionEnv(env, session);
  const b = boardFromCwd(input.cwd);
  if (!b) return ''; // not a GitHub repo: nothing to say
  const token = await getToken(env.url);
  if (!token) return `Punchlist: ${b.owner}/${b.repo} may have a shared TODO board, but punch isn't signed in on this machine. Tell the user once that \`/punch login\` signs in.`;
  const client = new Client({ url: env.url, token, session, timeoutMs: HOOK_TIMEOUT_MS });
  let read;
  try {
    read = await readBoard(client, b);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return `Punchlist: there's no board for ${b.owner}/${b.repo} that ${loadConfig().user ?? 'you'} can see, so ignore the board in this repo.`;
    if (e instanceof ApiError && e.status === 401) return `Punchlist: punch's sign-in on this machine has expired or was revoked. Tell the user once that \`/punch login\` signs in again.`;
    return `Punchlist: couldn't load the board for ${b.owner}/${b.repo} (${(e as Error).message}).`;
  }
  let held: Item[] | null = null;
  if (session && !read.offlineSince) held = await sessionCall(client, b, 'heartbeat').catch(() => null);
  const me = loadConfig().user;
  const r = rules(env);
  const out = [...(r ? [r, ''] : []), formatCompact(read.snapshot, { me, session })];
  if (read.offlineSince) out.push(`(Offline: this is the board as of ${read.offlineSince}. Changes you make are queued and sent when punch is back online.)`);
  if (me) out.push(`You are signed in as ${me}.${held?.length ? ` This session holds ${held.map(i => i.id).join(', ')}.` : ''}`);
  if (input.source === 'resume' && held && !held.length) {
    out.push("This session's claims were released when it last closed. If you're picking up an item again, `punch start` it again.");
  }
  return out.join('\n');
}

export async function heartbeat(input: HookInput, env: HookEnv): Promise<void> {
  const session = cleanSession(input.session_id);
  const b = boardFromCwd(input.cwd);
  if (!session || !b) return;
  try {
    if (Date.now() - statSync(stampFile(session)).mtimeMs < HEARTBEAT_EVERY_MS) return;
  } catch {
    // no heartbeat yet
  }
  const token = await getToken(env.url);
  if (!token) return;
  await sessionCall(new Client({ url: env.url, token, session, timeoutMs: HOOK_TIMEOUT_MS }), b, 'heartbeat').catch(() => null);
}

export async function sessionEnd(input: HookInput, env: HookEnv): Promise<void> {
  const session = cleanSession(input.session_id);
  const b = boardFromCwd(input.cwd);
  if (!session || !b) return;
  rmSync(stampFile(session), { force: true });
  const token = await getToken(env.url);
  if (!token) return;
  await sessionCall(new Client({ url: env.url, token, session, timeoutMs: HOOK_TIMEOUT_MS }), b, 'end').catch(() => null);
}

/** Reads the hook's JSON from stdin; an empty or broken one is treated as no input. */
export async function readHookInput(stream: NodeJS.ReadableStream = process.stdin): Promise<HookInput> {
  if ((stream as NodeJS.ReadStream).isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
  } catch {
    return {};
  }
}

export async function runHook(event: string, input: HookInput, env: HookEnv): Promise<string> {
  try {
    if (event === 'session-start') return await sessionStart(input, env);
    if (event === 'heartbeat') await heartbeat(input, env);
    else if (event === 'session-end') await sessionEnd(input, env);
  } catch (e) {
    if (event === 'session-start' && !(e instanceof NetworkError)) return `Punchlist: the board couldn't be loaded (${(e as Error).message}).`;
  }
  return '';
}

