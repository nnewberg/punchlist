import { basename, join } from 'node:path';
import { altFor, appendImage, attachmentIds, extFor, imageMarkdown, refuseImage, sniffImage } from '../shared/attachments';
import type { Item } from '../shared/types';
import { UsageError } from './args';
import type { EditOp } from './edit';

// `punch attach` and `punch images` (PL-001): images go up to the board and into the item's
// description as Markdown; `images` brings them back down as files, which is how an agent sees them.

/** Checks a file is an image the board keeps, before anything is uploaded. Returns its type. */
export function checkImageFile(path: string, bytes: Uint8Array): string {
  const refused = refuseImage(bytes);
  if (refused) throw new UsageError(`${basename(path)}: ${refused}`);
  return sniffImage(bytes)!;
}

/** The edit that puts the uploaded images at the end of the item's description, each on its own line. */
export function attachOp(it: Item, uploads: { path: string; id: string }[]): EditOp | null {
  const have = new Set(attachmentIds(it.body));
  const fresh = uploads.filter(u => !have.has(u.id));
  if (!fresh.length) return null;
  const body = fresh.reduce((text, u) => appendImage(text, imageMarkdown(altFor(basename(u.path)), u.id)), it.body);
  return { op: 'edit', id: it.id, body, baseBodyVersion: it.body_version };
}

/** Where `punch images` saves an item's attachment: named for the item and its place in the description. */
export const imagePath = (dir: string, itemId: string, n: number, type: string) => join(dir, `${itemId}-${n}.${extFor(type)}`);
