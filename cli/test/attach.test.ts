import { describe, expect, it } from 'vitest';
import type { Item } from '../../shared/types';
import { attachOp, checkImageFile, imagePath } from '../attach';

// `punch attach` and `punch images` (PL-001).

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const item = { id: 'BT-014', title: 'Login breaks', body: 'Steps:\n1. log in\n', body_version: 4 } as Item;

describe('attachOp', () => {
  it('adds each image to the end of the description, against the version it read', () => {
    expect(attachOp(item, [{ path: '/tmp/login bug.png', id: A }, { path: 'after.jpg', id: B }])).toEqual({
      op: 'edit',
      id: 'BT-014',
      body: `Steps:\n1. log in\n\n![login bug](attachment:${A})\n\n![after](attachment:${B})`,
      baseBodyVersion: 4,
    });
  });

  it('doesn’t add an image the description already has', () => {
    const has = { ...item, body: `![x](attachment:${A})` };
    expect(attachOp(has, [{ path: 'x.png', id: A }])).toBeNull();
    expect(attachOp(has, [{ path: 'x.png', id: A }, { path: 'y.png', id: B }])?.body).toBe(`![x](attachment:${A})\n\n![y](attachment:${B})`);
  });
});

describe('checkImageFile', () => {
  it('takes images by their bytes and names the file it refuses', () => {
    expect(checkImageFile('shot.dat', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(() => checkImageFile('/x/logo.svg', new TextEncoder().encode('<svg/>'))).toThrow('logo.svg: Only PNG, JPEG, GIF and WebP');
    expect(() => checkImageFile('empty.png', new Uint8Array(0))).toThrow('empty.png: That file is empty.');
  });
});

it('saves images named for the item and their order', () => {
  expect(imagePath('/tmp/p', 'BT-014', 2, 'image/jpeg')).toBe('/tmp/p/BT-014-2.jpg');
});
