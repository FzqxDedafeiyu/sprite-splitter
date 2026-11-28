import type { ProjectDocument, SpriteAsset } from './domain.ts';
import { decodeMask, effectiveAlpha } from './mask.ts';
import { invariant, safeAssetPath } from './project.ts';
import { crc32, maxArchiveBytes, maxEntries, maxEntryBytes } from './v9-archive.ts';

const legacyId = (index: number) => 'sprite_' + String(index + 1).padStart(3, '0');
const finiteDimensions = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0;

export function buildV9SceneManifest(project: ProjectDocument) {
  const world = project.sceneLayout.world;
  const [source] = project.sourceImages;
  invariant(project.sourceImages.length === 1 && source.filename &&
    finiteDimensions(world.width) && finiteDimensions(world.height) &&
    source.width === world.width && source.height === world.height, 'V9 scene export needs one source with known canvas size');

  const ids = new Map<string, string>();
  const usedIds = new Set<string>();
  const seenIndexes = new Map<number, number>();
  for (const asset of project.assets) {
    if (asset.legacyId) {
      invariant(!usedIds.has(asset.legacyId), 'Duplicate V9 legacy ID: ' + asset.legacyId);
      ids.set(asset.id, asset.legacyId);
      usedIds.add(asset.legacyId);
    }
    const index = asset.legacyIndex;
    if (asset.legacyId && index !== undefined && Number.isSafeInteger(index) && index > 0) {
      seenIndexes.set(index, (seenIndexes.get(index) ?? 0) + 1);
    }
  }
  const reservedIndexes = new Set(seenIndexes.keys());
  let nextIndex = 1;
  const usedPaths = new Set<string>();
  const sprites = project.assets.map(asset => {
    let index = asset.legacyId ? asset.legacyIndex : undefined;
    if (index === undefined || seenIndexes.get(index) !== 1) {
      while (reservedIndexes.has(nextIndex) || (!asset.legacyId && usedIds.has(legacyId(nextIndex - 1)))) nextIndex++;
      index = nextIndex++;
    }
    if (!ids.has(asset.id)) {
      const id = legacyId(index - 1);
      ids.set(asset.id, id);
      usedIds.add(id);
    }
    const rect = asset.sourceRect;
    const item = project.sceneLayout.items[asset.id];
    invariant(rect && asset.sourceRectStatus === 'known' && item &&
      (asset.sourceImageId === undefined || asset.sourceImageId === source.id),
      'V9 scene export requires source geometry and a layout for each sprite: ' + asset.id);
    const dx = item.position.x - rect.x;
    const dy = item.position.y - rect.y;
    const numeric = [dx, dy, item.sceneAnchor.x - dx, item.sceneAnchor.y - dy,
      item.depth, item.parallax, item.zIndex, item.transform.scaleX, item.transform.scaleY, item.transform.rotation];
    invariant(numeric.every(Number.isFinite), 'V9 scene export cannot encode non-finite geometry');
    const prefix = String(index).padStart(3, '0') + '_';
    const leaf = asset.assetRef.split('/').at(-1)!;
    const label = (asset.name || 'sprite').replace(/[\\/:*?"<>|%#\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 100);
    const file = (asset.legacyId || leaf.startsWith(prefix)) && safeAssetPath(leaf) && /\.png$/i.test(leaf)
      ? leaf : prefix + label + '.png';
    const path = 'sprites/' + file;
    invariant(!usedPaths.has(path.normalize('NFC')), 'Duplicate V9 export path');
    usedPaths.add(path.normalize('NFC'));

    return { id: ids.get(asset.id)!, index, name: asset.name || 'sprite_' + index,
      category: asset.category || 'uncategorized', description: asset.description ?? '', group: asset.groupName || null,
      visible: item.visible, locked: item.locked, sourceRect: { ...rect },
      anchor: { x: item.sceneAnchor.x - dx, y: item.sceneAnchor.y - dy },
      layout: { layer: item.layer, depth: item.depth, parallax: item.parallax, zIndex: item.zIndex },
      transform: { x: dx, y: dy, scaleX: item.transform.scaleX, scaleY: item.transform.scaleY, rotation: item.transform.rotation },
      relations: item.relations,
      shape: asset.shape, ...(asset.shape === 'polygon' && asset.points ? { points: asset.points.map(point => ({ ...point })) } : {}), file };
  });

  function exportedRelation(targets: string[]) {
    return targets.map(target => {
      const id = ids.get(target);
      invariant(id, 'V9 relation does not have an export ID: ' + target);
      return id;
    });
  }
  const resolved = sprites.map(sprite => ({ ...sprite, relations: {
    nearTo: exportedRelation(sprite.relations.nearTo),
    attachedTo: exportedRelation(sprite.relations.attachedTo),
    supports: exportedRelation(sprite.relations.supports)
  } }));

  return { format: 'spatial-scene-layout/v2', source: source.filename,
    canvas: { width: world.width!, height: world.height!, coordinateOrigin: 'top-left', units: 'source-pixels' },
    layoutMode: project.sceneLayout.mode ?? 'source-coordinate-preserving', sprites: resolved };
}

async function exportPng(asset: SpriteAsset, getBytes: (id: string) => Blob | undefined) {
  const png = getBytes(asset.rasterResource.resourceId);
  invariant(png, 'Missing sprite PNG bytes: ' + asset.id);
  if (!asset.mask) return png;
  const maskBytes = getBytes(asset.mask.resourceId);
  invariant(maskBytes && asset.mask.encoding === 'bitmap', 'Missing or unsupported sprite mask: ' + asset.id);
  const mask = await decodeMask(maskBytes);
  const bitmap = await createImageBitmap(png);
  try {
    invariant(bitmap.width === mask.width && bitmap.height === mask.height, 'Mask does not match export PNG');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    invariant(context, 'Cannot open export canvas');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const alpha = Uint8Array.from(mask.samples, (_, index) => image.data[index * 4 + 3]);
    const effective = effectiveAlpha(alpha, mask.samples);
    for (let index = 0; index < effective.length; index++) image.data[index * 4 + 3] = effective[index];
    context.putImageData(image, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally { bitmap.close(); }
}

// STORE mirrors the V9 writer's UTF-8 member paths and keeps PNG members untouched.
export async function writeV9Zip(files: ReadonlyMap<string, Blob>) {
  invariant(files.size <= maxEntries, 'Too many V9 ZIP entries');
  const local: BlobPart[] = [];
  const central: BlobPart[] = [];
  const names = new Set<string>();
  const encoder = new TextEncoder();
  let offset = 0;
  let directorySize = 0;
  for (const [path, blob] of files) {
    const name = encoder.encode(path);
    const normalized = path.normalize('NFC');
    invariant(safeAssetPath(path) && !names.has(normalized) && name.length <= 0xffff &&
      blob.size <= maxEntryBytes, 'Invalid V9 export entry: ' + path);
    names.add(normalized);
    invariant(offset + 30 + name.length + blob.size + directorySize + 46 + name.length + 22 <= maxArchiveBytes,
      'V9 export exceeds archive size limit');
    const checksum = crc32(new Uint8Array(await blob.arrayBuffer()));
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x800, true);
    head.setUint32(14, checksum, true);
    head.setUint32(18, blob.size, true);
    head.setUint32(22, blob.size, true);
    head.setUint16(26, name.length, true);
    local.push(head.buffer, name, blob);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x800, true);
    record.setUint32(16, checksum, true);
    record.setUint32(20, blob.size, true);
    record.setUint32(24, blob.size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(record.buffer, name);
    offset += 30 + name.length + blob.size;
    directorySize += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.size, true);
  end.setUint16(10, files.size, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...local, ...central, end.buffer], { type: 'application/zip' });
}

export async function exportV9Scene(project: ProjectDocument, bytes: ReadonlyMap<string, Blob>) {
  const manifest = buildV9SceneManifest(project);
  const files = new Map<string, Blob>([['manifest.json', new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })]]);
  for (const [index, sprite] of manifest.sprites.entries()) {
    files.set('sprites/' + sprite.file, await exportPng(project.assets[index], id => bytes.get(id)));
  }
  const archive = await writeV9Zip(files);
  const idMap = manifest.sprites.map((sprite, index) => ({ legacyId: sprite.id, spriteId: project.assets[index].id }));
  return { manifest, archive, idMap };
}
