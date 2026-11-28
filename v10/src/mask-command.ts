import type { ProjectDocument } from './domain.ts';
import { inspectRaster } from './mask.ts';
import { invariant } from './project.ts';
import type { ProjectStore } from './project-store.ts';
import { findSprite, verifyOwnership } from './raster-command.ts';

export type MaskPresenceEdit =
  | { kind: 'attach'; resourceId: string; assetRef: string; bytes: Blob; restore?: true }
  | { kind: 'remove'; resourceId: string };

export function getMaskEditResources(document: ProjectDocument, spriteId: string, edit: MaskPresenceEdit) {
  const sprite = findSprite(document, spriteId);
  if (edit.kind === 'remove') {
    invariant(sprite.mask?.resourceId === edit.resourceId, 'Sprite does not own the expected mask');
    verifyOwnership(document, edit.resourceId);
  } else {
    invariant(!sprite.mask, 'Sprite already has a mask');
    invariant(edit.bytes.size <= 1024 ** 3, 'Mask exceeds the session history byte limit');
  }
  return [sprite.rasterResource.resourceId, edit.resourceId];
}

export async function applyMaskPresence(document: ProjectDocument, existing: ReadonlyMap<string, Blob>,
  spriteId: string, edit: MaskPresenceEdit, store: Pick<ProjectStore, 'stage'>) {
  getMaskEditResources(document, spriteId, edit);
  const sprite = findSprite(document, spriteId);
  const ledger = document.revisionLedger.resources;
  const watermark = ledger[edit.resourceId];
  let undo: MaskPresenceEdit;
  let redo: MaskPresenceEdit;
  let stageId: string | undefined;
  let bytes: number;
  if (edit.kind === 'remove') {
    const mask = sprite.mask!;
    const original = existing.get(edit.resourceId);
    invariant(original && mask.encoding === 'bitmap', 'Missing or unsupported current mask');
    invariant(original.size <= 1024 ** 3, 'Mask exceeds the session history byte limit');
    undo = { kind: 'attach', resourceId: edit.resourceId, assetRef: mask.assetRef, bytes: original, restore: true };
    redo = edit;
    bytes = original.size;
    ledger[edit.resourceId] = mask.revision + 1;
    delete sprite.mask;
  } else {
    invariant(edit.restore ? Number.isSafeInteger(watermark) : watermark === undefined, 'Mask identity cannot be reused');
    const png = existing.get(sprite.rasterResource.resourceId);
    invariant(png, 'Missing current PNG bytes');
    const [raster, mask] = await Promise.all([inspectRaster(png), inspectRaster(edit.bytes)]);
    invariant(raster?.kind === 'png' && mask?.kind === 'mask' &&
      raster.width === mask.width && raster.height === mask.height, 'Mask must match current PNG dimensions');
    const staged = await store.stage(document.projectId, [{
      resourceId: edit.resourceId, revision: edit.restore ? watermark + 1 : 1, bytes: edit.bytes
    }]);
    const [version] = staged.versions;
    stageId = staged.id;
    sprite.mask = { ...version, assetRef: edit.assetRef, kind: 'mask', encoding: 'bitmap',
      coordinateSpace: 'spriteLocal', width: mask.width, height: mask.height };
    ledger[edit.resourceId] = version.revision;
    undo = { kind: 'remove', resourceId: edit.resourceId };
    redo = { ...edit, restore: true };
    bytes = edit.bytes.size;
  }
  sprite.revision++;
  sprite.contentVersion++;
  document.revisionLedger.entities['spriteAsset:' + spriteId] = sprite.revision;
  return { stageId, undo, redo, bytes };
}
