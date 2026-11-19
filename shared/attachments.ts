// Image attachments (PL-001). An image is uploaded to its board, which keeps it, and the item's
// description points at it in Markdown as `![alt](attachment:<id>)`. The reference names no board
// or repo, so it survives a rename; each client turns it into its board's file URL.

/** Image types a board keeps, by what their bytes say they are. No SVG: it can carry script. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_LABEL = '10 MB';

export const ATTACHMENT_SCHEME = 'attachment:';

/** An attachment's id: the first 128 bits of its SHA-256, in hex, so the same image uploaded twice is kept once. */
export const ATTACHMENT_ID = /^[0-9a-f]{32}$/;

/** What an upload returns. */
export interface Attachment {
  id: string;
  type: ImageType;
  size: number;
}

/** The image type the bytes start with, or null if they're none of IMAGE_TYPES. */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61))) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Why a board won't keep these bytes as an image, or null if it will. */
export function refuseImage(b: Uint8Array): string | null {
  if (!b.length) return 'That file is empty.';
  if (b.length > MAX_IMAGE_BYTES) return `Images can be up to ${MAX_IMAGE_LABEL}; that one is ${(b.length / 1024 / 1024).toFixed(1)} MB.`;
  if (!sniffImage(b)) return 'Only PNG, JPEG, GIF and WebP images can be attached.';
  return null;
}

export async function attachmentId(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return [...hash.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Alt text from a file name: `login-bug.png` → `login-bug`. Brackets would end the Markdown alt text early. */
export const altFor = (name: string) => name.replace(/\.[^./\\]+$/, '').replace(/[[\]\\]/g, '').trim() || 'image';

export const imageMarkdown = (alt: string, id: string) => `![${alt.replace(/[[\]\\]/g, '')}](${ATTACHMENT_SCHEME}${id})`;

/** The attachment ids a description points at, in order, each once. */
export function attachmentIds(text: string): string[] {
  const ids = [...text.matchAll(/\]\(\s*<?attachment:([0-9a-f]{32})>?/g)].map(m => m[1]!);
  return [...new Set(ids)];
}

/** The id in an `attachment:` URL, or null for any other URL. */
export function attachmentOf(url: string): string | null {
  if (!url.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = url.slice(ATTACHMENT_SCHEME.length);
  return ATTACHMENT_ID.test(id) ? id : null;
}

/** `text` with the image's Markdown on its own paragraph at the end. */
export const appendImage = (text: string, markdown: string) => (text.trim() ? `${text.replace(/\s+$/, '')}\n\n${markdown}` : markdown);

/** The file extension for an image type, for saving one. */
export const extFor = (type: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[type] ?? 'bin';
