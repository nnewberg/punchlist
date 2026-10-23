import { DurableObject } from 'cloudflare:workers';
import { checkImport, importedItem } from '../shared/import';
import { applyOp, claimFor, columnItems, idKey, inversePatch, rankFor, resolveId } from '../shared/ops';
import { CLIENT_SOURCES, SESSION_TTL_MS, type Actor, type BoardEvent, type BoardInfo, type ClientMsg, type EventMeta, type ImportItem, type Item, type MyWorkBoard, type Op, type OpError, type Role, type ServerMsg, type Snapshot } from '../shared/types';
import { editorsOf } from './directory';
import { ingest, type GhFacts } from './ingest';
import { buildSeed } from './seed';

// One Durable Object per board (PRD §5.1). Every write goes through here, one at a time, so IDs never
// collide and every client sees the same order. Follows the §8 cost rules: hibernatable WebSockets,
// keepalives answered by auto-response, no timers and no outbound fetches.

export type ApplyOutcome =
  | { ok: true; event: BoardEvent; item: Item }
  | { ok: true; noop: true; item: Item }
  | { ok: false; error: OpError };

/** Ops a client may send. GitHub ops (`cite`, `link_pr`, `revert`, `branch_end`) and `restore` are produced by the service itself. */
export const CLIENT_OPS = new Set<Op['op']>(['create', 'move', 'edit', 'claim', 'release', 'block', 'unblock', 'note', 'tag', 'depends', 'reopen', 'drop', 'undo']);

/** Why a client may not send this op, or null if it may. */
export function refuseClientOp(op: Op | null | undefined): string | null {
  if (!op || !CLIENT_OPS.has(op.op)) return 'Unsupported op';
  if (op.op === 'create' && op.source !== undefined && !(CLIENT_SOURCES as readonly string[]).includes(op.source)) {
    return `An item's source can only be ${CLIENT_SOURCES.join(', ')}`;
  }
  if (op.op === 'claim' && op.user !== undefined && typeof op.user !== 'string') return 'A claim’s user must be a login';
  return null;
}

interface SocketAttachment {
  user: string;
  /** Checked by the Worker when the socket opened; a viewer's socket can't change the board. */
  role: Role;
}

interface EventRow extends Record<string, SqlStorageValue> {
  seq: number;
  ts: string;
  item_id: string;
  op: string;
  actor: string;
  before: string | null;
  after: string | null;
  meta: string | null;
  undoable: number;
}

const RESYNC_AFTER = 500;
/** How long a webhook delivery ID is remembered, to ignore GitHub's repeats (FR-29). */
const DELIVERY_TTL_MS = 30 * 86400_000;
/** How long the board trusts its list of who can be assigned, and how long it waits for D1 to read it. */
const EDITORS_FRESH_MS = 60_000;
const EDITORS_TIMEOUT_MS = 2_000;
/** A session's last heartbeat is written at most this often (§8: no write per heartbeat). */
const HEARTBEAT_WRITE_MS = 10 * 60_000;

/** What a Claude session holds on this board, returned to its hooks. */
export interface SessionState {
  held: Item[];
}

