import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { detectV9Sprites } from '../src/v9-detection.ts';

const v9 = readFileSync(new URL('../../精灵图切分编辑器_V9_分组批量属性与中文导出版.html', import.meta.url), 'utf8');
const baseline = v9.slice(v9.indexOf('function autoDetect()'), v9.indexOf('function addDownload('));
const defaults = { minArea: 1, pad: 1, conn: 4, requested: 'auto', alphaThreshold: 16, bgThreshold: 220 };
const pixels = (rows, palette) => Uint8ClampedArray.from(Array.from(rows.join(''), key => palette[key]).flat());
const alpha = pixels(['a..', '.b.', '..a'], { a: [0, 0, 0, 255], b: [0, 0, 0, 17], '.': [0, 0, 0, 0] });
const light = pixels(['.....', '.aaa.', '.a.a.', '.aaa.', '.....'],
  { a: [0, 0, 0, 255], '.': [245, 245, 245, 255] });

function original(data, width, height, options) {
  const values = { area: options.minArea, pad: options.pad, conn: options.conn,
    detectMode: options.requested, alpha: options.alphaThreshold, bgThreshold: options.bgThreshold };
  return runInNewContext(baseline + '\nautoDetect(); sprites;', {
    img: { naturalWidth: width, naturalHeight: height },
    document: { createElement: () => ({ getContext: () => ({
      drawImage() {}, getImageData: () => ({ data })
    }) }) },
    $: id => ({ value: values[id] }),
    select() {}, say() {}
  });
}

const normalize = sprites => Array.from(sprites, item => ({
  x: item.x, y: item.y, width: item.width ?? item.w, height: item.height ?? item.h,
  mask: Array.from(item.mask), componentId: item.componentId
}));
for (const [label, data, size, changes, count] of [
  ['Alpha / 4 邻域', alpha, 3, {}, 3],
  ['Alpha / 8 邻域', alpha, 3, { conn: 8 }, 1],
  ['Alpha / 最小面积与阈值', alpha, 3, { minArea: 2, alphaThreshold: 17 }, 0],
  ['浅色背景 / 边缘泛洪与封闭高光', light, 5, { pad: 0 }, 1],
  ['强制 Alpha 模式 / 不以浅色像素为背景', light, 5, { requested: 'alpha' }, 1]
]) {
  test(label, () => {
    const options = { ...defaults, ...changes };
    const result = detectV9Sprites(data, size, size, options);
    assert.equal(result.sprites.length, count);
    assert.equal(result.mode, data === light && !changes.requested ? 'lightbg' : 'alpha');
    assert.deepEqual(normalize(result.sprites), normalize(original(data, size, size, options)));
  });
}
