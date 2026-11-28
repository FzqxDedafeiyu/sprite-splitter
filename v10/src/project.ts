import type { ProjectDocument, ResourceVersion } from './domain.ts';

export class IntegrityError extends Error {}
type Versioned = { revision: number };
export type ResourcePointer = { assetRef: string; version: ResourceVersion };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashPattern = /^sha256:[0-9a-f]{64}$/;
const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 1;
const dimension = validRevision;

export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new IntegrityError(message);
}

export function safeAssetPath(path: string): boolean {
  return typeof path === 'string' && path.split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..' && !/[\\:%?#\u0000-\u001f]/.test(part));
}

export function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.entries(left);
  return a.length === Object.keys(right).length &&
    a.every(([key, value]) => Object.hasOwn(right, key) &&
      sameValue(value, (right as Record<string, unknown>)[key]));
}

export function entities(document: ProjectDocument) {
  const values = new Map<string, Versioned>();
  function add(type: string, id: string, value: Versioned) {
    const key = type + ':' + id;
    invariant(uuidPattern.test(id) && !values.has(key), 'Invalid or duplicate entity: ' + key);
    invariant(validRevision(value.revision), 'Invalid entity revision: ' + key);
    values.set(key, value);
  }
  for (const value of document.sourceImages) add('sourceImage', value.id, value);
  for (const value of document.assets) add('spriteAsset', value.id, value);
  for (const value of document.sceneGroups) add('sceneGroup', value.id, value);
  const layout = document.sceneLayout;
  add('sceneLayout', document.projectId, { ...layout, items: Object.keys(layout.items).sort() } as Versioned);
  for (const [key, value] of Object.entries(layout.items)) {
    invariant(key === value.spriteId, 'Scene layout key mismatch: ' + key);
    add('sceneItem', key, value);
  }
  for (const value of document.animationSets) add('animationSet', value.id, value);
  for (const clip of document.animationClips) {
    add('animationClip', clip.id, { ...clip, frames: clip.frames.map(frame => frame.id) } as Versioned);
    for (const value of clip.frames) add('animationFrame', value.id, value);
  }
  for (const value of document.pivotPresets) add('pivotPreset', value.id, value);
  add('projectSettings', document.projectId, document.projectSettings);
  return values;
}

export function resources(document: ProjectDocument) {
  const result = new Map<string, ResourcePointer>();
  const paths = new Map<string, string>();
  function add(assetRef: string, version: ResourceVersion) {
    const { resourceId, revision, contentHash, byteLength } = version;
    const pointer = { assetRef, version: { resourceId, revision, contentHash, byteLength } };
    invariant(safeAssetPath(assetRef), 'Unsafe asset path: ' + assetRef);
    invariant(uuidPattern.test(resourceId) && validRevision(revision) && hashPattern.test(contentHash) &&
      dimension(byteLength), 'Invalid resource version: ' + resourceId);
    invariant(!paths.has(assetRef) || paths.get(assetRef) === resourceId, 'Duplicate asset path: ' + assetRef);
    invariant(!result.has(resourceId) || sameValue(result.get(resourceId), pointer), 'Inconsistent resource reference: ' + resourceId);
    result.set(resourceId, pointer);
    paths.set(assetRef, resourceId);
  }
  for (const image of document.sourceImages) {
    invariant(dimension(image.width) && dimension(image.height), 'Invalid source dimensions: ' + image.id);
    if (image.availability === 'available') {
      invariant(image.assetRef && image.resourceVersion, 'Missing source image reference: ' + image.id);
      add(image.assetRef, image.resourceVersion);
    } else invariant(image.availability === 'missing' && image.assetRef === undefined &&
      image.resourceVersion === undefined, 'Unexpected unavailable source reference: ' + image.id);
  }
  for (const sprite of document.assets) {
    add(sprite.assetRef, sprite.rasterResource);
    if (sprite.mask) {
      invariant(sprite.mask.kind === 'mask' && sprite.mask.coordinateSpace === 'spriteLocal' &&
        dimension(sprite.mask.width) && dimension(sprite.mask.height) &&
        ['bitmap', 'rle'].includes(sprite.mask.encoding), 'Invalid mask: ' + sprite.id);
      invariant(sprite.mask.resourceId !== sprite.rasterResource.resourceId, 'Mask and PNG must be independent resources');
      add(sprite.mask.assetRef, sprite.mask);
    }
  }
  return result;
}

