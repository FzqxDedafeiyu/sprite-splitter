import type { Rect } from './domain.ts';
import { invariant } from './project.ts';

export const maskMimeType = 'application/vnd.sprite-splitter.mask-bitmap-v1';
const signature = 0x53534d31;

// SSM1: magic, little-endian u32 dimensions, then row-major u8 opacity.
export function encodeMask(width: number, height: number, samples: Uint8Array): Blob {
  invariant(Number.isSafeInteger(width) && width > 0 && width <= 0xffffffff &&
    Number.isSafeInteger(height) && height > 0 && height <= 0xffffffff &&
    width * height === samples.length, 'Invalid mask dimensions');
  const header = new ArrayBuffer(12);
  const view = new DataView(header);
  view.setUint32(0, signature);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  return new Blob([header, new Uint8Array(samples)], { type: maskMimeType });
}

export async function inspectRaster(bytes: Blob) {
  const head = new DataView(await bytes.slice(0, 24).arrayBuffer());
  if (bytes.type === maskMimeType) {
    invariant(head.byteLength >= 12 && head.getUint32(0) === signature, 'Invalid SSM1 mask header');
    const width = head.getUint32(4, true);
    const height = head.getUint32(8, true);
    invariant(width > 0 && height > 0 && width * height === bytes.size - 12, 'Invalid SSM1 mask length');
    return { kind: 'mask' as const, width, height };
  }
  if (head.byteLength === 24 && head.getUint32(0) === 0x89504e47 &&
    head.getUint32(4) === 0x0d0a1a0a && head.getUint32(8) === 13 && head.getUint32(12) === 0x49484452) {
    const image = await createImageBitmap(bytes);
    try { return { kind: 'png' as const, width: image.width, height: image.height }; }
    finally { image.close(); }
  }
  return undefined;
}

export async function decodeMask(bytes: Blob) {
  const raster = await inspectRaster(bytes);
  invariant(raster?.kind === 'mask', 'Expected an SSM1 mask');
  return { width: raster.width, height: raster.height, samples: new Uint8Array(await bytes.slice(12).arrayBuffer()) };
}

export function effectiveAlpha(alpha: Uint8Array, samples?: Uint8Array): Uint8Array {
  invariant(!samples || samples.length === alpha.length, 'Alpha and mask dimensions differ');
  return samples ? alpha.map((value, index) => Math.round(value * samples[index] / 255)) : alpha.slice();
}

// Both rectangles describe unscaled rasters in the same sourceLocal pixel space.
export function remapMask(samples: Uint8Array, previous: Rect, next: Rect): Uint8Array {
  for (const rect of [previous, next]) {
    invariant([rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) &&
      rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
      Number.isSafeInteger(rect.x + rect.width) && Number.isSafeInteger(rect.y + rect.height),
      'Mask remapping requires known source rectangles');
  }
  invariant(samples.length === previous.width * previous.height, 'Mask does not match previous source rectangle');
  const output = new Uint8Array(next.width * next.height).fill(255);
  const left = Math.max(previous.x, next.x);
  const right = Math.min(previous.x + previous.width, next.x + next.width);
  if (left >= right) return output;
  const top = Math.max(previous.y, next.y);
  const bottom = Math.min(previous.y + previous.height, next.y + next.height);
  for (let row = top; row < bottom; row++) {
    const inputOffset = (row - previous.y) * previous.width + left - previous.x;
    const outputOffset = (row - next.y) * next.width + left - next.x;
    output.set(samples.subarray(inputOffset, inputOffset + right - left), outputOffset);
  }
  return output;
}