export class BoardDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private items = new Map<string, Item>();
  private info: BoardInfo | null = null;
  private seq = 0;
  private nextNum = 1;
  /** Last heartbeat per Claude session, in ms. Kept in memory; written to `sessions` coarsely. */
  private seen = new Map<string, { at: number; stored: number }>();
  /** When the alarm is set for, as far as this instance knows. */
  private alarmAt: number | null = null;
  /** Client ops in arrival order: an assignment may wait on D1, and what's sent after it mustn't overtake it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Who can be assigned, as last read from D1. */
  private editors: { at: number; map: ReadonlyMap<string, string | null> } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => this.load());
  }

  private load() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, item_id TEXT NOT NULL, op TEXT NOT NULL, actor TEXT NOT NULL,
      before TEXT, after TEXT, meta TEXT, undoable INTEGER NOT NULL DEFAULT 1)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS events_item ON events (item_id, seq)`);
    // GitHub sync (FR-29, FR-33): deliveries already handled, and each commit's PR and whether it has
    // landed on the default branch.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gh_deliveries (id TEXT PRIMARY KEY, at TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gh_commits (sha TEXT PRIMARY KEY, pr INTEGER, merge INTEGER NOT NULL DEFAULT 0, on_default INTEGER NOT NULL DEFAULT 0)`);
    // Claude sessions' last heartbeats, for session claims' lapse (FR-28).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user TEXT NOT NULL, last_seen INTEGER NOT NULL)`);
    for (const r of this.sql.exec<{ id: string; last_seen: number }>(`SELECT id, last_seen FROM sessions`)) {
      this.seen.set(r.id, { at: r.last_seen, stored: r.last_seen });
    }
    const meta = new Map(this.sql.exec<{ k: string; v: string }>(`SELECT k, v FROM meta`).toArray().map(r => [r.k, r.v]));
    if (meta.has('info')) this.info = JSON.parse(meta.get('info')!);
    this.seq = Number(meta.get('seq') ?? 0);
    this.nextNum = Number(meta.get('next_num') ?? 1);
    for (const r of this.sql.exec<{ json: string }>(`SELECT json FROM items`)) {
      const it = JSON.parse(r.json) as Item;
      this.items.set(it.id, it);
    }
  }

  private setMeta(k: string, v: string) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);
  }

  /** First touch creates the board; in dev an empty board is filled from the design's sample data. */
  private ensure(info: BoardInfo) {
    if (this.info) {
      // The repo was renamed or transferred; the board (and its prefix) stays the same.
      if (this.info.owner !== info.owner || this.info.repo !== info.repo) {
        this.info = { ...this.info, owner: info.owner, repo: info.repo };
        this.setMeta('info', JSON.stringify(this.info));
      }
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.info = info;
      this.setMeta('info', JSON.stringify(info));
      const seed = this.env.DEV_MODE === '1' ? buildSeed(`${info.owner}/${info.repo}`) : null;
      if (seed) {
        for (const it of seed.items) this.writeItem(it);
        for (const e of seed.events) {
          this.seq += 1;
          this.sql.exec(
            `INSERT INTO events (seq, ts, item_id, op, actor, before, after, meta, undoable) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0)`,
            this.seq, e.ts, e.item_id, e.op, JSON.stringify(e.actor), JSON.stringify(e.meta ?? {}),
          );
        }
        const nums = seed.items.map(i => Number(/-(\d+)/.exec(i.id)?.[1] ?? 0));
        this.nextNum = Math.max(0, ...nums) + 1;
      }
      this.setMeta('seq', String(this.seq));
      this.setMeta('next_num', String(this.nextNum));
    });
  }

  private writeItem(it: Item) {
    this.items.set(it.id, it);
    this.sql.exec(`INSERT INTO items (id, status, json) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, json = excluded.json`, it.id, it.status, JSON.stringify(it));
  }

  private rowToEvent(r: EventRow): BoardEvent {
    return { seq: r.seq, ts: r.ts, actor: JSON.parse(r.actor), item_id: r.item_id, op: r.op as BoardEvent['op'], meta: r.meta ? JSON.parse(r.meta) : undefined, undoable: r.undoable === 1 };
  }

  // ---- RPC (called by the Worker) ----

  snapshot(info: BoardInfo): Snapshot {
    this.ensure(info);
    return { board: this.info!, items: [...this.items.values()], seq: this.seq, viewers: this.viewers() };
  }

  /**
   * An item's activity, newest first. Moves within a column are left out (PL-007): they only change
   * rank and would swamp the list. They stay in the event log, which is how clients sync. A reorder
   * that also claimed an unclaimed in-progress item (FR-11) still shows.
   */
  history(info: BoardInfo, id: string): BoardEvent[] {
    this.ensure(info);
    return this.sql.exec<EventRow>(
      `SELECT * FROM events WHERE item_id = ?
         AND NOT (op = 'move'
           AND json_extract(before, '$.status') IS json_extract(after, '$.status')
           AND json_extract(before, '$.claim') IS json_extract(after, '$.claim'))
       ORDER BY seq DESC LIMIT 200`,
      id,
    ).toArray().map(r => this.rowToEvent(r));
  }

  eventsSince(info: BoardInfo, since: number): { events: { event: BoardEvent; item: Item }[]; seq: number } | null {
    this.ensure(info);
    if (this.seq - since > RESYNC_AFTER) return null;
    const rows = this.sql.exec<EventRow>(`SELECT * FROM events WHERE seq > ? ORDER BY seq`, since).toArray();
    return {
      seq: this.seq,
      events: rows.flatMap(r => {
        const item = this.items.get(r.item_id);
        return item ? [{ event: this.rowToEvent(r), item }] : [];
      }),
    };
  }

  myWork(info: BoardInfo, user: string, displayName: string): MyWorkBoard {
    this.ensure(info);
    const all = [...this.items.values()];
    const name = displayName.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    const names = [...new Set([user, name, name.split(' ')[0]].filter(Boolean))].join('|');
    const mentions = (reason: string) => new RegExp(`\\b(${names})\\b`, 'i').test(reason);
    return {
      board: this.info!,
      held: columnItems(all, 'in_progress').filter(i => i.claim?.user === user),
      upNext: columnItems(all, 'up_next').slice(0, 3),
      blockedOnMe: all.filter(i => i.blocked && i.status !== 'done' && i.status !== 'dropped' && mentions(i.blocked.reason)),
    };
  }

  /**
   * One GitHub webhook delivery, already turned into facts by the Worker. Applied in one transaction;
   * a delivery seen before changes nothing.
   */
  ingestGitHub(info: BoardInfo, delivery: string, facts: GhFacts): { duplicate: boolean; changes: number } {
    this.ensure(info);
    const changed: { event: BoardEvent; item: Item }[] = [];
    let duplicate = false;
    this.ctx.storage.transactionSync(() => {
      const now = new Date().toISOString();
      if (this.sql.exec(`SELECT 1 FROM gh_deliveries WHERE id = ?`, delivery).toArray().length) {
        duplicate = true;
        return;
      }
      this.sql.exec(`INSERT INTO gh_deliveries (id, at) VALUES (?, ?)`, delivery, now);
      this.sql.exec(`DELETE FROM gh_deliveries WHERE at < ?`, new Date(Date.now() - DELIVERY_TTL_MS).toISOString());
      const sql = this.sql;
      ingest(
        {
          items: this.items,
          prefix: this.info!.prefix,
          apply: (op, actor) => {
            const out = this.applyInner(op, actor);
            if (out.ok && !('noop' in out)) changed.push(out);
          },
          rememberCommit(sha, o) {
            const row = sql.exec<{ on_default: number }>(`SELECT on_default FROM gh_commits WHERE sha = ?`, sha).toArray()[0];
            if (o.onDefault && row?.on_default) return false;
            sql.exec(
              `INSERT INTO gh_commits (sha, pr, merge, on_default) VALUES (?, ?, ?, ?)
               ON CONFLICT (sha) DO UPDATE SET pr = COALESCE(excluded.pr, pr), merge = MAX(merge, excluded.merge), on_default = MAX(on_default, excluded.on_default)`,
              sha, o.pr ?? null, o.merge ? 1 : 0, o.onDefault ? 1 : 0,
            );
            return true;
          },
          commitPr(sha, mergeOnly) {
            const row = sql.exec<{ pr: number }>(
              `SELECT pr FROM gh_commits WHERE sha LIKE ? AND pr IS NOT NULL AND merge >= ? LIMIT 1`,
              `${sha.toLowerCase().replace(/[^0-9a-f]/g, '')}%`, mergeOnly ? 1 : 0,
            ).toArray()[0];
            return row?.pr ?? null;
          },
        },
        facts,
      );
    });
    for (const c of changed) this.broadcast({ type: 'event', event: c.event, item: c.item });
    if (changed.length) this.scheduleLapse();
    return { duplicate, changes: changed.length };
  }

  /** A client's op. Ops are applied one at a time, in the order they arrived. */
  apply(info: BoardInfo, op: Op, actor: Actor, clientOpId?: string): Promise<ApplyOutcome> {
    const next = this.queue.then(() => this.applyNow(info, op, actor, clientOpId));
    this.queue = next.catch(() => {});
    return next;
  }

  private async applyNow(info: BoardInfo, op: Op, actor: Actor, clientOpId?: string): Promise<ApplyOutcome> {
    this.ensure(info);
    // Only someone who can edit the board can be assigned an item. Otherwise the last list read is
    // enough, for names in the history.
    let editors = this.editors?.map;
    if (op.op === 'claim' && claimFor(op, actor) !== (actor.user ?? 'github')) {
      try {
        editors = await this.editorsFor(claimFor(op, actor));
      } catch (e) {
        console.error('reading editors failed', e);
        return { ok: false, error: { code: 'invalid', message: 'Couldn’t check who can be assigned. Try again.' } };
      }
    }
    let outcome: ApplyOutcome;
    this.ctx.storage.transactionSync(() => {
      outcome = this.applyInner(op, actor, editors);
    });
    outcome = outcome!;
    if (outcome.ok && !('noop' in outcome)) {
      this.broadcast({ type: 'event', event: outcome.event, item: outcome.item, ...(clientOpId ? { clientOpId } : {}) });
      this.scheduleLapse();
    }
    return outcome;
  }

  /**
   * Who can be assigned, from D1, where the Worker records each person's role (FR-2). A list under a
   * minute old is used as is when it has `login`; otherwise it's read again, so someone who just signed
   * in can be assigned straight away. The read gives up after 2 s, since every op waits behind it.
   */
  private async editorsFor(login: string): Promise<ReadonlyMap<string, string | null>> {
    const c = this.editors;
    if (c && Date.now() - c.at < EDITORS_FRESH_MS && c.map.has(login)) return c.map;
    // Named for its repo's id (`repo:<id>`), which outlasts renames; the name a board shows can belong to another repo later.
    const repoId = Number(/^repo:(\d+)$/.exec(this.ctx.id.name ?? '')?.[1]);
    if (!repoId) throw new Error(`board ${this.ctx.id.name ?? this.ctx.id.toString()} isn't named for a repo id`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('D1 took too long')), EDITORS_TIMEOUT_MS)));
    try {
      const map = await Promise.race([editorsOf(this.env, repoId), timeout]);
      this.editors = { at: Date.now(), map };
      return map;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Import (PRD §7.9) ----

  /**
   * Writes an import file's items in one transaction, keeping their IDs, or writes nothing and says
   * why. New items made afterwards are numbered after the highest imported one.
   */
  importItems(info: BoardInfo, specs: ImportItem[], actor: Actor): { ok: true; ids: string[] } | { ok: false; errors: string[] } {
    this.ensure(info);
    const plan = checkImport(this.info!.prefix, this.items, specs);
    if (plan.errors.length) return { ok: false, errors: plan.errors };
    const now = new Date().toISOString();
    const pad = (n: number) => `${this.info!.prefix}-${String(n).padStart(3, '0')}`;
    let ids: string[] = [];
    this.ctx.storage.transactionSync(() => {
      this.nextNum = Math.max(this.nextNum, plan.maxNum + 1);
      ids = plan.ids.map(id => id ?? pad(this.nextNum++));
      // Dependencies may name an imported item by an alias; store its ID.
      const names = new Map<string, string>();
      specs.forEach((s, i) => { for (const n of [ids[i]!, ...(s.aliases ?? [])]) names.set(idKey(n), ids[i]!); });
      const depId = (d: string) => names.get(idKey(d)) ?? resolveId(this.items, d)?.id ?? d;
      specs.forEach((spec, i) => {
        const rank = rankFor(this.items.values(), spec.status, null);
        const it = importedItem({ ...spec, depends_on: (spec.depends_on ?? []).map(depId) }, ids[i]!, actor, now, rank);
        this.appendEvent('import', actor, now, null, it, { text: spec.why ? `Imported: ${spec.why}` : 'Imported' });
        this.writeItem(it);
      });
      this.setMeta('next_num', String(this.nextNum));
    });
    // One resync instead of an event per item.
    this.broadcast({ type: 'resync', snapshot: this.snapshot(this.info!) });
    return { ok: true, ids };
  }

  /**
   * One-off backfill (scripts/backfill-heads.mjs): merged PRs' head branches, by PR number, for closes
   * citations made before they were recorded. Each is a `link_pr`, so it fills in only what's missing
   * and lands in the log like the merge would have. Returns the items it changed.
   */
  recordHeads(info: BoardInfo, heads: Record<string, string>, actor: Actor): { ok: true; ids: string[] } {
    this.ensure(info);
    const changed: { event: BoardEvent; item: Item }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const it of [...this.items.values()]) {
        const prs = new Set(it.citations.flatMap(c => (c.kind === 'closes' && c.pr && !c.head && heads[c.pr] ? [c.pr] : [])));
        for (const pr of prs) {
          const out = this.applyInner({ op: 'link_pr', id: it.id, pr, commits: [], head: heads[pr] }, actor);
          if (out.ok && !('noop' in out)) changed.push(out);
        }
      }
    });
    for (const c of changed) this.broadcast({ type: 'event', event: c.event, item: c.item });
    return { ok: true, ids: [...new Set(changed.map(c => c.item.id))] };
  }

  // ---- Claude sessions (FR-24, FR-28) ----

  /**
   * A Claude session's hooks: `heartbeat` keeps its claims alive, `end` releases them. Returns what
   * the session still holds. `now` is for tests.
   */
  session(info: BoardInfo, actor: Actor & { user: string; session: string }, action: 'heartbeat' | 'end', now = Date.now()): SessionState {
    this.ensure(info);
    const id = actor.session;
    if (action === 'end') {
      const changed: { event: BoardEvent; item: Item }[] = [];
      this.ctx.storage.transactionSync(() => {
        for (const it of this.sessionClaims(id, actor.user)) {
          const out = this.applyInner({ op: 'release', id: it.id, reason: 'Released when the Claude session ended' }, actor);
          if (out.ok && !('noop' in out)) changed.push(out);
        }
        this.sql.exec(`DELETE FROM sessions WHERE id = ?`, id);
      });
      this.seen.delete(id);
      for (const c of changed) this.broadcast({ type: 'event', event: c.event, item: c.item });
      this.scheduleLapse();
      return { held: [] };
    }
    const prev = this.seen.get(id);
    const stored = prev && now - prev.stored < HEARTBEAT_WRITE_MS ? prev.stored : now;
    if (stored === now) {
      this.sql.exec(`INSERT INTO sessions (id, user, last_seen) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen`, id, actor.user, now);
    }
    this.seen.set(id, { at: now, stored });
    return { held: this.sessionClaims(id, actor.user) };
  }

  private sessionClaims(session: string, user: string): Item[] {
    return [...this.items.values()].filter(i => i.claim?.kind === 'session' && i.claim.ref === session && i.claim.user === user);
  }

  /** When a session claim lapses: two hours after its session's last heartbeat, or after the claim if there was none since. */
  private lapsesAt(it: Item): number | null {
    const c = it.claim;
    if (c?.kind !== 'session' || it.status === 'done' || it.status === 'dropped') return null;
    const beat = c.ref ? (this.seen.get(c.ref)?.at ?? 0) : 0;
    return Math.max(beat, Date.parse(c.since)) + SESSION_TTL_MS;
  }

  /** Keeps the alarm set for the first session claim that could lapse. Heartbeats only push lapses later, so an early alarm just re-checks. */
  private scheduleLapse() {
    let first: number | null = null;
    for (const it of this.items.values()) {
      const t = this.lapsesAt(it);
      if (t != null && (first == null || t < first)) first = t;
    }
    if (first == null || (this.alarmAt != null && this.alarmAt <= first && this.alarmAt > Date.now())) return;
    this.alarmAt = first;
    void this.ctx.storage.setAlarm(first);
  }

  async alarm() {
    this.alarmAt = null;
    this.expireClaims(Date.now());
  }

  /** Releases the session claims that have lapsed by `now` (FR-28), and sets the next alarm. Exposed for tests. */
  expireClaims(now: number): number {
    if (!this.info) return 0;
    const changed: { event: BoardEvent; item: Item }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const it of [...this.items.values()]) {
        const t = this.lapsesAt(it);
        if (t == null || t > now) continue;
        const out = this.applyInner({ op: 'release', id: it.id, reason: 'Claim lapsed: no word from its Claude session for 2 hours' }, { user: it.claim!.user, via: 'reconciler' });
        if (out.ok && !('noop' in out)) changed.push(out);
      }
      // Forget sessions that have been quiet for well past the lapse.
      const old = now - 2 * SESSION_TTL_MS;
      this.sql.exec(`DELETE FROM sessions WHERE last_seen < ?`, old);
      for (const [id, s] of this.seen) if (s.at < old) this.seen.delete(id);
    });
    for (const c of changed) this.broadcast({ type: 'event', event: c.event, item: c.item });
    this.scheduleLapse();
    return changed.length;
  }

  private applyInner(op: Op, actor: Actor, editors?: ReadonlyMap<string, string | null>): ApplyOutcome {
    const now = new Date().toISOString();
    let undid: string | undefined;
    if (op.op === 'undo') {
      const row = this.sql.exec<EventRow>(`SELECT * FROM events WHERE seq = ?`, op.seq).toArray()[0];
      if (!row) return { ok: false, error: { code: 'not_found', message: `No event ${op.seq}` } };
      if (!row.undoable || !row.after) return { ok: false, error: { code: 'invalid', message: 'That change can’t be undone' } };
      const after = JSON.parse(row.after) as Item;
      const fields: Partial<Item> = row.before ? inversePatch(JSON.parse(row.before) as Item, after) : { status: 'dropped', prev_status: after.status };
      undid = (row.meta ? (JSON.parse(row.meta) as EventMeta).text : undefined) ?? row.op;
      op = { op: 'restore', id: row.item_id, fields, undoOf: op.seq };
    }
    const newId = op.op === 'create' ? `${this.info!.prefix}-${String(this.nextNum).padStart(3, '0')}` : undefined;
    const res = applyOp(this.items, op, { actor, now, newId, ...(editors ? { editors } : {}) });
    if (!res.ok) return res;
    if (res.noop) return { ok: true, noop: true, item: res.item };
    if (op.op === 'create') {
      this.nextNum += 1;
      this.setMeta('next_num', String(this.nextNum));
    }
    const meta = undid ? { ...res.meta, text: `Undid “${undid}”` } : res.meta;
    const event = this.appendEvent(op.op, actor, now, res.before, res.after, meta);
    this.writeItem(res.after);
    return { ok: true, event, item: res.after };
  }

  private appendEvent(op: Op['op'] | 'import', actor: Actor, ts: string, before: Item | null, after: Item, meta: EventMeta): BoardEvent {
    this.seq += 1;
    this.sql.exec(
      `INSERT INTO events (seq, ts, item_id, op, actor, before, after, meta, undoable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      this.seq, ts, after.id, op, JSON.stringify(actor), before ? JSON.stringify(before) : null, JSON.stringify(after), JSON.stringify(meta),
    );
    this.setMeta('seq', String(this.seq));
    return { seq: this.seq, ts, actor, item_id: after.id, op, meta, undoable: true };
  }

  // ---- WebSockets (live updates FR-6, presence FR-14) ----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const info = JSON.parse(request.headers.get('X-Punch-Board')!) as BoardInfo;
    const user = request.headers.get('X-Punch-User')!;
    const role = (request.headers.get('X-Punch-Role') ?? 'view') as Role;
    this.ensure(info);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ user, role } satisfies SocketAttachment);
    this.broadcast({ type: 'presence', viewers: this.viewers() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const { user, role } = ws.deserializeAttachment() as SocketAttachment;
    if (msg.type === 'op') {
      if (role !== 'edit') return this.send(ws, { type: 'reject', clientOpId: msg.clientOpId, error: { code: 'forbidden', message: 'You can view this board but not change it.' } });
      const refused = refuseClientOp(msg.op);
      if (refused) return this.send(ws, { type: 'reject', clientOpId: msg.clientOpId, error: { code: 'invalid', message: refused } });
      let out: ApplyOutcome;
      try {
        out = await this.apply(this.info!, msg.op, { user, via: 'web' }, msg.clientOpId);
      } catch (e) {
        // Answer every op, or the tab keeps it pending forever.
        console.error('op failed', e);
        return this.send(ws, { type: 'reject', clientOpId: msg.clientOpId, error: { code: 'invalid', message: 'Something went wrong saving that. Try again.' } });
      }
      if (!out.ok) this.send(ws, { type: 'reject', clientOpId: msg.clientOpId, error: out.error });
      else if ('noop' in out) this.send(ws, { type: 'ack', clientOpId: msg.clientOpId });
    } else if (msg.type === 'sync') {
      const since = this.eventsSince(this.info!, msg.since);
      this.send(ws, since ? { type: 'events', ...since } : { type: 'resync', snapshot: this.snapshot(this.info!) });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    this.broadcast({ type: 'presence', viewers: this.viewers(ws) });
  }

  async webSocketError(ws: WebSocket) {
    this.broadcast({ type: 'presence', viewers: this.viewers(ws) });
  }

  private viewers(exclude?: WebSocket): string[] {
    const users = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude || ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att) users.add(att.user);
    }
    return [...users];
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket went away; presence catches up on close
    }
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // ignore
      }
    }
  }
}