export function validateProject(document: ProjectDocument) {
  invariant(document.kind === 'sprite-project' && document.projectSchemaVersion === 10 &&
    uuidPattern.test(document.projectId) && validRevision(document.revision), 'Invalid project header');
  const { entities: entityLedger, resources: resourceLedger } = document.revisionLedger;
  for (const ledger of [entityLedger, resourceLedger]) {
    for (const value of Object.values(ledger)) invariant(validRevision(value), 'Invalid ledger watermark');
  }
  for (const [key, value] of entities(document)) {
    invariant(entityLedger[key] === value.revision, 'Entity ledger mismatch: ' + key);
  }
  for (const [id, pointer] of resources(document)) {
    invariant(resourceLedger[id] === pointer.version.revision, 'Resource ledger mismatch: ' + id);
  }
  const sprites = new Set(document.assets.map(asset => asset.id));
  const sources = new Set(document.sourceImages.map(image => image.id));
  const sets = new Set(document.animationSets.map(set => set.id));
  const presets = new Set(document.pivotPresets.map(preset => preset.id));
  function sprite(id: string) { invariant(sprites.has(id), 'Unknown sprite: ' + id); }
  for (const asset of document.assets) {
    invariant(typeof asset.name === 'string' && typeof asset.category === 'string' &&
      validRevision(asset.contentVersion), 'Invalid sprite metadata: ' + asset.id);
    invariant(asset.shape === 'rectangle' || (asset.shape === 'polygon' && asset.points &&
      asset.points.length >= 3 && asset.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))),
      'Invalid sprite shape: ' + asset.id);
    const rect = asset.sourceRect;
    invariant(asset.sourceRectStatus === 'known'
      ? rect && Number.isSafeInteger(rect.x) && rect.x >= 0 && Number.isSafeInteger(rect.y) && rect.y >= 0 &&
        dimension(rect.width) && dimension(rect.height)
      : asset.sourceRectStatus === 'unknown' && rect === undefined,
      'Invalid source rectangle: ' + asset.id);
    if (asset.sourceImageId !== undefined) invariant(sources.has(asset.sourceImageId), 'Unknown source image');
  }
  for (const group of document.sceneGroups) group.memberSpriteIds.forEach(sprite);
  for (const item of Object.values(document.sceneLayout.items)) {
    sprite(item.spriteId);
    Object.values(item.relations).forEach(ids => ids.forEach(sprite));
  }
  for (const set of document.animationSets) set.spriteIds.forEach(sprite);
  for (const clip of document.animationClips) {
    invariant(sets.has(clip.setId) && presets.has(clip.pivotPresetId), 'Unknown animation set or preset');
    for (const frame of clip.frames) {
      sprite(frame.spriteId);
      invariant(!sprites.has(frame.id), 'Frame ID conflicts with a sprite ID');
    }
  }
}

export function createProject(projectId = crypto.randomUUID()): ProjectDocument {
  const document: ProjectDocument = {
    kind: 'sprite-project', projectSchemaVersion: 10, projectId, revision: 1,
    sourceImages: [], assets: [], sceneGroups: [], animationSets: [], animationClips: [], pivotPresets: [],
    sceneLayout: { revision: 1, world: { coordinateOrigin: 'top-left', units: 'source-pixels' }, items: {} },
    projectSettings: { revision: 1, colorSpace: 'srgb', defaultFps: 12, autosaveEnabled: true,
      pixelArt: { enabled: true, renderSnap: 'round' } },
    revisionLedger: { entities: { ['sceneLayout:' + projectId]: 1, ['projectSettings:' + projectId]: 1 }, resources: {} }
  };
  validateProject(document);
  return document;
}
