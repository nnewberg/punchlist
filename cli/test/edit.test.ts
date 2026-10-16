import { describe, expect, it } from 'vitest';
import type { Item } from '../../shared/types';
import { bodyFromFile, editOp } from '../edit';

// `punch edit` (FR-8, FR-17): only what changes is sent, and a body edit names the version it replaces.

const item = { id: 'BT-014', title: 'Rate-limit invites', body: 'old text', body_version: 3 } as Item;

describe('editOp', () => {
  it('sends a new title alone, with no body version', () => {
    expect(editOp(item, { title: '  Rate-limit the invite endpoint ' })).toEqual({ op: 'edit', id: 'BT-014', title: 'Rate-limit the invite endpoint' });
  });

  it('sends a body with the version it was based on', () => {
    expect(editOp(item, { body: 'new text' })).toEqual({ op: 'edit', id: 'BT-014', body: 'new text', baseBodyVersion: 3 });
  });

  it('leaves out the parts that are unchanged', () => {
    expect(editOp(item, { title: 'Rate-limit invites', body: 'new text' })).toEqual({ op: 'edit', id: 'BT-014', body: 'new text', baseBodyVersion: 3 });
    expect(editOp(item, { title: 'Rate-limit invites', body: 'old text' })).toBeNull();
  });

  it('can clear the body, but not the title', () => {
    expect(editOp(item, { body: '' })).toMatchObject({ body: '' });
    expect(() => editOp(item, { title: '  ' })).toThrow('A title can’t be empty.');
  });
});

describe('bodyFromFile', () => {
  it('drops the trailing newline and keeps the rest', () => {
    expect(bodyFromFile('## Spec\n\n- one\n- two\n\n')).toBe('## Spec\n\n- one\n- two');
  });
});
