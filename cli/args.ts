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
