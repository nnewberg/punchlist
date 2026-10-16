import { DEV_PEOPLE } from '../shared/config';
import type { BoardInfo, PersonInfo, Role } from '../shared/types';
import { listInstallationRepos, listInstallations, repoPermission } from './github';
import { memo } from './memo';

// The board directory and who may use which board (PRD FR-1, FR-2), kept in D1.

export interface User {
  id: number;
  login: string;
  name: string | null;
  avatar: string | null;
}

export interface Board extends BoardInfo {
  repoId: number;
  installationId: number | null;
}

interface BoardRow {
  repo_id: number;
  owner: string;
  repo: string;
  prefix: string;
  installation_id: number | null;
}

interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

/** How long a role from GitHub is trusted before it's checked again (FR-2). */
export const ROLE_FRESH_MS = 10 * 60_000;

const nowIso = () => new Date().toISOString();
const toBoard = (r: BoardRow): Board => ({ owner: r.owner, repo: r.repo, prefix: r.prefix, repoId: r.repo_id, installationId: r.installation_id });
export const boardInfo = (b: Board): BoardInfo => ({ owner: b.owner, repo: b.repo, prefix: b.prefix });

const PREFIX_OVERRIDES: Record<string, string> = { punchlist: 'PL' };

/** Item ID prefix for a new board: initials of a hyphenated name (big-talk → BT), else its first two letters. */
export function prefixFor(repo: string): string {
  const name = repo.toLowerCase();
  const override = PREFIX_OVERRIDES[name];
  if (override) return override;
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  const prefix = words.length > 1 ? words.slice(0, 3).map(w => w[0]).join('') : (words[0] ?? 'it').slice(0, 2);
  return prefix.toUpperCase();
}

export function allowedOwner(env: Env, owner: string): boolean {
  return env.ALLOWED_OWNERS.split(',').map(s => s.trim().toLowerCase()).includes(owner.toLowerCase());
}

// ---- Boards ----

const BOARD_COLS = 'repo_id, owner, repo, prefix, installation_id';

/**
 * A board by name with this person's role on it, in one query (and none at all when the answer is
 * under a minute old in this isolate). Unknown and inaccessible boards both come back as role 'none'.
 */
export async function boardForUser(env: Env, user: User, owner: string, repo: string): Promise<{ board: Board | null; role: Role }> {
  return memo(`board:${user.id}:${owner.toLowerCase()}/${repo.toLowerCase()}`, async () => {
    const row = await env.DB.prepare(
      `SELECT b.repo_id, b.owner, b.repo, b.prefix, b.installation_id, a.role, a.checked_at
       FROM boards b LEFT JOIN access a ON a.repo_id = b.repo_id AND a.user_id = ?
       WHERE b.owner = ? AND b.repo = ? AND b.archived_at IS NULL`,
    ).bind(user.id, owner, repo).first<BoardRow & { role: Role | null; checked_at: string | null }>();
    if (!row) return { board: null, role: 'none' as Role };
    const board = toBoard(row);
    return { board, role: await roleFor(env, user, board, row.role && row.checked_at ? { role: row.role, checked_at: row.checked_at } : null) };
  }, v => !!v.board);
}

export async function listBoards(env: Env): Promise<Board[]> {
  const { results } = await env.DB.prepare(`SELECT ${BOARD_COLS} FROM boards WHERE archived_at IS NULL ORDER BY owner, repo`).all<BoardRow>();
  return results.map(toBoard);
}

/** Creates the board for an installed repo, or brings an archived one back. Repos outside ALLOWED_OWNERS are ignored. */
export async function upsertBoard(env: Env, repo: RepoRef, installationId: number): Promise<boolean> {
  if (!allowedOwner(env, repo.owner)) return false;
  await env.DB.batch([
    // Another live board under this name is a deleted repo that was recreated: archive the old one.
    env.DB.prepare(`UPDATE boards SET archived_at = ? WHERE owner = ? AND repo = ? AND repo_id != ? AND archived_at IS NULL`).bind(nowIso(), repo.owner, repo.name, repo.id),
    env.DB.prepare(
      `INSERT INTO boards (repo_id, owner, repo, prefix, installation_id, archived_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (repo_id) DO UPDATE SET owner = excluded.owner, repo = excluded.repo, installation_id = excluded.installation_id, archived_at = NULL`,
    ).bind(repo.id, repo.owner, repo.name, prefixFor(repo.name), installationId, nowIso()),
  ]);
  return true;
}

