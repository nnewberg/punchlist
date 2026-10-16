import type { Item, Op } from '../shared/types';
import { UsageError } from './args';

// `punch edit`: a new title or body for an item. A body edit carries the version it was based on, so
// a change someone made in between is refused instead of overwritten (FR-8), as on the web board.

export type EditOp = Extract<Op, { op: 'edit' }>;

export interface EditInput {
  title?: string;
  body?: string;
}

/** The edit op for `it`, or null when the input wouldn't change anything. */
export function editOp(it: Item, input: EditInput): EditOp | null {
  const title = input.title?.trim();
  if (input.title !== undefined && !title) throw new UsageError('A title can’t be empty.');
  const op: EditOp = { op: 'edit', id: it.id };
  if (title !== undefined && title !== it.title) op.title = title;
  if (input.body !== undefined && input.body !== it.body) {
    op.body = input.body;
    op.baseBodyVersion = it.body_version;
  }
  return op.title === undefined && op.body === undefined ? null : op;
}

/** Text read from a file for a body: the file's trailing newline isn't part of it. */
export const bodyFromFile = (text: string) => text.replace(/\s+$/, '');
