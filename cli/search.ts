import { resolveId } from '../shared/ops';
import type { Item } from '../shared/types';

// `punch search` (FR-16, and FR-21's duplicate check): the items closest to some words, so Claude can
// tell whether "rate limit the invite endpoint" is already on the board before adding it. Simple word
// overlap; Claude judges whether a match is really the same work.

const STOP = new Set(
  'a an and are as at be but by do does for from has have in into is it its of on or our so that the their them then there these this to up was we were when which while with add todo todos list item items board fix make should would could need needs'.split(' '),
);

const DONE_WITHIN_MS = 30 * 86400_000;

/** Lowercased words, without stopwords, roughly stemmed so "limits", "limiting" and "limit" meet. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOP.has(raw) || (raw.length < 3 && !/\d/.test(raw))) continue;
    out.add(stem(raw));
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w.length > 3 && w.endsWith('e') ? w.slice(0, -1) : w;
}

export interface Match {
  item: Item;
  /** Share of the query's words found in the item, 0–1. */
  score: number;
}

export function searchItems(items: Iterable<Item>, query: string, now = Date.now(), limit = 5): Match[] {
  const all = [...items];
  const byId = resolveId(new Map(all.map(i => [i.id, i])), query.trim());
  const q = words(query);
  const out: Match[] = [];
  for (const it of all) {
    if (it.status === 'dropped') continue;
    if (it.status === 'done' && now - Date.parse(it.closed_at ?? it.updated_at) > DONE_WITHIN_MS) continue;
    if (it === byId) {
      out.push({ item: it, score: 1 });
      continue;
    }
    if (!q.size) continue;
    const title = words(it.title);
    const rest = words([it.body, ...it.notes.map(n => n.text), ...it.tags].join(' '));
    let hit = 0;
    for (const w of q) hit += title.has(w) ? 1 : rest.has(w) ? 0.5 : 0;
    if (hit) out.push({ item: it, score: Math.round((hit / q.size) * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score || (a.item.status === 'done' ? 1 : 0) - (b.item.status === 'done' ? 1 : 0)).slice(0, limit);
}
