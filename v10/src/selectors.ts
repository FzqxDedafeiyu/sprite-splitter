import type { ProjectDocument } from './domain.ts';

export function selectSprite(document: ProjectDocument, id: string) {
  return document.assets.find(asset => asset.id === id);
}

export function selectClipsForSet(document: ProjectDocument, id: string) {
  return document.animationClips.filter(clip => clip.setId === id);
}
