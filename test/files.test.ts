import { describe, expect, it } from 'vitest';
import { altFor, appendImage, attachmentIds, attachmentOf, imageMarkdown, MAX_IMAGE_BYTES, sniffImage } from '../shared/attachments';
import { call, gh, ORIGIN, seedBoards, signedIn, useProdWorker } from './harness';

// Image attachments (PL-001): uploaded to the board, served back to whoever can see it.

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes that start like a PNG, `size` long, different for each `seed`. */
function png(size: number, seed = 1) {
  const b = new Uint8Array(size);
  b.set(PNG_HEAD);
  for (let i = PNG_HEAD.length; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

const BEE = '/v1/boards/nnewberg/bulletin-bee';
const TALK = '/v1/boards/futureleisurefoundation/big-talk';

describe('attached images (PL-001)', () => {
  useProdWorker();

  async function editor() {
    await seedBoards();
    const cookie = await signedIn();
    gh.perms = { 'big-talk:aaron-t': 'read', 'bulletin-bee:aaron-t': 'write' };
    return cookie;
  }
  const upload = (path: string, body: Uint8Array, cookie: string, origin = ORIGIN) =>
    call(`${path}/files`, { method: 'POST', body, cookie, headers: { origin, 'content-type': 'image/png' } });

  it('keeps an image someone who can edit uploads, and serves it back as an image', async () => {
    const cookie = await editor();
    const bytes = png(5000);
    const res = await upload(BEE, bytes, cookie);
    expect(res.status).toBe(200);
    const att = (await res.json()) as { id: string; type: string; size: number };
    expect(att).toMatchObject({ type: 'image/png', size: 5000 });
    expect(att.id).toMatch(/^[0-9a-f]{32}$/);

    const got = await call(`${BEE}/files/${att.id}`, { cookie });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    // The same image again is the same attachment.
    expect(((await (await upload(BEE, bytes, cookie)).json()) as { id: string }).id).toBe(att.id);
    // A browser that has it already is told so.
    expect((await call(`${BEE}/files/${att.id}`, { cookie, headers: { 'if-none-match': `"${att.id}"` } })).status).toBe(304);
  });

  it('keeps an image bigger than a storage row whole', async () => {
    const cookie = await editor();
    const bytes = png(Math.floor(2.5 * 1024 * 1024), 7);
    const att = (await (await upload(BEE, bytes, cookie)).json()) as { id: string };
    const got = await call(`${BEE}/files/${att.id}`, { cookie });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it('refuses what isn’t an image, or is too big', async () => {
    const cookie = await editor();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const notImage = await upload(BEE, svg, cookie);
    expect(notImage.status).toBe(415);
    expect(((await notImage.json()) as { error: { message: string } }).error.message).toMatch(/PNG, JPEG, GIF and WebP/);
    expect((await upload(BEE, new Uint8Array(0), cookie)).status).toBe(415);
    expect((await upload(BEE, png(MAX_IMAGE_BYTES + 1), cookie)).status).toBe(413);
  });

  it('only someone who can edit the board can upload, and only from Punchlist itself', async () => {
    const cookie = await editor();
    expect((await upload(TALK, png(100), cookie)).status).toBe(403);
    expect((await upload(BEE, png(100), cookie, 'https://evil.example')).status).toBe(403);
    expect((await call(`${BEE}/files`, { method: 'POST', body: png(100), headers: { origin: ORIGIN } })).status).toBe(401);
  });

  it('serves an image only from its own board, to people who can see that board', async () => {
    const cookie = await editor();
    const { id } = (await (await upload(BEE, png(100, 3), cookie)).json()) as { id: string };
    expect((await call(`${BEE}/files/${id}`)).status).toBe(401);
    expect((await call(`${TALK}/files/${id}`, { cookie })).status).toBe(404);
    const outsider = await signedIn('kevin-r', 10);
    expect((await call(`${BEE}/files/${id}`, { cookie: outsider })).status).toBe(404);
    expect((await call(`${BEE}/files/not-an-id`, { cookie })).status).toBe(404);
  });
});

describe('attachment Markdown', () => {
  it('knows images by their bytes, not their names', () => {
    expect(sniffImage(png(20))).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg'))).toBeNull();
  });

  it('writes and finds references to attachments', () => {
    const id = 'a'.repeat(32);
    const md = imageMarkdown(altFor('login [bug].png'), id);
    expect(md).toBe(`![login bug](attachment:${id})`);
    expect(attachmentOf(`attachment:${id}`)).toBe(id);
    expect(attachmentOf('https://example.com/x.png')).toBeNull();
    expect(attachmentOf('attachment:../../me')).toBeNull();
    const body = appendImage('Steps:\n1. log in\n', md);
    expect(body).toBe(`Steps:\n1. log in\n\n${md}`);
    expect(attachmentIds(`${body}\n![again](attachment:${id}) ![b](attachment:${'b'.repeat(32)})`)).toEqual([id, 'b'.repeat(32)]);
    expect(appendImage('', md)).toBe(md);
  });
});
