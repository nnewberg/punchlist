// GitHub, as the Worker sees it (never the Durable Object, which must not fetch: PRD §8 cost rules).
// The App's own credentials answer "which repos are installed" and "what can this person do on this
// repo", so no user's GitHub token is ever stored. A user token is used once, at sign-in, to learn who
// they are.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface GitHubRepo {
  id: number;
  name: string;
  owner: { login: string };
}

export interface GitHubInstallation {
  id: number;
  account: { login: string } | null;
}

export const githubConfigured = (env: Env) => !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

async function gh<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith('https://') ? path : `${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'punchlist',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${init.method ?? 'GET'} ${path}: ${res.status}`);
  return (await res.json()) as T;
}

// ---- The App's identity: a short JWT signed with its private key (RS256) ----

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

let signingKey: { pem: string; key: Promise<CryptoKey> } | null = null;

function appKey(pem: string): Promise<CryptoKey> {
  if (signingKey?.pem !== pem) {
    const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
    signingKey = { pem, key: crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']) };
  }
  return signingKey.key;
}

async function appJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new GitHubError(503, 'GitHub App is not configured');
  const now = Math.floor(Date.now() / 1000);
  // Backdated a minute for clock drift; GitHub allows at most ten minutes.
  const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await appKey(env.GITHUB_APP_PRIVATE_KEY), new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

// Installation tokens last an hour; reuse them per isolate until five minutes before they expire.
const installTokens = new Map<number, { token: string; expires: number }>();

async function installationToken(env: Env, installationId: number): Promise<string> {
  const hit = installTokens.get(installationId);
  if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
  const r = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, await appJwt(env), { method: 'POST' });
  installTokens.set(installationId, { token: r.token, expires: Date.parse(r.expires_at) });
  return r.token;
}

/** Someone's permission on a repo: admin, write, read or none (maintain and triage map to write and read). */
export async function repoPermission(env: Env, installationId: number, owner: string, repo: string, login: string): Promise<'admin' | 'write' | 'read' | 'none'> {
  try {
    const r = await gh<{ permission: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(login)}/permission`,
      await installationToken(env, installationId),
    );
    return r.permission === 'admin' || r.permission === 'write' || r.permission === 'read' ? r.permission : 'none';
  } catch (e) {
    // 404: not a collaborator (or the repo is gone from the installation).
    if (e instanceof GitHubError && e.status === 404) return 'none';
    throw e;
  }
}

export async function listInstallations(env: Env): Promise<GitHubInstallation[]> {
  const jwt = await appJwt(env);
  const out: GitHubInstallation[] = [];
  for (let page = 1; ; page++) {
    const batch = await gh<GitHubInstallation[]>(`/app/installations?per_page=100&page=${page}`, jwt);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

export async function listInstallationRepos(env: Env, installationId: number): Promise<GitHubRepo[]> {
  const token = await installationToken(env, installationId);
  const out: GitHubRepo[] = [];
  for (let page = 1; ; page++) {
    const r = await gh<{ repositories: GitHubRepo[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
    out.push(...r.repositories);
    if (r.repositories.length < 100) return out;
  }
}

// ---- Signing a person in (the App's user-authorization flow) ----

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

/** Trades the callback's code for who the person is. The user token is used once and dropped. */
export async function userFromCode(env: Env, code: string, redirectUri: string): Promise<GitHubUser> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'punchlist' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!body.access_token) throw new GitHubError(401, `GitHub sign-in failed: ${body.error ?? res.status}`);
  return gh<GitHubUser>('/user', body.access_token);
}

// ---- Signing in from the CLI: GitHub's device flow (FR-3) ----
// The Worker runs both halves, so the CLI only ever talks to Punchlist. A device code is only good for
// signing in as whoever approves it on GitHub, so it needs no protecting beyond what GitHub does.

async function githubForm<T>(url: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'punchlist' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new GitHubError(res.status, err.error === 'device_flow_disabled' ? 'Device sign-in is turned off for the Punchlist GitHub App (Settings → Enable Device Flow).' : (err.error_description ?? `GitHub ${url}: ${res.status}`));
  }
  return (await res.json()) as T;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function startDeviceFlow(env: Env): Promise<DeviceStart> {
  return githubForm<DeviceStart>('https://github.com/login/device/code', { client_id: env.GITHUB_CLIENT_ID! });
}

export type DevicePoll =
  | { status: 'ok'; user: GitHubUser }
  | { status: 'pending'; interval?: number }
  | { status: 'failed'; reason: 'expired' | 'denied' | 'disabled' | 'error'; message: string };

/** One poll: the person hasn't approved yet, has (with who they are), or the flow is over. */
export async function pollDeviceFlow(env: Env, deviceCode: string): Promise<DevicePoll> {
  const r = await githubForm<{ access_token?: string; error?: string; interval?: number; error_description?: string }>('https://github.com/login/oauth/access_token', {
    client_id: env.GITHUB_CLIENT_ID!,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (r.access_token) return { status: 'ok', user: await gh<GitHubUser>('/user', r.access_token) };
  switch (r.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'pending', interval: r.interval };
    case 'expired_token':
      return { status: 'failed', reason: 'expired', message: 'The code expired. Run `punch login` again.' };
    case 'access_denied':
      return { status: 'failed', reason: 'denied', message: 'Sign-in was cancelled on GitHub.' };
    case 'device_flow_disabled':
      return { status: 'failed', reason: 'disabled', message: 'Device sign-in is turned off for the Punchlist GitHub App.' };
    default:
      return { status: 'failed', reason: 'error', message: r.error_description ?? r.error ?? 'GitHub sign-in failed.' };
  }
}

// ---- Webhooks ----

/** Checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body) in constant time. */
export async function verifyWebhook(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(header ?? '')?.[1];
  if (!hex) return false;
  const sig = Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sig, body);
}
