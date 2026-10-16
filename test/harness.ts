import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { createSession } from '../worker/auth';
import { prefixFor } from '../worker/directory';
import worker from '../worker/index';
import { clearMemo } from '../worker/memo';

// Runs the Worker as production would (no dev stub), with a fake GitHub behind `fetch`.

export const ORIGIN = 'https://punchlist.example.workers.dev';
export const INSTALL = 77;
export const WEBHOOK_SECRET = 'whsec';

export interface FakeGitHub {
  /** Each login's permission per repo: `${repo}:${login}` → permission. */
  perms: Record<string, string>;
  repos: { id: number; name: string; owner: { login: string } }[];
  /** Device-flow polls answer with these in turn, then keep repeating the last. */
  devicePolls: string[];
  calls: string[];
  /** GitHub refuses device codes, as it does until the App has Device Flow ticked. */
  deviceDisabled?: boolean;
}

export const gh: FakeGitHub = { perms: {}, repos: [], devicePolls: [], calls: [] };
export let prod: Env;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export function useProdWorker() {
  beforeAll(async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const der = (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer;
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
    prod = {
      ...env,
      DEV_MODE: '0',
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: pem,
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csecret',
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };
  });

  beforeEach(() => {
    gh.perms = {};
    gh.repos = [
      { id: 501, name: 'big-talk', owner: { login: 'futureleisurefoundation' } },
      { id: 502, name: 'bulletin-bee', owner: { login: 'nnewberg' } },
    ];
    gh.devicePolls = ['authorization_pending', 'ok'];
    gh.calls = [];
    gh.deviceDisabled = false;
    clearMemo();
    let poll = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      gh.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/login/device/code' && gh.deviceDisabled) return json({ error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled for this App' }, 400);
      if (url.pathname === '/login/device/code') return json({ device_code: 'dev-code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      if (url.pathname === '/login/oauth/access_token') {
        const body = JSON.parse(String(init?.body));
        if (body.grant_type) {
          const answer = gh.devicePolls[Math.min(poll++, gh.devicePolls.length - 1)];
          return answer === 'ok' ? json({ access_token: 'user-token' }) : json({ error: answer });
        }
        return body.code === 'good' ? json({ access_token: 'user-token' }) : json({ error: 'bad_verification_code' });
      }
      if (url.pathname === '/user') return json({ id: 9, login: 'Aaron-T', name: 'Aaron', avatar_url: 'https://avatars.githubusercontent.com/u/9' });
      if (url.pathname === `/app/installations/${INSTALL}/access_tokens`) return json({ token: 'inst-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/app/installations') return json([{ id: INSTALL, account: { login: 'nnewberg' } }]);
      if (url.pathname === '/installation/repositories') return json({ repositories: gh.repos });
      const m = /^\/repos\/[^/]+\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
      if (m) {
        const p = gh.perms[`${m[1]}:${m[2]}`];
        return p ? json({ permission: p }) : json({ message: 'Not Found' }, 404);
      }
      return json({ message: `unexpected ${url.pathname}` }, 500);
    });
  });

  afterEach(() => vi.unstubAllGlobals());
}

export async function call(path: string, init: RequestInit & { cookie?: string; token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }) as Request<unknown, IncomingRequestCfProperties>, prod, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function seedBoards() {
  for (const r of gh.repos) {
    await env.DB.prepare(`INSERT OR REPLACE INTO boards (repo_id, owner, repo, prefix, installation_id, archived_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .bind(r.id, r.owner.login, r.name, prefixFor(r.name), INSTALL, new Date().toISOString()).run();
  }
}

/** A signed-in browser session for the fake GitHub user (aaron-t, id 9), starting from a clean slate. */
export async function signedIn(login = 'aaron-t', id = 9) {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, login, name, avatar_url, created_at) VALUES (?, ?, 'Aaron', NULL, ?)`).bind(id, login, new Date().toISOString()).run();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM access WHERE user_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
  ]);
  return `__Host-pl_session=${await createSession(prod, id)}`;
}
