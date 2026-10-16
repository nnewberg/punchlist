import type { Actor, ImportFile, Me, Op } from '../shared/types';
import { handleAuth, sameOrigin } from './auth';
import { BoardDO, refuseClientOp } from './board';
import { boardForUser, boardInfo, boardsFor, ensureDevSeed, handleWebhook, peopleOn, reconcile, reconcileSoon, type Board, type User } from './directory';
import { githubConfigured, verifyWebhook } from './github';
import { resolveUser, type Identity } from './identity';
import { listTokens, revokeToken } from './tokens';
import { SYNC_EVENTS, syncFromGitHub } from './webhook';

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
    const res = await api(request, env, ctx, who, parts, url);
    if (!who.setCookie || res.status === 101) return res;
    const renewed = new Response(res.body, res);
    renewed.headers.append('set-cookie', who.setCookie);
    return renewed;
  },
} satisfies ExportedHandler<Env>;

/** Who did it, and through what (FR-4): the CLI says `cli`, or `claude` with the agent's session. */
function actorFor(request: Request, user: User): Actor {
  const via = request.headers.get('X-Punch-Via');
  const session = request.headers.get('X-Punch-Session')?.replace(/[^\w.:-]/g, '').slice(0, 64);
  return { user: user.login, via: via === 'cli' || via === 'claude' ? via : 'web', ...(session ? { session } : {}) };
}

