import { defaultSourceSceneItem, sceneItemKey, sceneLayoutKey } from './scene-command.ts';
import type { Point, ProjectDocument, Rect, ResourceVersion, SceneLayout, SpriteAsset } from './domain.ts';
import { inspectRaster } from './mask.ts';
import { invariant } from './project.ts';
import type { ProjectStore } from './project-store.ts';
import { findSprite, verifyOwnership } from './raster-command.ts';

export type NewSprite = {
  name: string; category: string; png: Blob; description?: string; sourceImageId?: string;
  sourceRect?: Rect; polygon?: Point[]; sceneOrder?: number;
};
type SpriteMetadata = Omit<SpriteAsset, 'revision' | 'contentVersion' | 'rasterResource' | 'mask'>;
type NewSceneItem = Omit<SceneLayout, 'revision'>;
type SpriteBinary = { resourceId: string; bytes: Blob };
type SpriteMask = Omit<NonNullable<SpriteAsset['mask']>, keyof ResourceVersion> & SpriteBinary;
export type SpritePresenceEdit =
  | { kind: 'attach'; index: number; sprite: SpriteMetadata; raster: SpriteBinary; mask?: SpriteMask; scene?: NewSceneItem; restore?: true }
  | { kind: 'remove'; spriteId: string; scene?: true };

export function newSpriteEdit(input: NewSprite, index: number): SpritePresenceEdit {
  const id = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const metadata = { name: input.name, category: input.category, description: input.description, sourceImageId: input.sourceImageId };
  const sourceRect = input.sourceRect && { ...input.sourceRect };
  const points = input.polygon?.map(point => ({ ...point }));
  let scene: NewSceneItem | undefined;
  if (input.sceneOrder !== undefined) {
    invariant(sourceRect && input.sourceImageId && Number.isSafeInteger(input.sceneOrder),
      'A new scene item requires source geometry and valid layer order');
    scene = defaultSourceSceneItem(id, sourceRect, input.sceneOrder);
  }
  return {
    kind: 'attach', index, scene, raster: { resourceId, bytes: input.png },
    sprite: { ...metadata, id, assetRef: 'sprites/' + resourceId + '.png', sourceRect,
      sourceRectStatus: sourceRect ? 'known' : 'unknown', shape: points ? 'polygon' : 'rectangle', points }
  };
}

function ensureUnreferenced(document: ProjectDocument, id: string, removeOwnScene: boolean) {
  const referenced = (!removeOwnScene && Object.hasOwn(document.sceneLayout.items, id)) ||
    Object.values(document.sceneLayout.items).some(item => Object.values(item.relations).some(ids => ids.includes(id))) ||
    document.sceneGroups.some(group => group.memberSpriteIds.includes(id)) ||
    document.animationSets.some(set => set.spriteIds.includes(id)) ||
    document.animationClips.some(clip => clip.frames.some(frame => frame.spriteId === id));
  invariant(!referenced, 'Detach scene and animation references before deleting this sprite');
}

export function spritePresenceTarget(edit: SpritePresenceEdit): string {
  return edit.kind === 'attach' ? edit.sprite.id : edit.spriteId;
}

export function spritePresenceKeys(document: ProjectDocument, edit: SpritePresenceEdit) {
  const id = spritePresenceTarget(edit);
  const keys = ['spriteAsset:' + id];
  if (edit.scene) keys.push(sceneItemKey(id), sceneLayoutKey(document.projectId));
  return keys;
}

function advanceSceneLayout(document: ProjectDocument) {
  const layout = document.sceneLayout;
  layout.revision++;
  document.revisionLedger.entities[sceneLayoutKey(document.projectId)] = layout.revision;
}

export function spritePresenceResources(document: ProjectDocument, edit: SpritePresenceEdit): string[] {
  if (edit.kind === 'attach') return edit.mask ? [edit.raster.resourceId, edit.mask.resourceId] : [edit.raster.resourceId];
  const sprite = findSprite(document, edit.spriteId);
  ensureUnreferenced(document, edit.spriteId, Boolean(edit.scene));
  const references = [sprite.rasterResource.resourceId];
  if (sprite.mask) references.push(sprite.mask.resourceId);
  for (const id of references) verifyOwnership(document, id);
  return references;
}

