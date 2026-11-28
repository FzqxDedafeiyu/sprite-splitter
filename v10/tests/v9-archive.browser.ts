import { previewV9Migration, saveV9Migration } from '../src/v9-migration.ts';
import { ProjectStore } from '../src/project-store.ts';
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

  const preview = await previewV9Migration(manifest, files);
  const migrated = preview.project;
  assert(preview.report.imported === 30 && preview.report.quarantined.length === 0, 'A-010 migration lost sprites');
  assert(migrated.sourceImages[0]?.availability === 'missing' && !migrated.sourceImages[0].resourceVersion,
    'Migration must preserve missing source metadata');
  assert(migrated.assets.every(asset => !asset.mask && asset.sourceRectStatus === 'known'), 'Unexpected migrated mask');
  assert(migrated.migrationMetadata?.idMap.filter(row => row.status === 'mapped').length === 30, 'Incomplete UUID bridge');

  const row = (manifest.sprites as Array<Record<string, unknown>>)[0];
  const sourceRect = row.sourceRect as { x: number; y: number; width: number; height: number };
  const dupe = { ...row, id: 'duplicate', file: (manifest.sprites[1] as { file: string }).file };
  const changedManifest = { ...manifest, sprites: [
    { ...row, extraField: 'retained', transform: { x: 25, y: -10, scaleX: 1.2, scaleY: 0.8, rotation: 35 },
      relations: { near_to: ['duplicate'], supports: ['missing'] } }, dupe, { ...dupe },
    { ...row, id: 'missing', file: 'absent.png' }
  ] };
  const quarantine = await previewV9Migration(changedManifest, files);
  const partial = quarantine.project;
  assert(partial.assets.length === 1 && quarantine.report.quarantined.length === 3, 'Ambiguous or missing records were not isolated');
  assert(partial.migrationMetadata?.idMap.filter(entry => entry.status === 'ambiguous').length === 2, 'Duplicate ID was not isolated as a set');
  const asset = partial.assets[0];
  assert(asset.legacyExtensions?.extraField === 'retained' && !!asset.legacyExtensions?.unresolvedRelations, 'Legacy fields were dropped');
  const layoutItem = partial.sceneLayout.items[asset.id];
  assert(layoutItem.position.x === sourceRect.x + 25 && layoutItem.position.y === sourceRect.y - 10 &&
    layoutItem.transform.rotation === 35 && layoutItem.transform.scaleY === 0.8 && layoutItem.anchorSource === 'legacy-unknown' &&
    layoutItem.relations.nearTo.length === 0, 'V9 transform, anchor or unresolved relations changed semantics');

  const db = 'sprite-v10-v9-migration-' + crypto.randomUUID();
  let store = await ProjectStore.open(db);
  try {
    const [resourceId, bytes] = [...preview.binaries][0];
    const invalidPreview = { ...preview, binaries: new Map(preview.binaries) };
    const damagedByte = new Uint8Array(await bytes.arrayBuffer());
    damagedByte[damagedByte.length - 1] ^= 1;
    invalidPreview.binaries.set(resourceId, new Blob([damagedByte]));
    await rejected(saveV9Migration(invalidPreview, store), /resource:|InvalidStateError|source image could not be decoded/);
    assert(await store.load(migrated.projectId) === undefined, 'Rejected migration created a partial project');
    await saveV9Migration(preview, store);
    store.close();
    store = await ProjectStore.open(db);
    const loaded = await store.load(migrated.projectId);
    assert(loaded?.bytes.size === 30 && loaded.document.assets.every((item, index) =>
      item.id === migrated.assets[index].id), 'UUID or raster was regenerated after reopen');
  } finally { store.close(); indexedDB.deleteDatabase(db); }
  return { v9MigrationPreview: 'pass', v9MigrationQuarantine: 'pass', v9MigrationReopen: 'pass', realV9Sprites: files.size, chineseNames: 'pass', deflate: 'pass',
    corruptCrc: 'pass', truncated: 'pass', pathTraversal: 'pass' };
}
verify().then(value => {
  document.querySelector('#result')!.textContent = JSON.stringify(value);
}, error => {
  document.querySelector('#result')!.textContent = JSON.stringify({ test: { error: String(error.stack ?? error) } });
});
