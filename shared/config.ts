import type { BoardInfo } from './types';

// Static stand-ins until GitHub sign-in and D1 land (FR-1–3): known people and the board directory.

export interface Person {
  key: string;
  name: string;
  initial: string;
  color: string;
}

export const PEOPLE: Record<string, Person> = {
  nick: { key: 'nick', name: 'Nick', initial: 'N', color: '#3d5a99' },
  aaron: { key: 'aaron', name: 'Aaron', initial: 'A', color: '#3a7a57' },
  kevin: { key: 'kevin', name: 'Kevin', initial: 'K', color: '#9a5a24' },
};

const FALLBACK_COLORS = ['#6b4e9e', '#8a4a5c', '#2f6f7a', '#7a6a2f'];

export function person(key: string | null | undefined): Person {
  if (!key) return { key: 'github', name: 'GitHub', initial: 'gh', color: 'transparent' };
  const known = PEOPLE[key];
  if (known) return known;
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return { key, name: key, initial: key[0]!.toUpperCase(), color: FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length]! };
}

export interface BoardConfig extends BoardInfo {
  members: string[];
}

export const BOARDS: BoardConfig[] = [
  { owner: 'futureleisurefoundation', repo: 'big-talk', prefix: 'BT', members: ['nick', 'aaron'] },
  { owner: 'nnewberg', repo: 'bulletin-bee', prefix: 'BB', members: ['nick', 'kevin'] },
  { owner: 'nnewberg', repo: 'punchlist', prefix: 'PL', members: ['nick'] },
];

export function findBoard(owner: string, repo: string): BoardConfig | undefined {
  return BOARDS.find(b => b.owner === owner && b.repo === repo);
}

export function boardsFor(user: string): BoardConfig[] {
  return BOARDS.filter(b => b.members.includes(user));
}
