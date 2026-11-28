import type { ProjectDocument, SceneLayout } from './domain.ts';
import { invariant, sameValue } from './project.ts';

export type SceneItemPatch = Partial<Pick<SceneLayout, 'layer' | 'depth' | 'parallax' | 'zIndex' |
  'visible' | 'locked' | 'position' | 'transform' | 'sceneAnchor' | 'anchorSource'>>;
export type SceneItemEdit = { spriteId: string; patch: SceneItemPatch };
export type SceneEdits = Map<string, SceneItemPatch>;
export const sceneItemKey = (id: string) => 'sceneItem:' + id;
const fields = new Set(['layer', 'depth', 'parallax', 'zIndex', 'visible', 'locked', 'position',
  'transform', 'sceneAnchor', 'anchorSource']);

function validPatch(patch: SceneItemPatch) {
  const keys = Object.keys(patch);
  invariant(keys.length && keys.every(key => fields.has(key) && patch[key as keyof SceneItemPatch] !== undefined),
    'Invalid scene item fields');
  const unit = (value: number | undefined, max = 1) => value === undefined ||
    (Number.isFinite(value) && value >= 0 && value <= max);
  invariant(unit(patch.depth) && unit(patch.parallax, 2) &&
    (patch.zIndex === undefined || Number.isSafeInteger(patch.zIndex)) &&
    [patch.visible, patch.locked].every(value => value === undefined || typeof value === 'boolean'),
    'Invalid scene depth, order or visibility');
  invariant(patch.layer === undefined || ['background', 'midground', 'foreground'].includes(patch.layer),
    'Invalid scene layer');
  invariant(patch.anchorSource === undefined || ['explicit', 'defaulted', 'legacy-unknown'].includes(patch.anchorSource),
    'Invalid scene anchor source');
  for (const point of [patch.position, patch.sceneAnchor]) {
    invariant(point === undefined || (point && Number.isFinite(point.x) && Number.isFinite(point.y)), 'Invalid scene point');
  }
  const transform = patch.transform;
  invariant(transform === undefined || (transform && [transform.scaleX, transform.scaleY, transform.rotation].every(Number.isFinite)
    && transform.scaleX !== 0 && transform.scaleY !== 0), 'Invalid scene transform');
}

export function collectSceneEdits(document: ProjectDocument, edits: readonly SceneItemEdit[]): SceneEdits {
  const patches: SceneEdits = new Map();
  for (const { spriteId, patch } of edits) {
    invariant(Object.hasOwn(document.sceneLayout.items, spriteId), 'Unknown scene item: ' + spriteId);
    invariant(!patches.has(spriteId), 'Duplicate scene item: ' + spriteId);
    validPatch(patch);
    patches.set(spriteId, structuredClone(patch));
  }
  invariant(patches.size, 'Scene command has no targets');
  return patches;
}

export function sceneOrderEdits(document: ProjectDocument, bottomToTop: readonly string[]): SceneItemEdit[] {
  const items = document.sceneLayout.items;
  invariant(bottomToTop.length === Object.keys(items).length &&
    new Set(bottomToTop).size === bottomToTop.length && bottomToTop.every(id => Object.hasOwn(items, id)),
    'Scene ordering requires all current scene items exactly once');
  return bottomToTop.map((spriteId, zIndex) => ({ spriteId, patch: { zIndex } }));
}

export function applySceneEdits(document: ProjectDocument, patches: SceneEdits) {
  const undo: SceneEdits = new Map();
  const redo: SceneEdits = new Map();
  for (const [id, patch] of patches) {
    const item = document.sceneLayout.items[id];
    invariant(item, 'Unknown scene item: ' + id);
    invariant(!item.locked || patch.locked === false || (!patch.position && !patch.transform),
      'Unlock the scene item before moving it');
    const next = { ...item, ...patch };
    if (sameValue(item, next)) continue;
    undo.set(id, Object.fromEntries(Object.keys(patch).map(key => [key, item[key as keyof SceneItemPatch]])));
    redo.set(id, patch);
    next.revision++;
    document.sceneLayout.items[id] = next;
    document.revisionLedger.entities[sceneItemKey(id)] = next.revision;
  }
  invariant(undo.size, 'Scene command would make no changes');
  return { undo, redo };
}
