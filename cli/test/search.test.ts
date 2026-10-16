import { describe, expect, it } from 'vitest';
import type { Item } from '../../shared/types';
import { searchItems, words } from '../search';

// `punch search`: Claude's near-duplicate check before adding an item (FR-21, S1).

const now = Date.parse('2026-10-16T12:00:00Z');
let n = 0;
const item = (title: string, extra: Partial<Item> = {}): Item => ({
  id: `PS-${String(++n).padStart(3, '0')}`, title, body: '', status: 'up_next', rank: 'a0', blocked: null, tags: [], depends_on: [], aliases: [],
  source: { kind: 'cli', actor: 'nick' }, created_at: '2026-10-01T00:00:00Z', created_by: 'nick', claim: null, citations: [], notes: [],
  body_version: 0, updated_at: '2026-10-01T00:00:00Z', ...extra,
});

describe('searchItems', () => {
  it('ranks by how many of the words an item shares, title first', () => {
    const items = [item('Retry failed uploads'), item('Rate-limit the invite endpoint'), item('Invite emails look broken', { body: 'rate limits too' })];
    const found = searchItems(items, 'add rate limiting on invites', now);
    expect(found.map(m => m.item.title)).toEqual(['Rate-limit the invite endpoint', 'Invite emails look broken']);
    expect(found[0]!.score).toBe(1);
  });

  it('finds recent Done items but not old ones or deleted ones', () => {
    const items = [
      item('Geo filter for the feed', { status: 'done', closed_at: '2026-10-10T00:00:00Z' }),
      item('Geo filter v0', { status: 'done', closed_at: '2026-08-01T00:00:00Z' }),
      item('Geo filter, deleted', { status: 'dropped' }),
    ];
    expect(searchItems(items, 'geo filter', now).map(m => m.item.title)).toEqual(['Geo filter for the feed']);
  });

  it('an ID finds that item', () => {
    const items = [item('one'), item('two')];
    expect(searchItems(items, items[1]!.id.toLowerCase(), now)[0]!.item.title).toBe('two');
  });

  it('ignores filler words', () => {
    expect([...words('Add the todo: fix uploads')]).toEqual(['upload']);
    expect(searchItems([item('Something else')], 'add to the todo list', now)).toEqual([]);
  });
});
