import type { AgentAnnotation, ProjectDocument } from './domain.ts';
import { invariant } from './project.ts';

export type AgentAnnotationEdit = { spriteId: string; annotation: AgentAnnotation };

function isJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 32 || !value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (Array.isArray(value) || prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(child => isJson(child, depth + 1));
}

export function collectAgentAnnotations(document: ProjectDocument, edits: readonly AgentAnnotationEdit[]) {
  const targets = new Set(document.assets.map(sprite => sprite.id));
  const changes = new Map<string, { agentAnnotation: AgentAnnotation }>();
  for (const { spriteId, annotation } of edits) {
    invariant(targets.has(spriteId) && !changes.has(spriteId), 'Unknown or duplicate annotation target: ' + spriteId);
    invariant(annotation && Array.isArray(annotation.tags) && annotation.tags.every(tag => typeof tag === 'string'),
      'Invalid annotation tags');
    invariant(annotation.confidence === undefined ||
      (Number.isFinite(annotation.confidence) && annotation.confidence >= 0 && annotation.confidence <= 1),
      'Invalid annotation confidence');
    for (const optional of [annotation.reviewStatus, annotation.sourceAgent, annotation.updatedAt]) {
      invariant(optional === undefined || typeof optional === 'string', 'Invalid annotation metadata');
    }
    const { tags, confidence, reviewStatus, sourceAgent, updatedAt, legacyExtensions } = annotation;
    invariant(legacyExtensions === undefined || isJson(legacyExtensions), 'Invalid annotation extension data');
    const supported = { tags, confidence, reviewStatus, sourceAgent, updatedAt, legacyExtensions };
    invariant(Object.keys(annotation).every(key => Object.hasOwn(supported, key)),
      'Place unrecognized annotation fields in legacyExtensions');
    const clean: AgentAnnotation = { tags };
    if (confidence !== undefined) clean.confidence = confidence;
    if (reviewStatus !== undefined) clean.reviewStatus = reviewStatus;
    if (sourceAgent !== undefined) clean.sourceAgent = sourceAgent;
    if (updatedAt !== undefined) clean.updatedAt = updatedAt;
    if (legacyExtensions !== undefined) clean.legacyExtensions = legacyExtensions;
    changes.set(spriteId, { agentAnnotation: structuredClone(clean) });
  }
  invariant(changes.size, 'Annotation import has no targets');
  return changes;
}
