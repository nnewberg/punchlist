import type { BoardInfo } from '../shared/types';

// DEV STUB: `?as=<user>` picks who this tab is (see worker/identity.ts). Kept per tab in sessionStorage
// so two tabs in one browser can be two people.
function readDevUser(): string | null {
  try {
    const asked = new URLSearchParams(location.search).get('as');
    if (asked) sessionStorage.setItem('pl_as', asked);
    return sessionStorage.getItem('pl_as');
  } catch {
    return new URLSearchParams(location.search).get('as');
  }
}
export const devUser = readDevUser();

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`HTTP ${status}`);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (devUser) headers.set('X-Punch-Dev-User', devUser);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function wsUrl(path: string): string {
  const u = new URL(path, location.href);
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (devUser) u.searchParams.set('as', devUser);
  return u.toString();
}

export const boardPath = (b: Pick<BoardInfo, 'owner' | 'repo'>) => `/${b.owner}/${b.repo}`;
export const boardApi = (b: Pick<BoardInfo, 'owner' | 'repo'>) => `/v1/boards/${encodeURIComponent(b.owner)}/${encodeURIComponent(b.repo)}`;

import type { Me } from '../shared/types';
export type { Me };

let current: Me | null = null;
/** The signed-in account, set once by App from /v1/me. */
export const setAccount = (m: Me) => {
  current = m;
};
export const account = () => current;

// The board last on screen in this tab, and when the server was last told (PL-019).
let opened: { path: string; at: number } | null = null;
const OPENED_EVERY_MS = 60_000;

/** Where `/` goes: the board last on screen here, else the one this person opened most recently anywhere. */
export const homePath = () => opened?.path ?? (current?.boards[0] ? boardPath(current.boards[0]) : '/');

/** This board is on screen: remember it for `/`, and tell the server, at most once a minute per board. */
export function noteOpened(b: Pick<BoardInfo, 'owner' | 'repo'>) {
  const path = boardPath(b);
  if (opened?.path === path && Date.now() - opened.at < OPENED_EVERY_MS) return;
  opened = { path, at: Date.now() };
  api(`${boardApi(b)}/opened`, { method: 'POST' }).catch(() => {});
}

/** Whether this browser has signed in before (set by the server at sign-in; holds nothing secret). */
export const knownBrowser = () => document.cookie.split(';').some(c => c.trim() === 'pl_known=1');

export const signInUrl = (next = location.pathname + location.search) => `/auth/login?next=${encodeURIComponent(next)}`;

export async function signOut() {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/signin';
}
