import { describe, expect, it } from 'vitest';
import type { Item } from '../../shared/types';
import { bodyArg, bodyFromFile, editOp } from '../edit';

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

// `punch add` and `punch edit` both read --body and --body-file this way (PL-017).
describe('bodyArg', () => {
  const files: Record<string, string> = { 'spec.md': '## Spec\n- one\n', '-': 'from stdin\n' };
  const read = (f: string) => files[f]!;

  it('reads --body-file, without its trailing newline', () => {
    expect(bodyArg(undefined, 'spec.md', read)).toBe('## Spec\n- one');
  });

  it('reads stdin for -', () => {
    expect(bodyArg(undefined, '-', read)).toBe('from stdin');
  });

  it('passes --body through, and is undefined with neither', () => {
    expect(bodyArg('inline', undefined, read)).toBe('inline');
    expect(bodyArg(undefined, undefined, read)).toBeUndefined();
  });

  it('refuses both', () => {
    expect(() => bodyArg('inline', 'spec.md', read)).toThrow('Use --body or --body-file, not both.');
  });
});
