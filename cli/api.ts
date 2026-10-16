import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, Op, OpError, Snapshot } from '../shared/types';
import { cacheDir, readJson, writeJson } from './config';
import type { BoardRef } from './repo';

// Talking to the Punchlist API, with the offline behaviour of FR-9: every board read is cached, a
// read that can't reach the server falls back to the cache, and a write that can't is queued in an
// outbox that the next command sends first, in order.

export class NetworkError extends Error {}

export class ApiError extends Error {
  constructor(public status: number, public data: unknown, message: string) {
    super(message);
  }
  get opError(): OpError | undefined {
    const d = this.data as { error?: OpError; results?: { ok: boolean; error?: OpError }[] } | null;
    if (d?.results) return d.results.find(r => !r.ok)?.error;
    return d?.error && typeof d.error === 'object' ? d.error : undefined;
  }
}

export interface ClientOptions {
  url: string;
  token: string | null;
  /** The agent session this command runs in, if any (FR-4): recorded on every change. */
  session?: string;
  /** How long to wait for the server; hooks wait less than commands. */
  timeoutMs?: number;
}

function describe(status: number, data: unknown, board?: BoardRef): string {
  const err = (data as { error?: unknown; results?: { ok: boolean; error?: OpError }[] } | null) ?? {};
  const opError = err.results?.find(r => !r.ok)?.error ?? (typeof err.error === 'object' ? (err.error as OpError) : undefined);
  if (opError) {
    return opError.code === 'claimed' ? `${opError.message} (use --steal to take it over)` : opError.message;
  }
  const errors = (data as { errors?: string[] } | null)?.errors;
  if (errors?.length) return errors.join('\n');
  if (status === 401) return 'Not signed in. Run `punch login`.';
  if (status === 404 && board) return `No board for ${board.owner}/${board.repo}, or you don't have access to it.`;
  return typeof err.error === 'string' ? `${err.error} (HTTP ${status})` : `HTTP ${status}`;
}

export class Client {
  constructor(private opts: ClientOptions) {}

  get url() {
    return this.opts.url;
  }

  get session() {
    return this.opts.session;
  }

  async request<T>(method: string, path: string, body?: unknown, board?: BoardRef): Promise<T> {
    const headers: Record<string, string> = { 'x-punch-via': this.opts.session ? 'claude' : 'cli' };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (this.opts.session) headers['x-punch-session'] = this.opts.session;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.opts.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    } catch (e) {
      throw new NetworkError(`Can't reach ${this.opts.url} (${(e as Error).message})`);
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok && res.status !== 202) throw new ApiError(res.status, data, describe(res.status, data, board));
    return data as T;
  }
}

export const boardPath = (b: BoardRef) => `/v1/boards/${encodeURIComponent(b.owner)}/${encodeURIComponent(b.repo)}`;

// ---- Cache ----

const boardFile = (b: BoardRef, ext: string) => join(cacheDir(), b.owner.toLowerCase(), `${b.repo.toLowerCase()}.${ext}`);

interface Cached {
  fetched_at: string;
  snapshot: Snapshot;
}

export function readCache(b: BoardRef): Cached | null {
  return readJson<Cached>(boardFile(b, 'json'));
}

function writeCache(b: BoardRef, snapshot: Snapshot) {
  writeJson(boardFile(b, 'json'), { fetched_at: new Date().toISOString(), snapshot } satisfies Cached);
}

/** Puts items the server just returned into the cached board, so an offline read right after a write is current. */
function patchCache(b: BoardRef, items: Item[]) {
  const c = readCache(b);
  if (!c || !items.length) return;
  const byId = new Map(c.snapshot.items.map(i => [i.id, i]));
  for (const it of items) byId.set(it.id, it);
  writeJson(boardFile(b, 'json'), { ...c, snapshot: { ...c.snapshot, items: [...byId.values()] } });
}

export interface BoardRead {
  snapshot: Snapshot;
  /** Set when the server couldn't be reached and this came from the cache. */
  offlineSince?: string;
}

export async function readBoard(client: Client, b: BoardRef): Promise<BoardRead> {
  try {
    const snapshot = await client.request<Snapshot>('GET', boardPath(b), undefined, b);
    writeCache(b, snapshot);
    return { snapshot };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    const cached = readCache(b);
    if (!cached) throw new NetworkError(`${e.message}, and there's no saved copy of ${b.owner}/${b.repo} on this machine yet`);
    return { snapshot: cached.snapshot, offlineSince: cached.fetched_at };
  }
}

// ---- Outbox ----

export interface Queued {
  /** What the person typed, for reporting what happened to it later. */
  label: string;
  ops: Op[];
  at: string;
}

export type ApplyResult = { ok: true; item: Item; event?: unknown } | { ok: false; error: OpError };
export type WriteOutcome = { sent: true; results: ApplyResult[] } | { sent: false; queued: true };

export const outboxCount = (b: BoardRef) => readJson<Queued[]>(boardFile(b, 'outbox.json'))?.length ?? 0;

function queue(b: BoardRef, entry: Queued) {
  const box = readJson<Queued[]>(boardFile(b, 'outbox.json')) ?? [];
  box.push(entry);
  writeJson(boardFile(b, 'outbox.json'), box);
}

async function post(client: Client, b: BoardRef, ops: Op[]): Promise<ApplyResult[]> {
  const out = await client.request<{ results: ApplyResult[] }>('POST', `${boardPath(b)}/ops`, ops, b);
  const results = out.results;
  patchCache(b, results.flatMap(r => (r.ok ? [r.item] : [])));
  return results;
}

/**
 * Sends a write now, or queues it if the server can't be reached. A refusal (already claimed, a
 * conflict) throws an ApiError for the caller to report.
 */
export async function write(client: Client, b: BoardRef, label: string, ops: Op[]): Promise<WriteOutcome> {
  try {
    return { sent: true, results: await post(client, b, ops) };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    queue(b, { label, ops, at: new Date().toISOString() });
    return { sent: false, queued: true };
  }
}

export interface FlushReport {
  sent: { label: string; ops: Op[]; results: ApplyResult[] }[];
  refused: { label: string; message: string }[];
  remaining: number;
}

/** Sends queued writes in order. Stops at the first network failure; a refusal is reported and dropped. */
export async function flush(client: Client, b: BoardRef): Promise<FlushReport | null> {
  const file = boardFile(b, 'outbox.json');
  if (!existsSync(file) || statSync(file).size === 0) return null;
  const box = readJson<Queued[]>(file) ?? [];
  const report: FlushReport = { sent: [], refused: [], remaining: 0 };
  while (box.length) {
    const entry = box[0]!;
    try {
      report.sent.push({ label: entry.label, ops: entry.ops, results: await post(client, b, entry.ops) });
    } catch (e) {
      if (e instanceof NetworkError) break;
      report.refused.push({ label: entry.label, message: (e as Error).message });
    }
    box.shift();
  }
  report.remaining = box.length;
  if (box.length) writeJson(file, box);
  else rmSync(file, { force: true });
  return report;
}
