import { describe, expect, it } from 'vitest';
import { checkFlags } from '../args';

// Each command refuses the flags it doesn't read, rather than silently ignoring them (PL-017).

describe('checkFlags', () => {
  it('accepts a command’s own flags and the global ones', () => {
    expect(() => checkFlags('add', { body: 'x', status: 'next', tag: ['a'], deferred: true, json: true, board: 'o/r' })).not.toThrow();
    expect(() => checkFlags('add', { 'body-file': '-' })).not.toThrow();
    expect(() => checkFlags('edit', { title: 't', 'body-file': 'f.md' })).not.toThrow();
    expect(() => checkFlags('list', { compact: true, session: 's' })).not.toThrow();
    expect(() => checkFlags('hook', { url: 'http://localhost' })).not.toThrow();
  });

  it('refuses a flag the command doesn’t read', () => {
    expect(() => checkFlags('close', { 'body-file': 'f.md' })).toThrow("punch close doesn't take --body-file.");
    expect(() => checkFlags('add', { title: 'x' })).toThrow("punch add doesn't take --title.");
    expect(() => checkFlags('show', { steal: true })).toThrow("punch show doesn't take --steal.");
  });

  it('treats an alias like its command', () => {
    expect(() => checkFlags('done', { message: 'shipped' })).not.toThrow();
    expect(() => checkFlags('ls', { mine: true })).not.toThrow();
    expect(() => checkFlags('claim', { steal: true })).not.toThrow();
    expect(() => checkFlags('delete', { yes: true })).toThrow("punch delete doesn't take --yes.");
  });

  it('ignores flags that weren’t given, and leaves unknown commands alone', () => {
    expect(() => checkFlags('show', { title: undefined })).not.toThrow();
    expect(() => checkFlags('frobnicate', { title: 'x' })).not.toThrow();
  });
});
