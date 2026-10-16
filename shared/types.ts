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

/** How long a session claim lasts without a heartbeat from its Claude session (FR-28). */
export const SESSION_TTL_MS = 2 * 3600_000;

/** Where a client may say an item came from; the rest are set by the service. */
export const CLIENT_SOURCES = ['chat', 'claude-deferred', 'cli'] as const;

/**
 * A commit or PR that closes an item, or will once it merges (`pending`). Partial progress (`Refs:`)
 * and bare mentions are notes, not citations. `how: 'branch'` is a close inferred from a merged branch
 * named for the item (`bt-014-…`) that never said `Closes`.
 */
export interface Citation {
  kind: 'closes' | 'pending';
  /** Full SHA; shown shortened. */
  commit?: string;
  pr?: number;
  branch?: string;
  how: 'explicit' | 'inferred' | 'manual' | 'branch';
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
  pr?: number;
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
  /** `reason` replaces "Released" in the history, e.g. when a session ends or its claim lapses. */
  | { op: 'release'; id: string; reason?: string }
  | { op: 'block'; id: string; reason: string }
  | { op: 'unblock'; id: string }
  | { op: 'note'; id: string; text: string; commit?: string; pr?: number }
  | { op: 'tag'; id: string; add?: string[]; remove?: string[] }
  | { op: 'depends'; id: string; add?: string[]; remove?: string[] }
  | { op: 'reopen'; id: string }
  | { op: 'drop'; id: string }
  | { op: 'undo'; seq: number }
  // Server-internal ops produced from GitHub events (FR-26–34); clients can't send these.
  /** A closing citation moves the item to Done (or just adds the link if it's already closed); a pending one adds the badge. */
  | { op: 'cite'; id: string; citation: Omit<Citation, 'at'> }
  /** Attaches a merged PR's number to the citations and notes from its commits (FR-33). */
  | { op: 'link_pr'; id: string; pr: number; commits: string[] }
  /** A revert landed: closes from these commits (by SHA prefix) or this PR stop counting, and the item reopens if nothing else closes it. */
  | { op: 'revert'; id: string; commits: string[]; prs: number[]; by: { commit: string; message?: string } }
  /** A branch was merged or deleted: its claim ends and its pending citations go (FR-28). */
  | { op: 'branch_end'; id: string; branch: string; note?: string }
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

/** What someone may do on a board, from their access to the repo (FR-2): write → edit, read → view. */
export type Role = 'edit' | 'view' | 'none';

/** A board as listed for one person, with their role on it. */
export interface BoardEntry extends BoardInfo {
  role: Exclude<Role, 'none'>;
}

/** How to show someone: their GitHub name and avatar. Keyed by login. */
export interface PersonInfo {
  name: string | null;
  avatar: string | null;
}

/** GET /v1/me */
export interface Me {
  user: string;
  boards: BoardEntry[];
  people: Record<string, PersonInfo>;
  /** Where to install the GitHub App on another repo, if GitHub is set up. */
  installUrl: string | null;
  /** Dev identity stub in use (DEV_MODE). */
  dev: boolean;
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
  | { code: 'forbidden'; message: string }
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