async function api(request: Request, env: Env, ctx: ExecutionContext, who: Identity, parts: string[], url: URL): Promise<Response> {
  const { user } = who;
  // Cookies need a same-origin check against CSRF; a Bearer token can't be sent by another site.
  const trusted = !!who.tokenId || sameOrigin(request);
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

  // /v1/me/tokens: this person's CLI tokens, to list and revoke (FR-3). `current` is the one asking.
  if (parts[1] === 'me' && parts[2] === 'tokens') {
    if (parts.length === 3 && request.method === 'GET') {
      return json({ tokens: (await listTokens(env, user.id)).map(t => ({ ...t, current: t.id === who.tokenId })) });
    }
    if (parts.length === 4 && request.method === 'DELETE') {
      if (!trusted) return json({ error: 'forbidden' }, 403);
      const id = parts[3] === 'current' ? who.tokenId : parts[3];
      return id && (await revokeToken(env, user.id, id)) ? new Response(null, { status: 204 }) : notFound();
    }
  }

  // GET /v1/me/work: My work across boards (FR-35); reads each board live.
  if (parts[1] === 'me' && parts[2] === 'work') {
    const boards = await boardsFor(env, user);
    return json({ boards: await Promise.all(boards.map(b => stubFor(env, b).myWork(boardInfo(b), user.login, user.name ?? user.login))) });
  }

  // /v1/boards/:owner/:repo[/...]
  if (parts[1] === 'boards' && parts.length >= 4) {
    const { board, role } = await boardForUser(env, user, parts[2]!, parts[3]!);
    // 404 rather than 403, so outsiders can't confirm a board exists (FR-3a).
    if (!board || role === 'none') return notFound();
    const stub = stubFor(env, board);
    const info = boardInfo(board);
    const rest = parts.slice(4);
    const readOnly = 'You can view this board but not change it. Changing it needs write access to the repo.';

    if (rest.length === 0 && request.method === 'GET') return json(await stub.snapshot(info));

    if (rest[0] === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      if (!trusted) return json({ error: 'forbidden' }, 403);
      const headers = new Headers(request.headers);
      headers.set('X-Punch-Board', JSON.stringify(info));
      headers.set('X-Punch-User', user.login);
      headers.set('X-Punch-Role', role);
      return stub.fetch(new Request(request.url, { headers }));
    }

    // POST an op, or an array of ops applied in order that stops at the first one refused.
    if (rest[0] === 'ops' && request.method === 'POST') {
      if (!trusted) return json({ error: 'forbidden' }, 403);
      if (role !== 'edit') return forbidden(readOnly);
      const body = (await request.json().catch(() => null)) as Op | Op[] | null;
      const ops = Array.isArray(body) ? body : body ? [body] : [];
      const refused = !ops.length || ops.length > 50 ? 'Send 1 to 50 ops' : ops.map(refuseClientOp).find(Boolean);
      if (refused) return json({ ok: false, error: { code: 'invalid', message: refused } }, 400);
      const actor = actorFor(request, user);
      const results = [];
      for (const op of ops) {
        const out = await stub.apply(info, op, actor);
        results.push(out);
        if (!out.ok) break;
      }
      const last = results[results.length - 1]!;
      const status = last.ok ? 200 : last.error.code === 'not_found' ? 404 : 409;
      return json(Array.isArray(body) ? { ok: last.ok, results } : last, status);
    }

    // POST /import {items}: a repo's old tracking, translated into Punchlist items (§7.9). All or nothing.
    if (rest[0] === 'import' && rest.length === 1 && request.method === 'POST') {
      if (!trusted) return json({ error: 'forbidden' }, 403);
      if (role !== 'edit') return forbidden(readOnly);
      const body = (await request.json().catch(() => null)) as ImportFile | null;
      if (!body || !Array.isArray(body.items)) return json({ ok: false, errors: ['Send {items: [...]}'] }, 400);
      if (body.board && body.board.toLowerCase() !== `${info.owner}/${info.repo}`.toLowerCase()) {
        return json({ ok: false, errors: [`This file is for ${body.board}, not ${info.owner}/${info.repo}.`] }, 400);
      }
      const out = await stub.importItems(info, body.items, actorFor(request, user));
      return json(out, out.ok ? 200 : 409);
    }

    // POST /session {action}: a Claude session's hooks keep its claims alive, or release them when it ends (FR-24).
    if (rest[0] === 'session' && rest.length === 1 && request.method === 'POST') {
      if (!trusted) return json({ error: 'forbidden' }, 403);
      if (role !== 'edit') return forbidden(readOnly);
      const actor = actorFor(request, user);
      const { action } = ((await request.json().catch(() => null)) ?? {}) as { action?: string };
      if (!actor.session || (action !== 'heartbeat' && action !== 'end')) {
        return json({ ok: false, error: { code: 'invalid', message: 'Needs X-Punch-Session and an action of heartbeat or end' } }, 400);
      }
      return json({ ok: true, ...(await stub.session(info, { ...actor, user: user.login, session: actor.session }, action)) });
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
    // without pushing anything.
    if (rest[0] === 'dev' && rest[1] === 'gh-close' && request.method === 'POST' && env.DEV_MODE === '1') {
      if (role !== 'edit') return forbidden(readOnly);
      const body = (await request.json()) as { id: string; pr?: number; commit?: string; author?: string; message?: string };
      const commit = body.commit ?? crypto.randomUUID().replace(/-/g, '').slice(0, 7);
      const citation = { kind: 'closes' as const, commit, ...(body.pr ? { pr: body.pr } : {}), branch: 'main', how: 'explicit' as const, confidence: null, ...(body.author ? { author: body.author } : {}), ...(body.message ? { message: body.message } : {}) };
      const out = await stub.apply(info, { op: 'cite', id: body.id, citation }, { user: null, via: 'github' });
      return json(out, out.ok ? 200 : 409);
    }
  }

  return notFound();
}

// The GitHub App's webhook (installs, uninstalls, renames: FR-1; pushes and PRs: FR-29) and its post-install redirect.
async function github(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/github/webhook' && request.method === 'POST') {
    if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: 'not configured' }, 503);
    const body = await request.arrayBuffer();
    if (!(await verifyWebhook(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) return json({ error: 'bad signature' }, 401);
    const event = request.headers.get('x-github-event') ?? '';
    const payload = JSON.parse(new TextDecoder().decode(body));
    if (SYNC_EVENTS.has(event)) {
      // Pushes and PRs (FR-29). A failure is a 500, so the delivery shows as failed on GitHub and can be redelivered.
      const delivery = request.headers.get('x-github-delivery') ?? crypto.randomUUID();
      try {
        console.log('github', event, delivery, await syncFromGitHub(env, event, delivery, payload));
      } catch (e) {
        console.error('github sync failed', event, delivery, e);
        return json({ error: 'sync failed' }, 500);
      }
      return new Response(null, { status: 204 });
    }
    await handleWebhook(env, event, payload);
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
