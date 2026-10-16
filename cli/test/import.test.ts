import { describe, expect, it } from 'vitest';
import { checkImport } from '../../shared/import';
import type { ImportItem, Item } from '../../shared/types';
import { formatImportPlan } from '../format';

// `punch import`'s dry run (PRD §7.9): what would land where, and why it can't be imported.

const existing = new Map<string, Item>([
  ['BT-002', { id: 'BT-002', aliases: ['feedback-3'] } as Item],
]);

describe('checkImport', () => {
  it('keeps IDs and finds the highest number', () => {
    const plan = checkImport('BT', existing, [
      { id: 'BT-010', title: 'a', status: 'backlog' },
      { title: 'b', status: 'up_next' },
    ]);
    expect(plan).toEqual({ errors: [], ids: ['BT-010', null], maxNum: 10 });
  });

  it('refuses clashes, bad IDs, bad statuses and unknown dependencies', () => {
    const items = [
      { id: 'BT-002', title: 'clash', status: 'backlog' },
      { id: 'BT-007a', title: 'odd id', status: 'backlog' },
      { id: 'BB-001', title: 'other prefix', status: 'backlog' },
      { id: 'BT-011', title: 'x', status: 'started' },
      { id: 'BT-012', title: 'y', status: 'backlog', aliases: ['Feedback-3'] },
      { id: 'BT-013', title: 'z', status: 'backlog', depends_on: ['BT-099'] },
      { id: 'BT-014', title: '', status: 'backlog' },
    ] as ImportItem[];
    const { errors } = checkImport('BT', existing, items);
    expect(errors).toEqual([
      'Item 1 (BT-002): BT-002 is already on the board or in this file.',
      'Item 2 (BT-007a): an ID here looks like BT-001; anything else can be an alias.',
      'Item 3 (BB-001): an ID here looks like BT-001; anything else can be an alias.',
      'Item 4 (BT-011): status must be one of backlog, up_next, in_progress, done, dropped.',
      'Item 5 (BT-012): Feedback-3 is already taken by BT-002.',
      'Item 7 (BT-014): needs a title.',
      "Item 6 (BT-013): depends on BT-099, which isn't on the board or in this file.",
    ]);
  });
});

describe('formatImportPlan', () => {
  it('groups by column, with aliases and why', () => {
    const items: ImportItem[] = [
      { id: 'BT-001', title: 'Glanceable openers', status: 'done', why: 'merged in 44f9d9c' },
      { id: 'BT-036', title: 'Continue the quiz', status: 'up_next', aliases: ['BT-007a'] },
      { title: 'Node 20 Action', status: 'backlog' },
    ];
    expect(formatImportPlan(items, ['BT-001', 'BT-036', null], 'o/r').split('\n')).toEqual([
      'Import into o/r: 3 items',
      '',
      'Up Next 1',
      '  BT-036   Continue the quiz (also BT-007a)',
      '',
      'Backlog 1',
      '  new      Node 20 Action',
      '',
      'Done 1',
      '  BT-001   Glanceable openers',
      '           merged in 44f9d9c',
    ]);
  });
});
