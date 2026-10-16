import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

// Where `punch` keeps its settings, its board cache and its token. PUNCH_HOME moves all of it, so a
// second shell can be a second person (and tests stay out of your real config).

export const DEFAULT_URL = 'https://punchlist.nnewberg.workers.dev';

export interface Config {
  url?: string;
  user?: string;
  machine?: string;
}

const custom = () => process.env.PUNCH_HOME;
export const configDir = () => custom() ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'punchlist');
export const cacheDir = () => (custom() ? join(custom()!, 'cache') : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'punchlist'));
const configFile = () => join(configDir(), 'config.json');

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, data: unknown, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
}

export const loadConfig = (): Config => readJson<Config>(configFile()) ?? {};
export const saveConfig = (c: Config) => writeJson(configFile(), c);

export const baseUrl = (flag?: string) => (flag ?? process.env.PUNCH_URL ?? loadConfig().url ?? DEFAULT_URL).replace(/\/+$/, '');
export const machine = () => hostname().replace(/\.local$/, '');

// ---- The API token: the OS keychain (FR-3), or a private file where there is none ----

const SERVICE = 'punchlist';
const account = (url: string) => (custom() ? `${url}#${custom()}` : url);
const tokenFile = (url: string) => join(configDir(), `token-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`);

type Keyring = typeof import('@napi-rs/keyring');
let keyring: Keyring | null | undefined;
async function loadKeyring(): Promise<Keyring | null> {
  if (keyring === undefined) {
    try {
      keyring = process.env.PUNCH_NO_KEYCHAIN ? null : await import('@napi-rs/keyring');
    } catch {
      keyring = null;
    }
  }
  return keyring;
}

export async function getToken(url: string): Promise<string | null> {
  const k = await loadKeyring();
  if (k) {
    try {
      const t = new k.Entry(SERVICE, account(url)).getPassword();
      if (t) return t;
    } catch {
      // fall through to the file
    }
  }
  return existsSync(tokenFile(url)) ? readFileSync(tokenFile(url), 'utf8').trim() || null : null;
}

/** Stores the token; returns where it went, so `login` can say so. */
export async function setToken(url: string, token: string): Promise<'keychain' | 'file'> {
  const k = await loadKeyring();
  if (k) {
    try {
      new k.Entry(SERVICE, account(url)).setPassword(token);
      rmSync(tokenFile(url), { force: true });
      return 'keychain';
    } catch {
      // no usable keychain (e.g. a headless Linux box): use the file
    }
  }
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(tokenFile(url), token, { mode: 0o600 });
  return 'file';
}

export async function deleteToken(url: string) {
  const k = await loadKeyring();
  if (k) {
    try {
      new k.Entry(SERVICE, account(url)).deletePassword();
    } catch {
      // nothing stored
    }
  }
  rmSync(tokenFile(url), { force: true });
}
