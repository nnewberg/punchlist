import type { Item } from './types';

export const DONE_WINDOW_DAYS = 14;

/** "now", "2m", "3h", "4d", "6w" — the compact ages the design uses. */
export function age(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 7))}w`;
}

export function isRecentDone(it: Item, now = Date.now()): boolean {
  return it.status === 'done' && !!it.closed_at && now - Date.parse(it.closed_at) <= DONE_WINDOW_DAYS * 86400_000;
}

/** Dependencies that are not finished yet (FR-13 highlights these). */
export function openDeps(it: Item, items: ReadonlyMap<string, Item>): Item[] {
  return it.depends_on.map(id => items.get(id)).filter((d): d is Item => !!d && d.status !== 'done' && d.status !== 'dropped');
}

export function latestNote(it: Item): string | undefined {
  return it.notes.length ? it.notes[it.notes.length - 1]!.text : undefined;
}

export function matchesQuery(it: Item, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [it.id, it.title, it.body, ...it.tags, ...it.aliases, ...it.notes.map(n => n.text), it.claim?.ref ?? '']
    .some(s => s.toLowerCase().includes(needle));
}
