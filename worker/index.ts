import { boardsFor, findBoard, type BoardConfig } from '../shared/config';
import type { BoardInfo, Op } from '../shared/types';
import { BoardDO, CLIENT_OPS } from './board';
import { resolveUser } from './identity';

export { BoardDO };

// REST + WebSocket entry point (PRD §5). Static assets (the web board) are served by Workers Assets;
// only /v1/* reaches this code (see run_worker_first in wrangler.jsonc).

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const notFound = () => json({ error: 'not_found' }, 404);

const infoOf = (b: BoardConfig): BoardInfo => ({ owner: b.owner, repo: b.repo, prefix: b.prefix });
const stubFor = (env: Env, b: BoardConfig) => env.BOARD.get(env.BOARD.idFromName(`${b.owner}/${b.repo}`));

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1') return env.ASSETS.fetch(request);

    const user = resolveUser(request, env);
    if (!user) return json({ error: 'unauthenticated' }, 401);

    // GET /v1/me
    if (parts[1] === 'me' && parts.length === 2) {
      return json({ user, boards: boardsFor(user).map(infoOf) });
    }

    // GET /v1/me/work — My work across boards (FR-35); reads each board live.
    if (parts[1] === 'me' && parts[2] === 'work') {
      const boards = await Promise.all(boardsFor(user).map(b => stubFor(env, b).myWork(infoOf(b), user)));
      return json({ boards });
    }

    // /v1/boards/:owner/:repo[/...]
    if (parts[1] === 'boards' && parts.length >= 4) {
      const board = findBoard(parts[2]!, parts[3]!);
      // 404 rather than 403, so outsiders can't confirm a board exists (FR-3a).
      if (!board || !board.members.includes(user)) return notFound();
      const stub = stubFor(env, board);
      const info = infoOf(board);
      const rest = parts.slice(4);

      if (rest.length === 0 && request.method === 'GET') return json(await stub.snapshot(info));

      if (rest[0] === 'ws') {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
        const headers = new Headers(request.headers);
        headers.set('X-Punch-Board', JSON.stringify(info));
        headers.set('X-Punch-User', user);
        return stub.fetch(new Request(request.url, { headers }));
      }

      if (rest[0] === 'ops' && request.method === 'POST') {
        const op = (await request.json()) as Op;
        if (!op || !CLIENT_OPS.has(op.op)) return json({ error: { code: 'invalid', message: 'Unsupported op' } }, 400);
        const via = request.headers.get('X-Punch-Via') === 'cli' ? 'cli' : 'web';
        const out = await stub.apply(info, op, { user, via });
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
        const body = (await request.json()) as { id: string; pr?: number; commit?: string; author?: string; message?: string };
        const commit = body.commit ?? crypto.randomUUID().replace(/-/g, '').slice(0, 7);
        const out = await stub.apply(info, { op: 'gh_close', id: body.id, commit, ...(body.pr ? { pr: body.pr } : {}), ...(body.author ? { author: body.author } : {}), ...(body.message ? { message: body.message } : {}) }, { user: null, via: 'github' });
        return json(out, out.ok ? 200 : 409);
      }
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
