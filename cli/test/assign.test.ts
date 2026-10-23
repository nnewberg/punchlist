import { describe, expect, it } from 'vitest';
import type { Item } from '../../shared/types';
import { assignedElse, assignOp, parseLogin } from '../assign';

// `punch assign` (PL-006): the claim op the web board sends, naming whoever it's for.

describe('assignOp', () => {
  it('names the person by login, in any case and with or without @', () => {
    expect(assignOp('BT-014', '@Aaron-T')).toEqual({ op: 'claim', id: 'BT-014', user: 'aaron-t' });
    expect(parseLogin(' kevin ')).toBe('kevin');
  });

  it('takes it from someone else only with --steal (FR-27)', () => {
    expect(assignOp('BT-014', 'aaron', true)).toEqual({ op: 'claim', id: 'BT-014', user: 'aaron', steal: true });
  });

  it('refuses something that is not a login', () => {
    expect(() => parseLogin('Aaron Smith')).toThrow('isn’t a GitHub login');
    expect(() => parseLogin('@')).toThrow('isn’t a GitHub login');
  });
});

describe('assignedElse', () => {
  const held = (user: string | null) => ({ id: 'BT-014', claim: user ? { user, kind: 'manual', since: '' } : null }) as Item;

  it('is fine when the item went to the person asked for', () => {
    expect(assignedElse(held('aaron'), 'aaron')).toBeNull();
  });

  it('catches an older server claiming it for you instead, and says how to undo it', () => {
    expect(assignedElse(held('nick'), 'aaron')).toBe('BT-014 wasn’t assigned to aaron: the server claimed it for nick, so it doesn’t know `punch assign` yet. Run `punch release BT-014` to undo that.');
    expect(assignedElse(held(null), 'aaron')).toMatch(/left it unassigned/);
  });
});
