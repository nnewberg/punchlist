import { describe, expect, it } from 'vitest';
import { branchRefs, parseMessage, revertedPr } from '../shared/github';

// What commit messages, PR descriptions and branch names say about a board's items (FR-26, FR-30, FR-33).

describe('parseMessage', () => {
  const p = (text: string) => parseMessage(text, 'BT');

  it('reads closing keywords in a trailer, the subject or the body', () => {
    expect(p('Rate-limit invites\n\nCloses: BT-014, BT-017').closes).toEqual(['BT-014', 'BT-017']);
    expect(p('Fix BT-9: retry uploads').closes).toEqual(['BT-9']);
    expect(p('retry uploads\n\nThis resolves bt-9 and BT-10').closes).toEqual(['BT-9', 'BT-10']);
    expect(p('Fixed BT014 & BT-15').closes).toEqual(['BT-014', 'BT-15']);
  });

  it('takes any ID after a keyword, so aliases resolve on the board', () => {
    expect(p('Closes feedback-26').closes).toEqual(['FEEDBACK-26']);
  });

  it('does not read ordinary words after a keyword as IDs', () => {
    expect(p('Fix the BT-9 retry path').closes).toEqual([]);
    expect(p('Fixes typo').closes).toEqual([]);
  });

  it('Refs and Part of are partial progress, never closes', () => {
    const r = p('Server half of the feed\n\nRefs: BT-11\nPart of BT-12');
    expect(r.closes).toEqual([]);
    expect(r.refs).toEqual(['BT-11', 'BT-12']);
  });

  it('a bare mention needs the board prefix and a hyphen', () => {
    const r = p('Follow-up to BT-21; uses sha-256 and BT22, see feedback-3');
    expect(r.mentions).toEqual(['BT-21']);
    expect(p('Fix the BT-9 retry path').mentions).toEqual(['BT-9']);
  });

  it('an ID that is closed is not also a mention', () => {
    expect(p('Closes: BT-14 (follow-up to BT-14 spec)').mentions).toEqual([]);
  });

  it('a revert names the commit it undoes and closes nothing, though it quotes the old subject', () => {
    const r = p('Revert "Fix BT-9: retry uploads"\n\nThis reverts commit 4772d30a1b2c3d4e5f60718293a4b5c6d7e8f901.');
    expect(r).toEqual({ closes: [], refs: [], mentions: [], reverts: ['4772d30a1b2c3d4e5f60718293a4b5c6d7e8f901'] });
    expect(p('Revert "Fix BT-9: retry uploads" (#42)').closes).toEqual([]);
  });
});

describe('revertedPr', () => {
  it("reads GitHub's Revert button body", () => {
    expect(revertedPr('Reverts nnewberg/punchlist-sandbox#41')).toBe(41);
    expect(revertedPr('Some text\nReverts #7\n')).toBe(7);
    expect(revertedPr('This reverts a lot of things in #41')).toBeNull();
  });
});

describe('branchRefs', () => {
  it('finds the items a branch is named for', () => {
    expect(branchRefs('bt-014-rate-limit', 'BT')).toEqual(['BT-014']);
    expect(branchRefs('nick/BT-14', 'BT')).toEqual(['BT-14']);
    expect(branchRefs('bt14-and-bt-15', 'BT')).toEqual(['BT-14', 'BT-15']);
  });

  it('ignores other prefixes and words that only start like one', () => {
    expect(branchRefs('bb-031-geo-filter', 'BT')).toEqual([]);
    expect(branchRefs('abt-3-thing', 'BT')).toEqual([]);
    expect(branchRefs('main', 'BT')).toEqual([]);
  });
});