export async function archiveBoards(env: Env, where: { repoIds?: number[]; installationId?: number }) {
  if (where.repoIds?.length) {
    await env.DB.prepare(`UPDATE boards SET archived_at = ? WHERE archived_at IS NULL AND repo_id IN (${where.repoIds.map(() => '?').join(',')})`).bind(nowIso(), ...where.repoIds).run();
  }
  if (where.installationId != null) {
    await env.DB.prepare(`UPDATE boards SET archived_at = ? WHERE archived_at IS NULL AND installation_id = ?`).bind(nowIso(), where.installationId).run();
  }
}

async function syncInstallation(env: Env, installationId: number) {
  const repos = await listInstallationRepos(env, installationId);
  for (const r of repos) await upsertBoard(env, { id: r.id, owner: r.owner.login, name: r.name }, installationId);
  const live = new Set(repos.map(r => r.id));
  const { results } = await env.DB.prepare(`SELECT repo_id FROM boards WHERE installation_id = ? AND archived_at IS NULL`).bind(installationId).all<{ repo_id: number }>();
  await archiveBoards(env, { repoIds: results.map(r => r.repo_id).filter(id => !live.has(id)) });
}

/**
 * Brings the directory in line with the App's installations on GitHub, for webhooks that were missed
 * (or never sent, in local dev). With an installation id, syncs just that one.
 */
export async function reconcile(env: Env, installationId?: number) {
  if (installationId != null) return syncInstallation(env, installationId);
  const installs = await listInstallations(env);
  for (const inst of installs) {
    if (inst.account && allowedOwner(env, inst.account.login)) await syncInstallation(env, inst.id);
  }
  const ids = new Set(installs.map(i => i.id));
  const { results } = await env.DB.prepare(`SELECT DISTINCT installation_id FROM boards WHERE archived_at IS NULL AND installation_id IS NOT NULL`).all<{ installation_id: number }>();
  for (const r of results) if (!ids.has(r.installation_id)) await archiveBoards(env, { installationId: r.installation_id });
}

let lastReconcile = 0;
/** At most one full reconcile every few minutes per isolate; sign-in calls this. */
export function reconcileSoon(env: Env): Promise<void> | null {
  if (env.DEV_MODE === '1' || Date.now() - lastReconcile < 5 * 60_000) return null;
  lastReconcile = Date.now();
  return reconcile(env).catch(e => console.error('reconcile failed', e));
}

// ---- GitHub App webhooks: boards follow installs, uninstalls and renames (FR-1) ----

interface WebhookRepo {
  id: number;
  name: string;
  owner?: { login: string };
}
interface WebhookPayload {
  action?: string;
  installation?: { id: number; account?: { login: string } };
  repositories?: WebhookRepo[];
  repositories_added?: WebhookRepo[];
  repositories_removed?: WebhookRepo[];
  repository?: WebhookRepo & { owner: { login: string } };
}

export async function handleWebhook(env: Env, event: string, p: WebhookPayload) {
  const inst = p.installation;
  const owner = inst?.account?.login ?? '';
  const ref = (r: WebhookRepo): RepoRef => ({ id: r.id, owner: r.owner?.login ?? owner, name: r.name });
  if (event === 'installation' && inst) {
    if (p.action === 'created' || p.action === 'unsuspend') {
      for (const r of p.repositories ?? []) await upsertBoard(env, ref(r), inst.id);
    } else if (p.action === 'deleted' || p.action === 'suspend') {
      await archiveBoards(env, { installationId: inst.id });
    }
  } else if (event === 'installation_repositories' && inst) {
    for (const r of p.repositories_added ?? []) await upsertBoard(env, ref(r), inst.id);
    await archiveBoards(env, { repoIds: (p.repositories_removed ?? []).map(r => r.id) });
  } else if (event === 'repository' && p.repository) {
    const r = p.repository;
    if (p.action === 'deleted') await archiveBoards(env, { repoIds: [r.id] });
    else if ((p.action === 'renamed' || p.action === 'transferred') && inst) {
      // A transfer to an owner we don't serve archives the board (upsertBoard ignores it).
      if (!(await upsertBoard(env, ref(r), inst.id))) await archiveBoards(env, { repoIds: [r.id] });
    }
  }
}

// ---- Access (FR-2) ----

const roleOf = (permission: string): Role => (permission === 'admin' || permission === 'write' ? 'edit' : permission === 'read' ? 'view' : 'none');

