import { reconcileSoon, upsertUser, type User } from './directory';
import { authorizeUrl, githubConfigured, userFromCode } from './github';

// Signing in with GitHub (FR-3, FR-3a). The only way in is the GitHub App's user authorization; the
// session is a random token in an HttpOnly cookie, stored only as a hash, kept alive for 90 days of
// use. A small non-secret cookie remembers that this browser has signed in before, so an expired
// session goes back through GitHub without a click instead of showing the sign-in page.

export const SESSION_COOKIE = '__Host-pl_session';
const OAUTH_COOKIE = '__Host-pl_oauth';
/** Readable by the page: "this browser has signed in before". Holds nothing secret. */
export const KNOWN_COOKIE = 'pl_known';

const SESSION_DAYS = 90;
const DAY_MS = 86_400_000;

const nowIso = () => new Date().toISOString();

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const cookie = (name: string, value: string, maxAge: number, httpOnly = true) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}`;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Only same-site paths, so `next` can't send someone off to another site after signing in. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

/** State-changing requests and WebSocket upgrades must come from this site's own pages (CSRF). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin;
}

// ---- Sessions ----

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = randomToken();
  const t = Date.now();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, refreshed_at) VALUES (?, ?, ?, ?)`)
    .bind(await sha256(token), userId, new Date(t + SESSION_DAYS * DAY_MS).toISOString(), new Date(t).toISOString())
    .run();
  return token;
}

/**
 * The signed-in user, if any. A session in use is extended to 90 days from now, but at most once a
 * day, so ordinary requests write nothing (PRD §8); `setCookie` then carries the renewed cookie.
 */
export async function sessionUser(request: Request, env: Env): Promise<{ user: User; setCookie?: string } | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.login, u.name, u.avatar_url, s.expires_at, s.refreshed_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(hash).first<{ id: number; login: string; name: string | null; avatar_url: string | null; expires_at: string; refreshed_at: string }>();
  if (!row) return null;
  const t = Date.now();
  if (Date.parse(row.expires_at) <= t) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(hash).run();
    return null;
  }
  const user: User = { id: row.id, login: row.login, name: row.name, avatar: row.avatar_url };
  if (t - Date.parse(row.refreshed_at) < DAY_MS) return { user };
  await env.DB.prepare(`UPDATE sessions SET expires_at = ?, refreshed_at = ? WHERE token_hash = ?`)
    .bind(new Date(t + SESSION_DAYS * DAY_MS).toISOString(), new Date(t).toISOString(), hash)
    .run();
  return { user, setCookie: cookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400) };
}

// ---- Routes: /auth/login, /auth/callback, /auth/logout ----

const page = (status: number, message: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Punchlist</title>` +
      `<body style="background:#1b1917;color:#f0e9df;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center"><p>${message}</p><p><a style="color:#e4825a" href="/auth/login">Try again</a></p></div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );

const redirect = (to: string, cookies: string[] = []) => {
  const headers = new Headers({ location: to, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
};

export async function handleAuth(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const callback = `${url.origin}/auth/callback`;

  if (url.pathname === '/auth/login' && request.method === 'GET') {
    if (!githubConfigured(env)) return page(503, 'GitHub sign-in isn’t set up on this server yet.');
    const state = randomToken();
    const next = safeNext(url.searchParams.get('next'));
    return redirect(authorizeUrl(env, callback, state), [cookie(OAUTH_COOKIE, `${state}.${encodeURIComponent(next)}`, 600)]);
  }

  if (url.pathname === '/auth/callback' && request.method === 'GET') {
    const saved = readCookie(request, OAUTH_COOKIE) ?? '';
    const dot = saved.indexOf('.');
    const state = dot > 0 ? saved.slice(0, dot) : '';
    const next = saved.slice(dot + 1);
    const code = url.searchParams.get('code');
    if (!state || !code || url.searchParams.get('state') !== state) return page(400, 'That sign-in link expired. Please sign in again.');
    let gh;
    try {
      gh = await userFromCode(env, code, callback);
    } catch (e) {
      console.error(e);
      return page(502, 'GitHub didn’t confirm the sign-in.');
    }
    const user = await upsertUser(env, gh);
    // A fresh sign-in re-checks every board, so newly granted access shows up straight away.
    await env.DB.prepare(`DELETE FROM access WHERE user_id = ?`).bind(user.id).run();
    const token = await createSession(env, user.id);
    const sync = reconcileSoon(env);
    if (sync) ctx.waitUntil(sync);
    let to = '/';
    try {
      to = safeNext(decodeURIComponent(next));
    } catch {
      // malformed: go home
    }
    return redirect(to, [
      cookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400),
      cookie(KNOWN_COOKIE, '1', 400 * 86_400, false),
      cookie(OAUTH_COOKIE, '', 0),
    ]);
  }

  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
    // Forget this browser too, so signing out doesn't bounce straight back in through GitHub.
    const headers = new Headers({ 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(SESSION_COOKIE, '', 0));
    headers.append('set-cookie', cookie(KNOWN_COOKIE, '', 0, false));
    return new Response(null, { status: 204, headers });
  }

  return null;
}
