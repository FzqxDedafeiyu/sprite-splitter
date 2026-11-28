import type { Point, ProjectDocument, Rect, SpriteAsset } from './domain.ts';
import { decodeMask, encodeMask, inspectRaster, remapMask } from './mask.ts';
import { invariant, sameValue } from './project.ts';
import { resourceHash, type ProjectStore } from './project-store.ts';

export type RasterReplacement = { png?: Blob; mask?: Blob };
export type RasterEdit = RasterReplacement & { crop?: Rect; points?: Point[] };
type RasterKind = keyof RasterReplacement;
const kinds: readonly RasterKind[] = ['png', 'mask'];
type Store = Pick<ProjectStore, 'stage'>;

export function findSprite(document: ProjectDocument, id: string): SpriteAsset {
  const sprite = document.assets.find(asset => asset.id === id);
  invariant(sprite, 'Unknown sprite: ' + id);
  return sprite;
}

export function rasterVersion(sprite: SpriteAsset, kind: RasterKind) {
  const version = kind === 'png' ? sprite.rasterResource : sprite.mask;
  invariant(version, 'This command requires an existing mask');
  return version;
}

function verifyOwnership(document: ProjectDocument, resourceId: string) {
  let owners = 0;
  for (const asset of document.assets) {
    if (asset.rasterResource.resourceId === resourceId) owners++;
    if (asset.mask?.resourceId === resourceId) owners++;
  }
  for (const image of document.sourceImages) {
    if (image.resourceVersion?.resourceId === resourceId) owners++;
  }
  invariant(owners === 1, 'Shared raster must be detached before replacement: ' + resourceId);
}

export function rasterResourceIds(document: ProjectDocument, spriteId: string, patch: RasterEdit): string[] {
  const sprite = findSprite(document, spriteId);
  const write = kinds.filter(kind => patch[kind] !== undefined || (kind === 'mask' && patch.crop && sprite.mask));
  invariant(write.length, 'Raster replacement needs PNG or mask bytes');
  const ids = write.map(kind => rasterVersion(sprite, kind).resourceId);
  for (const id of ids) verifyOwnership(document, id);
  return [...new Set([sprite.rasterResource.resourceId, ...ids])];
}

function validateCrop(document: ProjectDocument, sprite: SpriteAsset, crop: Rect) {
  invariant([crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) &&
    crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 &&
    Number.isSafeInteger(crop.x + crop.width) && Number.isSafeInteger(crop.y + crop.height), 'Invalid source crop');
  const source = document.sourceImages.find(image => image.id === sprite.sourceImageId);
  invariant(!source || (crop.x + crop.width <= source.width && crop.y + crop.height <= source.height),
    'Crop exceeds source image bounds');
}

export async function applyRasterReplacement(document: ProjectDocument, existing: ReadonlyMap<string, Blob>,
  spriteId: string, patch: RasterEdit, store: Store) {
  rasterResourceIds(document, spriteId, patch);
  const sprite = findSprite(document, spriteId);
  const originalPng = existing.get(sprite.rasterResource.resourceId);
  invariant(originalPng, 'Missing current PNG bytes');
  const originalSize = await inspectRaster(originalPng);
  invariant(originalSize?.kind === 'png', 'Current raster is not a PNG');
  const size = patch.crop ?? originalSize;
  const changed: RasterKind[] = [];
  const undo: RasterEdit = {};
  const redo: RasterEdit = {};
  let mask = patch.mask;
  if (patch.crop) {
    const crop = patch.crop;
    const previous = sprite.sourceRect;
    invariant(previous && sprite.sourceRectStatus === 'known' && patch.png &&
      previous.width === originalSize.width && previous.height === originalSize.height,
      'Crop requires a known source rectangle matching the current PNG');
    validateCrop(document, sprite, crop);
    undo.crop = { ...previous };
    redo.crop = { ...crop };
    undo.png = originalPng;
    redo.png = patch.png;
    if (sprite.points) {
      undo.points = sprite.points.map(point => ({ ...point }));
      redo.points = patch.points ?? sprite.points.map(point => ({
        x: point.x + previous.x - crop.x, y: point.y + previous.y - crop.y
      }));
    }
    if (sprite.mask) {
      const oldMask = existing.get(sprite.mask.resourceId);
      invariant(oldMask, 'Missing current mask bytes');
      if (!mask) {
        const { samples } = await decodeMask(oldMask);
        mask = encodeMask(crop.width, crop.height, remapMask(samples, previous, crop));
      }
      undo.mask = oldMask;
      redo.mask = mask;
    }
  }
  const incoming = { png: patch.png, mask };
  for (const kind of kinds) {
    const next = incoming[kind];
    if (!next) continue;
    const version = rasterVersion(sprite, kind);
    const layout = await inspectRaster(next);
    invariant(layout?.kind === kind && layout.width === size.width && layout.height === size.height,
      'Replacement must match the expected PNG pixel dimensions and resource format');
    if (await resourceHash(next) === version.contentHash) continue;
    const previous = existing.get(version.resourceId);
    invariant(previous, 'Missing current raster bytes');
    changed.push(kind);
    undo[kind] = previous;
    redo[kind] = next;
  }
  const geometryChanged = patch.crop && !sameValue(sprite.sourceRect, patch.crop);
  invariant(changed.length || geometryChanged, 'Raster replacement would make no changes');
  const bytes = kinds.reduce((sum, kind) => sum + (undo[kind]?.size ?? 0) + (redo[kind]?.size ?? 0), 0);
  invariant(bytes <= 1024 ** 3, 'Raster replacement exceeds the session history byte limit');
  const staged = changed.length ? await store.stage(document.projectId, changed.map(kind => {
    const current = rasterVersion(sprite, kind);
    return { resourceId: current.resourceId, revision: current.revision + 1, bytes: redo[kind]! };
  })) : undefined;
  for (const [index, kind] of changed.entries()) {
    const version = staged!.versions[index];
    if (kind === 'png') sprite.rasterResource = version;
    else sprite.mask = { ...sprite.mask!, ...version, width: size.width, height: size.height };
    document.revisionLedger.resources[version.resourceId] = version.revision;
  }
  if (redo.crop) {
    sprite.sourceRect = redo.crop;
    if (redo.points) sprite.points = redo.points;
  }
  sprite.revision++;
  sprite.contentVersion++;
  document.revisionLedger.entities['spriteAsset:' + spriteId] = sprite.revision;
  return { stageId: staged?.id, undo, redo, bytes };
}
