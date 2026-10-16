// What a commit message, PR description or branch name says about a board's items (PRD FR-26, FR-30,
// FR-33). Pure, so the Worker can tell which commits are worth a GitHub lookup and the board's Durable
// Object can decide what they do. Item refs are returned as written; the board resolves them (aliases
// included) and ignores any that aren't its own.

export interface MessageRefs {
  /** `Closes|Fixes|Resolves <ids>`, anywhere in the message: subject, body or trailer. */
  closes: string[];
  /** `Refs <ids>` or `Part of <ids>`: partial progress, so a note and never a close. */
  refs: string[];
  /** Other mentions of this board's IDs (`BT-014`), which add a note. */
  mentions: string[];
  /** SHAs (possibly abbreviated) named by `This reverts commit <sha>`. */
  reverts: string[];
}

// An item ref as people write one in a list: BT-014, bt-14, BT014, or an alias such as feedback-26.
const REF = String.raw`[A-Za-z][A-Za-z0-9]*-?\d+[a-z]?\b`;
const LIST = String.raw`(${REF}(?:\s*(?:,|&|\band\b)?\s*${REF})*)`;
const CLOSES = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+${LIST}`, 'gi');
const REFS = new RegExp(String.raw`\b(?:refs?|references?|part\s+of)\b:?\s+${LIST}`, 'gi');
const REVERTS = /\bThis reverts commit ([0-9a-f]{7,40})\b/gi;
const TOKEN = new RegExp(REF, 'g');

const uniq = (xs: string[]) => [...new Set(xs)];
const listed = (text: string, re: RegExp) => uniq([...text.matchAll(re)].flatMap(m => m[1]!.match(TOKEN) ?? []).map(canonical));

/** `bt-14` → `BT-14`, so the same ref written two ways counts once. Leading zeros are left to the board. */
export function canonical(ref: string): string {
  const m = /^([A-Za-z][A-Za-z0-9]*?)-?(\d+)([a-z]?)$/.exec(ref);
  return m ? `${m[1]!.toUpperCase()}-${m[2]}${m[3]}` : ref;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** This board's IDs as written in running text: the prefix, a hyphen, a number (`BT-014`). */
const mentionRe = (prefix: string) => new RegExp(String.raw`(?<![A-Za-z0-9-])${escape(prefix)}-\d+[a-z]?(?![A-Za-z0-9])`, 'gi');

export function parseMessage(text: string, prefix: string): MessageRefs {
  const reverts = uniq([...text.matchAll(REVERTS)].map(m => m[1]!.toLowerCase()));
  // A revert quotes the subject it undoes (`Revert "Fix BT-014"`); that's not a fix of BT-014.
  if (reverts.length || /^Revert "/.test(text.trimStart())) return { closes: [], refs: [], mentions: [], reverts };
  const closes = listed(text, CLOSES);
  const refs = listed(text, REFS).filter(r => !closes.includes(r));
  const taken = new Set([...closes, ...refs]);
  const mentions = uniq((text.match(mentionRe(prefix)) ?? []).map(canonical)).filter(r => !taken.has(r));
  return { closes, refs, mentions, reverts };
}

export const citesAnything = (r: MessageRefs) => r.closes.length + r.refs.length + r.mentions.length + r.reverts.length > 0;

/** The PR a revert PR undoes: GitHub's Revert button writes `Reverts owner/repo#41`. */
export function revertedPr(body: string): number | null {
  const m = /^Reverts\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\s*$/im.exec(body);
  return m ? Number(m[1]) : null;
}

/** Items a branch is named for: `bt-014-rate-limit`, `nick/BT-14`, `bt14-fix` (FR-26). */
export function branchRefs(branch: string, prefix: string): string[] {
  const re = new RegExp(String.raw`(?<![A-Za-z0-9])${escape(prefix)}-?(\d+)(?![0-9])`, 'gi');
  return uniq([...branch.matchAll(re)].map(m => `${prefix.toUpperCase()}-${m[1]}`));
}

/** The first line, for notes and citations. */
export const subject = (message: string) => message.split('\n', 1)[0]!.trim().slice(0, 200);
export const shortSha = (sha: string | undefined) => (sha ? sha.slice(0, 7) : '');

/** Where a commit or PR lives on GitHub, for links on cards and in the sheet. */
export const githubUrl = (board: { owner: string; repo: string }, ref: { commit?: string; pr?: number }) =>
  `https://github.com/${board.owner}/${board.repo}/${ref.pr ? `pull/${ref.pr}` : `commit/${ref.commit}`}`;
