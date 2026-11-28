import type { ProjectDocument, SpriteAsset } from './domain.ts';
import { inspectRaster } from './mask.ts';
import { invariant } from './project.ts';
import { resourceHash, type ProjectStore } from './project-store.ts';

export type RasterReplacement = { png?: Blob; mask?: Blob };
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

export function rasterResourceIds(document: ProjectDocument, spriteId: string, patch: RasterReplacement): string[] {
  const sprite = findSprite(document, spriteId);
  const ids = kinds.filter(kind => patch[kind] !== undefined).map(kind => rasterVersion(sprite, kind).resourceId);
  invariant(ids.length, 'Raster replacement needs PNG or mask bytes');
  for (const id of ids) verifyOwnership(document, id);
  return ids;
}

export async function applyRasterReplacement(document: ProjectDocument, existing: ReadonlyMap<string, Blob>,
  spriteId: string, patch: RasterReplacement, store: Store) {
  rasterResourceIds(document, spriteId, patch);
  const sprite = findSprite(document, spriteId);
  const originalPng = existing.get(sprite.rasterResource.resourceId);
  invariant(originalPng, 'Missing current PNG bytes');
  const size = await inspectRaster(originalPng);
  invariant(size?.kind === 'png', 'Current raster is not a PNG');
  const changed: RasterKind[] = [];
  const undo: RasterReplacement = {};
  const redo: RasterReplacement = {};
  let bytes = 0;
  for (const kind of kinds) {
    const next = patch[kind];
    if (!next) continue;
    const version = rasterVersion(sprite, kind);
    if (await resourceHash(next) === version.contentHash) continue;
    const previous = existing.get(version.resourceId);
    invariant(previous, 'Missing current raster bytes');
    const layout = await inspectRaster(next);
    invariant(layout?.kind === kind && layout.width === size.width && layout.height === size.height,
      'Replacement must match the current PNG pixel dimensions and resource format');
    changed.push(kind);
    undo[kind] = previous;
    redo[kind] = next;
    bytes += previous.size + next.size;
  }
  invariant(changed.length, 'Raster replacement would make no changes');
  invariant(bytes <= 1024 ** 3, 'Raster replacement exceeds the session history byte limit');
  const staged = await store.stage(document.projectId, changed.map(kind => {
    const current = rasterVersion(sprite, kind);
    return { resourceId: current.resourceId, revision: current.revision + 1, bytes: redo[kind]! };
  }));
  for (const [index, kind] of changed.entries()) {
    const version = staged.versions[index];
    if (kind === 'png') sprite.rasterResource = version;
    else sprite.mask = { ...sprite.mask!, ...version };
    document.revisionLedger.resources[version.resourceId] = version.revision;
  }
  sprite.revision++;
  sprite.contentVersion++;
  document.revisionLedger.entities['spriteAsset:' + spriteId] = sprite.revision;
  return { stageId: staged.id, undo, redo, bytes };
}
