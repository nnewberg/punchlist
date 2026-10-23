import { describe, expect, it } from 'vitest';
import { assignOp, parseLogin } from '../assign';

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
