import { describe, expect, it } from 'vitest';
import { parseStatus } from '../args';
import { parseBoardArg, parseRemote } from '../repo';

describe('finding the board from origin (FR-5)', () => {
  it.each([
    ['git@github.com:futureleisurefoundation/big-talk.git', 'futureleisurefoundation/big-talk'],
    ['https://github.com/nnewberg/bulletin-bee', 'nnewberg/bulletin-bee'],
    ['https://github.com/nnewberg/bulletin-bee.git', 'nnewberg/bulletin-bee'],
    ['ssh://git@github.com/nnewberg/punchlist.git', 'nnewberg/punchlist'],
    ['https://nick@github.com/nnewberg/punch.list.git/', 'nnewberg/punch.list'],
  ])('%s', (remote, expected) => {
    const b = parseRemote(remote);
    expect(b && `${b.owner}/${b.repo}`).toBe(expected);
  });

  it('ignores remotes that aren’t GitHub', () => {
    expect(parseRemote('git@gitlab.com:a/b.git')).toBeNull();
    expect(parseRemote('/some/local/path')).toBeNull();
  });

  it('takes owner/repo or a URL for --board', () => {
    expect(parseBoardArg('nnewberg/punchlist')).toEqual({ owner: 'nnewberg', repo: 'punchlist' });
    expect(parseBoardArg('https://github.com/nnewberg/punchlist')).toEqual({ owner: 'nnewberg', repo: 'punchlist' });
    expect(parseBoardArg('punchlist')).toBeNull();
  });
});

describe('statuses as people type them', () => {
  it.each([
    ['next', 'up_next'],
    ['Up Next', 'up_next'],
    ['up-next', 'up_next'],
    ['in progress', 'in_progress'],
    ['doing', 'in_progress'],
    ['done', 'done'],
    ['todo', 'backlog'],
  ])('%s', (word, status) => expect(parseStatus(word)).toBe(status));

  it('rejects unknown ones', () => expect(() => parseStatus('someday')).toThrow(/Unknown status/));
});
