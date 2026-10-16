import type { Me, Op } from '../shared/types';
import { handleAuth, sameOrigin } from './auth';
import { BoardDO, CLIENT_OPS } from './board';
import { boardInfo, boardsFor, ensureDevSeed, findBoard, handleWebhook, peopleOn, reconcile, reconcileSoon, roleFor, type Board, type User } from './directory';
import { githubConfigured, verifyWebhook } from './github';
import { resolveUser } from './identity';

export { BoardDO };

// Entry point (PRD §5): the REST + WebSocket API under /v1, GitHub sign-in under /auth, and the GitHub
// App's webhook and post-install redirect under /github. Everything else is the static web board,
// served by Workers Assets (see run_worker_first in wrangler.jsonc).

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const notFound = () => json({ error: 'not_found' }, 404);
const forbidden = (message: string) => json({ ok: false, error: { code: 'forbidden', message } }, 403);

const stubFor = (env: Env, b: Board) => env.BOARD.get(env.BOARD.idFromName(`repo:${b.repoId}`));
const installUrl = (env: Env) => (githubConfigured(env) ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : null);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth/')) return (await handleAuth(request, env, ctx)) ?? notFound();
    if (url.pathname.startsWith('/github/')) return github(request, env, url);

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1') return env.ASSETS.fetch(request);

    await ensureDevSeed(env);
    const who = await resolveUser(request, env);
    if (!who) return json({ error: 'unauthenticated' }, 401);
    const res = await api(request, env, ctx, who.user, parts, url);
    if (!who.setCookie || res.status === 101) return res;
    const renewed = new Response(res.body, res);
    renewed.headers.append('set-cookie', who.setCookie);
    return renewed;
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, env: Env, ctx: ExecutionContext, user: User, parts: string[], url: URL): Promise<Response> {
  // GET /v1/me: who I am, my boards and my role on each, and the people on them.
  if (parts[1] === 'me' && parts.length === 2) {
    const sync = reconcileSoon(env);
    if (sync) ctx.waitUntil(sync);
    const boards = await boardsFor(env, user);
    const people = await peopleOn(env, boards.map(b => b.repoId));
    people[user.login] ??= { name: user.name, avatar: user.avatar };
    return json({
      user: user.login,
      boards: boards.map(b => ({ ...boardInfo(b), role: b.role })),
      people,
      installUrl: installUrl(env),
      dev: env.DEV_MODE === '1',
    } satisfies Me);
  }

  // GET /v1/me/work: My work across boards (FR-35); reads each board live.
  if (parts[1] === 'me' && parts[2] === 'work') {
    const boards = await boardsFor(env, user);
    return json({ boards: await Promise.all(boards.map(b => stubFor(env, b).myWork(boardInfo(b), user.login, user.name ?? user.login))) });
  }

  // /v1/boards/:owner/:repo[/...]
  if (parts[1] === 'boards' && parts.length >= 4) {
    const board = await findBoard(env, parts[2]!, parts[3]!);
    const role = board ? await roleFor(env, user, board) : 'none';
    // 404 rather than 403, so outsiders can't confirm a board exists (FR-3a).
    if (!board || role === 'none') return notFound();
    const stub = stubFor(env, board);
    const info = boardInfo(board);
    const rest = parts.slice(4);
    const readOnly = 'You can view this board but not change it. Changing it needs write access to the repo.';

    if (rest.length === 0 && request.method === 'GET') return json(await stub.snapshot(info));

    if (rest[0] === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
      const headers = new Headers(request.headers);
      headers.set('X-Punch-Board', JSON.stringify(info));
      headers.set('X-Punch-User', user.login);
      headers.set('X-Punch-Role', role);
      return stub.fetch(new Request(request.url, { headers }));
    }

    if (rest[0] === 'ops' && request.method === 'POST') {
      if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
      if (role !== 'edit') return forbidden(readOnly);
      const op = (await request.json()) as Op;
      if (!op || !CLIENT_OPS.has(op.op)) return json({ ok: false, error: { code: 'invalid', message: 'Unsupported op' } }, 400);
      const via = request.headers.get('X-Punch-Via') === 'cli' ? 'cli' : 'web';
      const out = await stub.apply(info, op, { user: user.login, via });
      return out.ok ? json(out) : json(out, out.error.code === 'not_found' ? 404 : 409);
    }

    if (rest[0] === 'events' && request.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const out = await stub.eventsSince(info, since);
      return out ? json(out) : json({ resync: true }, 410);
    }

    if (rest[0] === 'items' && rest[2] === 'history' && request.method === 'GET') {
      return json({ events: await stub.history(info, rest[1]!) });
    }

    // DEV: simulate GitHub closing an item from a merged PR, so the live "punch" can be tried
    // before webhooks exist (M4).
    if (rest[0] === 'dev' && rest[1] === 'gh-close' && request.method === 'POST' && env.DEV_MODE === '1') {
      if (role !== 'edit') return forbidden(readOnly);
      const body = (await request.json()) as { id: string; pr?: number; commit?: string; author?: string; message?: string };
      const commit = body.commit ?? crypto.randomUUID().replace(/-/g, '').slice(0, 7);
      const out = await stub.apply(info, { op: 'gh_close', id: body.id, commit, ...(body.pr ? { pr: body.pr } : {}), ...(body.author ? { author: body.author } : {}), ...(body.message ? { message: body.message } : {}) }, { user: null, via: 'github' });
      return json(out, out.ok ? 200 : 409);
    }
  }

  return notFound();
}

// The GitHub App's webhook (installs, uninstalls, renames: FR-1) and its post-install redirect.
async function github(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/github/webhook' && request.method === 'POST') {
    if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: 'not configured' }, 503);
    const body = await request.arrayBuffer();
    if (!(await verifyWebhook(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) return json({ error: 'bad signature' }, 401);
    await handleWebhook(env, request.headers.get('x-github-event') ?? '', JSON.parse(new TextDecoder().decode(body)));
    return new Response(null, { status: 204 });
  }

  // GitHub sends the installer here after they pick repos; sync that installation so its boards are
  // there when they land, even if the webhook is slow.
  if (url.pathname === '/github/setup' && request.method === 'GET') {
    const id = Number(url.searchParams.get('installation_id'));
    if (githubConfigured(env) && Number.isInteger(id) && id > 0) {
      await reconcile(env, id).catch(e => console.error('setup sync failed', e));
    }
    return new Response(null, { status: 302, headers: { location: '/' } });
  }

  return notFound();
}
