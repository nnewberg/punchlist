import type { PersonInfo } from './types';

// How to show a person, by login. The web app registers everyone on the signed-in user's boards (names
// and GitHub avatars from /v1/me); anyone else falls back to their login and a colored initial.

export interface Person {
  key: string;
  name: string;
  initial: string;
  color: string;
  avatar: string | null;
}

/** The dev identity stub's people (DEV_MODE), with fixed colors so the sample boards look like the design. */
export const DEV_PEOPLE: Record<string, { name: string; color: string }> = {
  nick: { name: 'Nick', color: '#3d5a99' },
  aaron: { name: 'Aaron', color: '#3a7a57' },
  kevin: { name: 'Kevin', color: '#9a5a24' },
};

const FALLBACK_COLORS = ['#3d5a99', '#3a7a57', '#9a5a24', '#6b4e9e', '#8a4a5c', '#2f6f7a', '#7a6a2f'];

const registry = new Map<string, PersonInfo>();
let devPeople = false;

/** Replaces the known people. `dev` uses the stub's names and colors instead of GitHub avatars. */
export function setPeople(people: Record<string, PersonInfo>, dev = false) {
  registry.clear();
  for (const [login, p] of Object.entries(people)) registry.set(login.toLowerCase(), p);
  devPeople = dev;
}

export function person(key: string | null | undefined): Person {
  if (!key) return { key: 'github', name: 'GitHub', initial: 'gh', color: 'transparent', avatar: null };
  const login = key.toLowerCase();
  const known = registry.get(login);
  const stub = devPeople || !known ? DEV_PEOPLE[login] : undefined;
  const name = known?.name || stub?.name || key;
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) | 0;
  return {
    key: login,
    name,
    initial: name[0]!.toUpperCase(),
    color: stub?.color ?? FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length]!,
    avatar: devPeople ? null : (known?.avatar ?? null),
  };
}