export async function applySpritePresence(document: ProjectDocument, existing: ReadonlyMap<string, Blob>,
  edit: SpritePresenceEdit, store: Pick<ProjectStore, 'stage'>) {
  const id = spritePresenceTarget(edit);
  const key = 'spriteAsset:' + id;
  const ledger = document.revisionLedger;
  const references = spritePresenceResources(document, edit);
  if (edit.kind === 'remove') {
    const current = findSprite(document, id);
    const { revision, contentVersion: _contentVersion, rasterResource, mask, ...metadata } = current;
    const png = existing.get(rasterResource.resourceId);
    const maskBytes = mask && existing.get(mask.resourceId);
    invariant(png && (!mask || maskBytes), 'Missing sprite resource bytes');
    const bytes = png.size + (maskBytes?.size ?? 0);
    invariant(bytes <= 1024 ** 3, 'Sprite exceeds the session history byte limit');
    const index = document.assets.findIndex(asset => asset.id === id);
    const undo: SpritePresenceEdit = { kind: 'attach', index, sprite: metadata,
      raster: { resourceId: rasterResource.resourceId, bytes: png }, restore: true };
    if (edit.scene) {
      const scene = document.sceneLayout.items[id];
      invariant(scene, 'The scene item to remove is missing');
      const { revision: sceneRevision, ...properties } = scene;
      undo.scene = properties;
      delete document.sceneLayout.items[id];
      ledger.entities[sceneItemKey(id)] = sceneRevision + 1;
      advanceSceneLayout(document);
    }
    if (mask && maskBytes) {
      const { resourceId, revision: _revision, contentHash: _hash, byteLength: _length, ...descriptor } = mask;
      undo.mask = { ...descriptor, resourceId, bytes: maskBytes };
      ledger.resources[resourceId] = mask.revision + 1;
    }
    document.assets.splice(index, 1);
    ledger.entities[key] = revision + 1;
    ledger.resources[rasterResource.resourceId] = rasterResource.revision + 1;
    return { undo, redo: edit, bytes };
  }

  const watermark = ledger.entities[key];
  invariant(!document.assets.some(asset => asset.id === id) && (edit.restore ? watermark >= 1 : watermark === undefined),
    'Sprite identity cannot be reused');
  invariant(Number.isInteger(edit.index) && edit.index >= 0 && edit.index <= document.assets.length, 'Invalid sprite order');
  invariant(typeof edit.sprite.name === 'string' && typeof edit.sprite.category === 'string', 'Invalid sprite properties');
  const binaries = edit.mask ? [edit.raster, edit.mask] : [edit.raster];
  const bytes = binaries.reduce((size, binary) => size + binary.bytes.size, 0);
  invariant(bytes <= 1024 ** 3, 'Sprite exceeds the session history byte limit');
  for (const resourceId of references) {
    const revision = ledger.resources[resourceId];
    invariant(edit.restore ? Number.isSafeInteger(revision) : revision === undefined, 'Sprite resource identity cannot be reused');
  }
  const layout = await inspectRaster(edit.raster.bytes);
  invariant(layout?.kind === 'png', 'Sprite requires a valid PNG');
  const rect = edit.sprite.sourceRect;
  if (rect) {
    const source = document.sourceImages.find(image => image.id === edit.sprite.sourceImageId);
    invariant([rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) && rect.x >= 0 && rect.y >= 0 &&
      rect.width === layout.width && rect.height === layout.height &&
      Number.isSafeInteger(rect.x + rect.width) && Number.isSafeInteger(rect.y + rect.height) &&
      (!source || (rect.x + rect.width <= source.width && rect.y + rect.height <= source.height)), 'Invalid source rectangle');
  }
  if (edit.sprite.shape === 'polygon') {
    invariant(edit.sprite.points && edit.sprite.points.length >= 3 &&
      edit.sprite.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), 'Invalid sprite polygon');
  }
  const sceneWatermark = ledger.entities[sceneItemKey(id)];
  if (edit.scene) {
    invariant(edit.scene.spriteId === id && !Object.hasOwn(document.sceneLayout.items, id) &&
      (edit.restore ? sceneWatermark >= 1 : sceneWatermark === undefined), 'Scene item identity cannot be reused');
  }
  const staged = await store.stage(document.projectId, binaries.map(({ resourceId, bytes: blob }) => ({
    resourceId, revision: edit.restore ? ledger.resources[resourceId] + 1 : 1, bytes: blob
  })));
  const [rasterResource, maskVersion] = staged.versions;
  const revision = edit.restore ? watermark + 1 : 1;
  const sprite: SpriteAsset = { ...edit.sprite, rasterResource, revision, contentVersion: revision };
  if (edit.mask) {
    const { bytes: _maskBytes, ...descriptor } = edit.mask;
    sprite.mask = { ...descriptor, ...maskVersion };
  }
  document.assets.splice(edit.index, 0, sprite);
  ledger.entities[key] = revision;
  for (const version of staged.versions) ledger.resources[version.resourceId] = version.revision;
  if (edit.scene) {
    const sceneRevision = edit.restore ? sceneWatermark + 1 : 1;
    document.sceneLayout.items[id] = { ...edit.scene, revision: sceneRevision };
    ledger.entities[sceneItemKey(id)] = sceneRevision;
    advanceSceneLayout(document);
  }
  const undo: SpritePresenceEdit = { kind: 'remove', spriteId: id, scene: edit.scene ? true : undefined };
  return { stageId: staged.id, undo, redo: { ...edit, restore: true as const }, bytes };
}
