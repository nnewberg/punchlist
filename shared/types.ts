// Data model — see PRD §6. Shared by the Worker, the board Durable Object and the web client.

export type Status = 'backlog' | 'up_next' | 'in_progress' | 'done' | 'dropped';
export const COLUMNS = ['backlog', 'up_next', 'in_progress', 'done'] as const;
export type Column = (typeof COLUMNS)[number];

export type Via = 'web' | 'cli' | 'claude' | 'github' | 'reconciler';

/** Who made a change, and through what. `user` is null for GitHub/reconciler events with no mapped person. */
export interface Actor {
  user: string | null;
  via: Via;
  session?: string;
}

export interface Claim {
  user: string;
  kind: 'session' | 'branch' | 'manual';
  ref?: string;
  machine?: string;
  since: string;
  heartbeat_at?: string;
}

export interface Citation {
  kind: 'closes' | 'pending' | 'refs';
  commit?: string;
  pr?: number;
  branch?: string;
  how: 'explicit' | 'inferred' | 'manual';
  confidence: number | null;
  author?: string;
  at: string;
  reverted?: boolean;
  message?: string;
}

export interface Note {
  at: string;
  actor: string;
  via?: Via;
  session?: string;
  commit?: string;
  text: string;
}

export interface Item {
  id: string;
  title: string;
  body: string;
  status: Status;
  rank: string;
  blocked: { reason: string; since: string } | null;
  tags: string[];
  depends_on: string[];
  aliases: string[];
  source: { kind: 'chat' | 'claude-deferred' | 'web' | 'cli' | 'import' | 'github'; ref?: string; actor: string };
  created_at: string;
  created_by: string;
  claim: Claim | null;
  citations: Citation[];
  notes: Note[];
  /** Bumped on every body change; body edits must carry the version they were based on (FR-8). */
  body_version: number;
  body_by?: string;
  /** Column the item was in before its current one; used by reopen and claim release (FR-28, S9). */
  prev_status?: Status;
  closed_at?: string;
  updated_at: string;
}

export type Op =
  | { op: 'create'; title: string; body?: string; status?: Column; tags?: string[]; source?: Item['source']['kind'] }
  | { op: 'move'; id: string; status: Status; beforeId?: string | null }
  | { op: 'edit'; id: string; title?: string; body?: string; baseBodyVersion?: number }
  | { op: 'claim'; id: string; kind?: Claim['kind']; ref?: string; steal?: boolean }
  | { op: 'release'; id: string }
  | { op: 'block'; id: string; reason: string }
  | { op: 'unblock'; id: string }
  | { op: 'note'; id: string; text: string; commit?: string }
  | { op: 'tag'; id: string; add?: string[]; remove?: string[] }
  | { op: 'depends'; id: string; add?: string[]; remove?: string[] }
  | { op: 'reopen'; id: string }
  | { op: 'drop'; id: string }
  | { op: 'undo'; seq: number }
  /** Server-internal: a GitHub close (M4 will produce these from webhooks; dev uses it to simulate). */
  | { op: 'gh_close'; id: string; commit: string; pr?: number; author?: string; message?: string; how?: Citation['how']; confidence?: number | null }
  /** Server-internal: field restore produced by `undo`. */
  | { op: 'restore'; id: string; fields: Partial<Item>; undoOf: number };

export type OpName = Op['op'] | 'seed';

/** Display hints stored with an event (e.g. commit refs for seeded/GitHub history). */
export interface EventMeta {
  text?: string;
  ref?: string;
  msg?: string;
  undoOf?: number;
}

export interface BoardEvent {
  seq: number;
  ts: string;
  actor: Actor;
  item_id: string;
  op: OpName;
  meta?: EventMeta;
  /** Whether the event carries before/after values that undo can restore. */
  undoable: boolean;
}

export interface BoardInfo {
  owner: string;
  repo: string;
  prefix: string;
}

export interface Snapshot {
  board: BoardInfo;
  items: Item[];
  seq: number;
  viewers: string[];
}

export type OpError =
  | { code: 'not_found'; message: string }
  | { code: 'invalid'; message: string }
  | { code: 'claimed'; message: string; holder: Claim }
  | { code: 'conflict'; message: string; by?: string; theirs: string; version: number };

// WebSocket protocol
export type ClientMsg =
  | { type: 'op'; clientOpId: string; op: Op }
  | { type: 'sync'; since: number };

export type ServerMsg =
  | { type: 'event'; event: BoardEvent; item: Item; clientOpId?: string }
  | { type: 'reject'; clientOpId: string; error: OpError }
  /** The op was valid but changed nothing, so no event was written. */
  | { type: 'ack'; clientOpId: string }
  | { type: 'presence'; viewers: string[] }
  | { type: 'resync'; snapshot: Snapshot }
  | { type: 'events'; events: { event: BoardEvent; item: Item }[]; seq: number };

export interface MyWorkBoard {
  board: BoardInfo;
  held: Item[];
  upNext: Item[];
  blockedOnMe: Item[];
}
