import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { toDevice, toSource, toSprite } from './src/geometry.ts';

const v9Path = process.env.V9_HTML ?? new URL('../../../../../精灵图切分编辑器_V9_分组批量属性与中文导出版.html', import.meta.url);
const v9 = readFileSync(v9Path, 'utf8');
const baseline = v9.slice(v9.indexOf('function autoDetect()'), v9.indexOf('function addDownload('));
const body = baseline.slice(baseline.indexOf(' let alphaHasTransparency'), baseline.indexOf(';select(sprites.length'));
const detect = new Function('d', 'w', 'h', 'options', `
  const n = w * h;
  const { minArea, pad, conn, requested, alphaThreshold, bgThreshold } = options;
  let sprites;
  ${body};
  return sprites;
`);

function original(data, width, height, options) {
  const values = { area: options.minArea, pad: options.pad, conn: options.conn,
    detectMode: options.requested, alpha: options.alphaThreshold, bgThreshold: options.bgThreshold };
  const context = {
    img: { naturalWidth: width, naturalHeight: height },
    document: { createElement: () => ({ getContext: () => ({
      drawImage() {}, getImageData: () => ({ data })
    }) }) },
    $: (id) => ({ value: values[id] }),
    select() {}, say() {}
  };
  return runInNewContext(baseline + '\nautoDetect(); sprites;', context);
}

const pixels = (rows, palette) => Uint8ClampedArray.from(rows.join('').split('').flatMap(x => palette[x]));
const options = { minArea: 1, pad: 1, conn: 4, requested: 'auto', alphaThreshold: 16, bgThreshold: 220 };
const alpha = pixels(['a..', '.b.', '..a'], { a: [0, 0, 0, 255], b: [0, 0, 0, 17], '.': [0, 0, 0, 0] });
const light = pixels(['.....', '.aaa.', '.a.a.', '.aaa.', '.....'], { a: [0, 0, 0, 255], '.': [245, 245, 245, 255] });
const normalize = (sprites) => JSON.parse(JSON.stringify(sprites));

for (const [label, data, size, changes, count] of [
  ['Alpha / 4 邻域', alpha, 3, {}, 3],
  ['Alpha / 8 邻域', alpha, 3, { conn: 8 }, 1],
  ['Alpha / 最小面积与阈值', alpha, 3, { minArea: 2, alphaThreshold: 17 }, 0],
  ['浅色背景 / 封闭高光', light, 5, { pad: 0 }, 1]
]) {
  test(label, () => {
    const config = { ...options, ...changes };
    const actual = detect(data, size, size, config);
    assert.equal(actual.length, count);
    assert.deepEqual(normalize(actual), normalize(original(data, size, size, config)));
    if (data === light) assert.deepEqual(Array.from(actual[0].mask), Array(9).fill(1));
  });
}

test('坐标往返和原图到裁切图的转换', () => {
  const point = { x: 133.25, y: 90.5 };
  for (const zoom of [0.125, 1, 2.75]) {
    for (const dpr of [1, 1.25, 2, 3]) {
      const view = { origin: { x: -21.5, y: 40.75 }, zoom, dpr };
      const hit = toSource(toDevice(point, view), view);
      assert.ok(Math.hypot(hit.x - point.x, hit.y - point.y) < 1e-10);
    }
  }
  assert.deepEqual(toSprite(point, { x: 130, y: 80 }), { x: 3.25, y: 10.5 });
});
