import type { AnimationSet, ProjectDocument } from './domain.ts';
import { invariant } from './project.ts';

export type NewAnimationSet = Pick<AnimationSet, 'name' | 'assetType' | 'spriteIds'>;
export type AnimationSetEdit =
  | { kind: 'attach'; set: Omit<AnimationSet, 'revision'>; index: number; restore?: true }
  | { kind: 'remove'; id: string };

export const animationSetKey = (id: string) => 'animationSet:' + id;

export function animationSetId(edit: AnimationSetEdit) {
  return edit.kind === 'attach' ? edit.set.id : edit.id;
}

export function newAnimationSetEdit(input: NewAnimationSet, index: number): AnimationSetEdit {
  const name = input.name.trim();
  invariant(name && (input.assetType === 'character' || input.assetType === 'object'), '无效的动作组名称或类型。');
  const now = new Date().toISOString();
  return { kind: 'attach', index, set: { id: crypto.randomUUID(), name, assetType: input.assetType,
    spriteIds: input.spriteIds.slice(), createdAt: now, updatedAt: now } };
}

export function applyAnimationSet(document: ProjectDocument, edit: AnimationSetEdit) {
  const id = animationSetId(edit);
  const key = animationSetKey(id);
  const ledger = document.revisionLedger.entities;
  const sets = document.animationSets;
  if (edit.kind === 'remove') {
    const index = sets.findIndex(set => set.id === id);
    invariant(index >= 0 && !document.animationClips.some(clip => clip.setId === id),
      '存在引用该动作组的动作，或找不到该动作组。');
    const [{ revision, ...set }] = sets.splice(index, 1);
    ledger[key] = revision + 1;
    const undo: AnimationSetEdit = { kind: 'attach', index, set, restore: true };
    return { undo, redo: edit };
  }

  const watermark = ledger[key];
  invariant(!sets.some(set => set.id === id) && (edit.restore ? watermark >= 1 : watermark === undefined),
    '动作组标识已被使用。');
  invariant(Number.isSafeInteger(edit.index) && edit.index >= 0 && edit.index <= sets.length, '无效的动作组位置。');
  const sprites = new Set(document.assets.map(sprite => sprite.id));
  invariant(new Set(edit.set.spriteIds).size === edit.set.spriteIds.length &&
    edit.set.spriteIds.every(spriteId => sprites.has(spriteId)), '动作组中存在无效的素材引用。');
  const revision = edit.restore ? watermark + 1 : 1;
  sets.splice(edit.index, 0, { ...edit.set, revision });
  ledger[key] = revision;
  const undo: AnimationSetEdit = { kind: 'remove', id };
  const redo: AnimationSetEdit = { ...edit, restore: true };
  return { undo, redo };
}