/** This person's role on a board, from GitHub, cached for ten minutes. */
export async function roleFor(env: Env, user: User, board: Board, known?: { role: Role; checked_at: string } | null): Promise<Role> {
  const row = known !== undefined ? known : await env.DB.prepare(`SELECT role, checked_at FROM access WHERE user_id = ? AND repo_id = ?`).bind(user.id, board.repoId).first<{ role: Role; checked_at: string }>();
  if (env.DEV_MODE === '1') return row?.role ?? 'none';
  if (row && Date.now() - Date.parse(row.checked_at) < ROLE_FRESH_MS) return row.role;
  if (board.installationId == null) return 'none';
  let role: Role;
  try {
    role = roleOf(await repoPermission(env, board.installationId, board.owner, board.repo, user.login));
  } catch (e) {
    // GitHub unreachable: keep the last answer rather than lock everyone out; check again next time.
    if (row) return row.role;
    throw e;
  }
  await env.DB.prepare(
    `INSERT INTO access (user_id, repo_id, role, checked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, repo_id) DO UPDATE SET role = excluded.role, checked_at = excluded.checked_at`,
  ).bind(user.id, board.repoId, role, nowIso()).run();
  return role;
}

/** Boards this person can see, with their role on each. */
export async function boardsFor(env: Env, user: User): Promise<(Board & { role: Exclude<Role, 'none'> })[]> {
  const boards = await listBoards(env);
  const roles = await Promise.all(boards.map(b => roleFor(env, user, b)));
  return boards.flatMap((b, i) => (roles[i] === 'none' ? [] : [{ ...b, role: roles[i] as Exclude<Role, 'none'> }]));
}

/** Names and avatars of everyone with access to these boards, for showing claims, notes and presence. */
export async function peopleOn(env: Env, repoIds: number[]): Promise<Record<string, PersonInfo>> {
  if (!repoIds.length) return {};
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT u.login, u.name, u.avatar_url FROM access a JOIN users u ON u.id = a.user_id
     WHERE a.role != 'none' AND a.repo_id IN (${repoIds.map(() => '?').join(',')})`,
  ).bind(...repoIds).all<{ login: string; name: string | null; avatar_url: string | null }>();
  return Object.fromEntries(results.map(r => [r.login, { name: r.name, avatar: r.avatar_url }]));
}

// ---- Users ----

const toUser = (r: { id: number; login: string; name: string | null; avatar_url: string | null }): User => ({ id: r.id, login: r.login, name: r.name, avatar: r.avatar_url });

export async function upsertUser(env: Env, u: { id: number; login: string; name: string | null; avatar_url: string | null }): Promise<User> {
  const login = u.login.toLowerCase();
  await env.DB.prepare(
    `INSERT INTO users (id, login, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
  ).bind(u.id, login, u.name, u.avatar_url, nowIso()).run();
  return { id: u.id, login, name: u.name, avatar: u.avatar_url };
}

export async function userByLogin(env: Env, login: string): Promise<User | null> {
  const row = await env.DB.prepare(`SELECT id, login, name, avatar_url FROM users WHERE login = ?`).bind(login).first<{ id: number; login: string; name: string | null; avatar_url: string | null }>();
  return row ? toUser(row) : null;
}

// ---- Dev mode: the design's sample boards and people (DEV_MODE) ----

const DEV_BOARDS: { repoId: number; owner: string; repo: string; prefix: string; roles: Record<string, Role> }[] = [
  // Kevin can only view big-talk, so read-only mode can be tried with ?as=kevin.
  { repoId: 9001, owner: 'futureleisurefoundation', repo: 'big-talk', prefix: 'BT', roles: { nick: 'edit', aaron: 'edit', kevin: 'view' } },
  { repoId: 9002, owner: 'nnewberg', repo: 'bulletin-bee', prefix: 'BB', roles: { nick: 'edit', kevin: 'edit' } },
  { repoId: 9003, owner: 'nnewberg', repo: 'punchlist', prefix: 'PL', roles: { nick: 'edit' } },
];
const DEV_USER_IDS: Record<string, number> = { nick: 1, aaron: 2, kevin: 3 };

let devSeeded = false;
export async function ensureDevSeed(env: Env) {
  if (devSeeded || env.DEV_MODE !== '1') return;
  const t = nowIso();
  await env.DB.batch([
    ...Object.entries(DEV_USER_IDS).map(([login, id]) =>
      env.DB.prepare(`INSERT OR IGNORE INTO users (id, login, name, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)`).bind(id, login, DEV_PEOPLE[login]!.name, t)),
    ...DEV_BOARDS.map(b =>
      env.DB.prepare(`INSERT OR IGNORE INTO boards (repo_id, owner, repo, prefix, installation_id, archived_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)`).bind(b.repoId, b.owner, b.repo, b.prefix, t)),
    ...DEV_BOARDS.flatMap(b => Object.entries(b.roles).map(([login, role]) =>
      env.DB.prepare(`INSERT OR IGNORE INTO access (user_id, repo_id, role, checked_at) VALUES (?, ?, ?, ?)`).bind(DEV_USER_IDS[login]!, b.repoId, role, t))),
  ]);
  devSeeded = true;
}
