import { randomToken, sha256 } from './crypto';
import type { User } from './directory';

// API tokens (FR-3): what `punch login` gets after the GitHub device flow. One per person per machine,
// sent as `Authorization: Bearer pl_…`, stored only as a hash, revocable from the CLI or the API.

const DAY_MS = 86_400_000;
const nowIso = () => new Date().toISOString();

export interface TokenInfo {
  id: string;
  machine: string;
  created_at: string;
  last_used_at: string | null;
}

/** A tidy machine label: what the CLI says it's running on, trimmed to something printable. */
export const machineName = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/[^\w .@:-]/g, '').trim().slice(0, 64) : '') || 'unknown';

export async function mintToken(env: Env, userId: number, machine: string): Promise<string> {
  const token = `pl_${randomToken()}`;
  const id = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(`INSERT INTO tokens (id, token_hash, user_id, machine, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, await sha256(token), userId, machineName(machine), nowIso())
    .run();
  return token;
}

/** Who a Bearer token belongs to, if it's live. `last_used_at` is written at most once a day (PRD §8). */
export async function tokenUser(env: Env, token: string): Promise<{ user: User; tokenId: string } | null> {
  if (!token.startsWith('pl_')) return null;
  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, t.last_used_at, u.id, u.login, u.name, u.avatar_url
     FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
  ).bind(await sha256(token)).first<{ token_id: string; last_used_at: string | null; id: number; login: string; name: string | null; avatar_url: string | null }>();
  if (!row) return null;
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > DAY_MS) {
    await env.DB.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`).bind(nowIso(), row.token_id).run();
  }
  return { user: { id: row.id, login: row.login, name: row.name, avatar: row.avatar_url }, tokenId: row.token_id };
}

export async function listTokens(env: Env, userId: number): Promise<TokenInfo[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, machine, created_at, last_used_at FROM tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).bind(userId).all<TokenInfo>();
  return results;
}

/** Revokes one of this person's tokens. False if it isn't theirs or is already revoked. */
export async function revokeToken(env: Env, userId: number, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).bind(nowIso(), id, userId).run();
  return r.meta.changes > 0;
}
