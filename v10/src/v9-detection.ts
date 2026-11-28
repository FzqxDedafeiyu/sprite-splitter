import type { Rect } from './domain.ts';
import { invariant } from './project.ts';

export type DetectionOptions = {
  requested: 'auto' | 'alpha' | 'lightbg';
  alphaThreshold: number;
  bgThreshold: number;
  minArea: number;
  pad: number;
  conn: 4 | 8;
};
export type DetectedSprite = Rect & { mask: Uint8Array; componentId: number };
export const maxSourcePixels = 16 * 1024 ** 2;

export function detectV9Sprites(data: Uint8ClampedArray, w: number, h: number, options: DetectionOptions) {
  const n = w * h;
  invariant(Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 &&
    n <= maxSourcePixels && data.length === n * 4, '源图尺寸超过当前工作台的处理范围。');
  const { requested, alphaThreshold, bgThreshold, minArea, pad, conn } = options;
  invariant(['auto', 'alpha', 'lightbg'].includes(requested) && [4, 8].includes(conn) &&
    Number.isInteger(alphaThreshold) && alphaThreshold >= 0 && alphaThreshold <= 255 &&
    Number.isInteger(bgThreshold) && bgThreshold >= 0 && bgThreshold <= 255 &&
    Number.isSafeInteger(minArea) && minArea >= 1 && Number.isInteger(pad) && pad >= 0 && pad <= 32,
    '自动识别参数超出支持范围。');

  let transparent = false;
  if (requested === 'auto') {
    for (let k = 3; k < data.length; k += 4) {
      if (data[k] < 255) { transparent = true; break; }
    }
  }
  const mode = requested === 'auto' ? (transparent ? 'alpha' : 'lightbg') : requested;
  const active = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  if (mode === 'alpha') {
    for (let i = 0; i < n; i++) active[i] = data[i * 4 + 3] > alphaThreshold ? 1 : 0;
  } else {
    const candidate = new Uint8Array(n);
    const background = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      const max = Math.max(data[k], data[k + 1], data[k + 2]);
      const min = Math.min(data[k], data[k + 1], data[k + 2]);
      candidate[i] = max >= bgThreshold && max - min <= 24 ? 1 : 0;
    }
    let head = 0;
    let tail = 0;
    const pushBackground = (index: number) => {
      if (!background[index] && candidate[index]) { background[index] = 1; queue[tail++] = index; }
    };
    for (let x = 0; x < w; x++) { pushBackground(x); pushBackground((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { pushBackground(y * w); pushBackground(y * w + w - 1); }
    const edges = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    while (head < tail) {
      const index = queue[head++];
      const x = index % w;
      const y = Math.floor(index / w);
      for (const [dx, dy] of edges) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) pushBackground(ny * w + nx);
      }
    }
    for (let i = 0; i < n; i++) active[i] = background[i] ? 0 : 1;
  }

  const directions = conn === 8
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const sprites: DetectedSprite[] = [];
  let componentId = 0;
  let maskPixels = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const start = y * w + x;
    if (seen[start] || !active[start]) continue;
    let head = 0, tail = 0;
    let minX = x, maxX = x, minY = y, maxY = y;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const px = index % w, py = Math.floor(index / w);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      for (const [dx, dy] of directions) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const index = ny * w + nx;
        if (!seen[index] && active[index]) { seen[index] = 1; queue[tail++] = index; }
      }
    }
    componentId++;
    if (tail < minArea) continue;
    const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
    const width = Math.min(w, maxX + 1 + pad) - left, height = Math.min(h, maxY + 1 + pad) - top;
    maskPixels += width * height;
    invariant(sprites.length < 4096 && maskPixels <= 128 * 1024 ** 2,
      '识别结果过多。请调高最小区域面积或减小边距。');
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < tail; i++) {
      const px = queue[i] % w, py = Math.floor(queue[i] / w);
      mask[(py - top) * width + px - left] = 1;
    }
    sprites.push({ x: left, y: top, width, height, mask, componentId });
  }
  sprites.sort((left, right) => left.y - right.y || left.x - right.x);
  return { mode, sprites };
}
