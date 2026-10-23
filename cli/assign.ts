import type { Op } from '../shared/types';
import { UsageError } from './args';

// `punch assign`: give an item to someone who can edit the board, with the same claim op the web
// board's Assignee menu sends. The server checks who that can be. Unassigning is `punch release`.

export type ClaimOp = Extract<Op, { op: 'claim' }>;

/** A GitHub login as typed: `@Aaron-T` is `aaron-t`. */
export function parseLogin(word: string): string {
  const login = word.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(login)) throw new UsageError(`"${word}" isn’t a GitHub login. Name the person by their login, for example: punch assign BT-014 aaron-t`);
  return login;
}

export function assignOp(id: string, who: string, steal = false): ClaimOp {
  return { op: 'claim', id, user: parseLogin(who), ...(steal ? { steal: true } : {}) };
}
