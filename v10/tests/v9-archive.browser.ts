import { readV9Archive, readV9Zip } from '../src/v9-archive.ts';
import { inspectRaster } from '../src/mask.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function rejected(value: Promise<unknown>, pattern: RegExp) {
  try { await value; }
  catch (error) { if (pattern.test(String(error))) return; throw error; }
  throw new Error('Expected ZIP rejection');
}

async function verify() {
  const fixture = await fetch('/a010.zip').then(response => {
    if (!response.ok) throw new Error('A-010 fixture was not served');
    return response.blob();
  });
  const { manifest, files } = await readV9Archive(fixture);
  assert(files.size === 30 && manifest.sprites.length === 30, 'Expected all 30 sprites');
  assert([...files.keys()].some(path => /[\u3400-\u9fff]/.test(path)), 'Expected UTF-8 Chinese filenames');
  for (const row of manifest.sprites as Array<{ file: string; sourceRect: { width: number; height: number } }>) {
    const file = files.get('sprites/' + row.file);
    assert(file, 'Manifest references a missing PNG');
    const raster = await inspectRaster(file!);
    assert(raster?.kind === 'png' && raster.width === row.sourceRect.width &&
      raster.height === row.sourceRect.height, 'PNG dimensions differ from the manifest');
  }

  const deflated = await fetch('/deflated.zip').then(response => response.blob());
  const compressed = await readV9Archive(deflated);
  assert(compressed.files.size === 0 && compressed.manifest.sprites.length === 0, 'DEFLATE manifest mismatch');

  const data = new Uint8Array(await fixture.arrayBuffer());
  const view = new DataView(data.buffer);
  const firstPayload = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const damage = data.slice();
  damage[firstPayload] ^= 1;
  await rejected(readV9Zip(new Blob([damage])), /CRC mismatch/);
  await rejected(readV9Zip(fixture.slice(0, -1)), /Missing ZIP directory/);
  const traversal = data.slice();
  const central = view.getUint32(data.length - 22 + 16, true);
  traversal.set([46, 46, 47], 30);
  traversal.set([46, 46, 47], central + 46);
  await rejected(readV9Zip(new Blob([traversal])), /Unsafe or duplicate ZIP path/);

  return { realV9Sprites: files.size, chineseNames: 'pass', deflate: 'pass',
    corruptCrc: 'pass', truncated: 'pass', pathTraversal: 'pass' };
}
verify().then(value => {
  document.querySelector('#result')!.textContent = JSON.stringify(value);
}, error => {
  document.querySelector('#result')!.textContent = JSON.stringify({ test: { error: String(error.stack ?? error) } });
});
