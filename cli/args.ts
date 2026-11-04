import type { Status } from '../shared/types';

/** A mistake in how punch was called: printed with a hint, exit code 2. */
export class UsageError extends Error {}

const STATUS_WORDS: Record<string, Status> = {
  backlog: 'backlog',
  todo: 'backlog',
  up_next: 'up_next',
  upnext: 'up_next',
  next: 'up_next',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  progress: 'in_progress',
  doing: 'in_progress',
  wip: 'in_progress',
  done: 'done',
  closed: 'done',
  dropped: 'dropped',
  deleted: 'dropped',
};

/** `next`, `up-next`, `Up Next` and `up_next` all mean Up Next. */
export function parseStatus(word: string): Status {
  const w = word.toLowerCase();
  const s = STATUS_WORDS[w.replace(/[\s-]+/g, '_')] ?? STATUS_WORDS[w.replace(/[\s_-]+/g, '')];
  if (!s) throw new UsageError(`Unknown status "${word}". Use backlog, next, progress or done.`);
  return s;
}

// Every flag is declared once, in main.ts's parseArgs, so each command would accept them all and
// silently ignore the ones it doesn't read: `punch add --body-file` once dropped a description that
// way (PL-017). Each command lists what it reads, and anything else is a usage error.

/** Flags every command takes. */
const GLOBAL_FLAGS = ['json', 'board', 'url', 'session', 'help', 'version'];

/** The flags each command reads, beyond the global ones. A new flag in main.ts goes here too. */
export const COMMAND_FLAGS: Record<string, string[]> = {
  list: ['compact', 'status', 'mine', 'all'],
  show: [],
  add: ['body', 'body-file', 'status', 'tag', 'deferred'],
  edit: ['title', 'body', 'body-file'],
  search: [],
  move: ['top', 'before'],
  start: ['steal'],
  assign: ['steal'],
  release: [],
  block: [],
  unblock: [],
  close: ['message'],
  reopen: [],
  note: ['message'],
  drop: [],
  mine: [],
  open: [],
  export: ['out'],
  import: ['yes'],
  init: ['yes'],
  login: ['dev', 'start', 'finish'],
  logout: [],
  whoami: [],
  hook: [],
};

const ALIASES: Record<string, string> = { ls: 'list', find: 'search', claim: 'start', done: 'close', delete: 'drop' };

/** Throws if `cmd` was given a flag it doesn't read. Unknown commands are left to the caller. */
export function checkFlags(cmd: string, values: Record<string, unknown>) {
  const own = COMMAND_FLAGS[ALIASES[cmd] ?? cmd];
  if (!own) return;
  for (const [flag, value] of Object.entries(values)) {
    if (value === undefined || GLOBAL_FLAGS.includes(flag) || own.includes(flag)) continue;
    throw new UsageError(`punch ${cmd} doesn't take --${flag}. Run \`punch --help\`.`);
  }
}
