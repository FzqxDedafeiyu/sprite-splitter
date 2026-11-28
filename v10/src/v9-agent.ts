import type { AgentAnnotation, ProjectDocument, SceneLayout } from './domain.ts';
import type { AgentAnnotationEdit } from './agent-annotation-command.ts';
import { invariant } from './project.ts';

type Json = Record<string, unknown>;
type Warning = { legacyId?: string; code: 'unknown-target' | 'duplicate-target' | 'unresolved-relation' | 'invalid-field'; detail: string };
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown) => typeof value === 'string' && value.length ? value : undefined;
const known = new Set(['sprite_id', 'id', 'tags', 'confidence', 'reviewStatus', 'review_status', 'relations']);

export function previewV9AgentAnnotations(project: ProjectDocument, input: unknown) {
  const envelope = object(input);
  invariant(envelope.schema === 'spatial-scene-agent-result/v2' || envelope.schema === 'sprite-agent-result/v1',
    'Unsupported V9 Agent result schema');
  invariant(Array.isArray(envelope.sprites), 'V9 Agent result is missing sprites');
  if (Object.hasOwn(envelope, 'projectId')) {
    invariant(envelope.projectId === project.projectId, 'Agent 标注结果来自另一个项目。');
  }
  if (envelope.source !== undefined) {
    const source = object(envelope.source);
    if (Object.hasOwn(source, 'contentHash')) {
      invariant(typeof source.contentHash === 'string' && project.sourceImages.length === 1 &&
        source.contentHash === project.sourceImages[0].resourceVersion?.contentHash, 'Agent 标注结果与项目源图不一致。');
    }
    if (Object.hasOwn(source, 'width') || Object.hasOwn(source, 'height')) {
      invariant(typeof source.width === 'number' && typeof source.height === 'number' &&
        source.width === project.sceneLayout.world.width && source.height === project.sceneLayout.world.height,
        'V9 Agent result source dimensions do not match the project');
    }
  }
  const active = new Map(project.assets.map(asset => [asset.id, asset]));
  const identities = new Map<string, Set<string>>();
  const bind = (legacyId: string, id: string) => {
    if (!active.has(id)) return;
    const options = identities.get(legacyId) ?? new Set<string>();
    options.add(id);
    identities.set(legacyId, options);
  };
  const blocked = new Set(project.migrationMetadata?.idMap
    .filter(entry => entry.status !== 'mapped').map(entry => entry.legacyId));
  for (const record of project.migrationMetadata?.idMap ?? []) {
    if (record.status === 'mapped') bind(record.legacyId, record.spriteId);
  }
  for (const asset of project.assets) {
    bind(asset.id, asset.id);
    if (asset.legacyId) bind(asset.legacyId, asset.id);
  }
  const resolve = (legacyId: string) => {
    const candidates = identities.get(legacyId);
    return !blocked.has(legacyId) && candidates?.size === 1 ? [...candidates][0] : undefined;
  };

  const warnings: Warning[] = [];
  const edits: AgentAnnotationEdit[] = [];
  const proposals: Array<{ spriteId: string; relations?: SceneLayout['relations']; legacyFields: Json }> = [];
  const rows = envelope.sprites.map((row: unknown) => {
    const value = object(row);
    const primary = string(value.sprite_id);
    const alternate = string(value.id);
    const legacyId = primary && alternate && primary !== alternate ? undefined : primary ?? alternate;
    return { value, legacyId, spriteId: legacyId && resolve(legacyId) };
  });
  const counts = new Map<string, number>();
  for (const { spriteId } of rows) if (spriteId) counts.set(spriteId, (counts.get(spriteId) ?? 0) + 1);
  for (const { value, spriteId, legacyId } of rows) {
    if (!spriteId) {
      warnings.push({ legacyId, code: 'unknown-target', detail: 'No unique live UUID mapping' });
      continue;
    }
    if (counts.get(spriteId) !== 1) {
      warnings.push({ legacyId, code: 'duplicate-target', detail: 'All rows for this target omitted' });
      continue;
    }
    const legacyFields = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
    const tags = Array.isArray(value.tags) && value.tags.every(tag => typeof tag === 'string') ? value.tags as string[] : undefined;
    if (!tags && value.tags !== undefined) {
      legacyFields.invalidTags = value.tags;
      warnings.push({ legacyId, code: 'invalid-field', detail: 'Invalid tags preserved for review' });
    }
    const previous = active.get(spriteId)?.agentAnnotation;
    const annotation: AgentAnnotation = { ...previous, tags: tags?.slice() ?? previous?.tags.slice() ?? [] };
    if (typeof value.confidence === 'number' && Number.isFinite(value.confidence) &&
      value.confidence >= 0 && value.confidence <= 1) annotation.confidence = value.confidence;
    else if (value.confidence !== undefined && value.confidence !== null) {
      legacyFields.invalidConfidence = value.confidence;
      warnings.push({ legacyId, code: 'invalid-field', detail: 'Invalid confidence preserved for review' });
    }
    const reviewStatus = string(value.reviewStatus) ?? string(value.review_status);
    if (reviewStatus) annotation.reviewStatus = reviewStatus;
    let relations: SceneLayout['relations'] | undefined;
    if (value.relations !== undefined) {
      const raw = object(value.relations);
      relations = { nearTo: [], attachedTo: [], supports: [] };
      for (const [key, candidates] of [['nearTo', raw.nearTo ?? raw.near_to], ['attachedTo', raw.attachedTo ?? raw.attached_to],
        ['supports', raw.supports]] as const) {
        if (candidates === undefined) continue;
        const missing: unknown[] = [];
        for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
          const id = typeof candidate === 'string' ? resolve(candidate) : undefined;
          if (id) relations[key].push(id);
          else missing.push(candidate);
        }
        if (missing.length) {
          legacyFields['unresolved_' + key] = missing;
          warnings.push({ legacyId, code: 'unresolved-relation', detail: key });
        }
      }
      legacyFields.originalRelations = structuredClone(value.relations);
    }
    if (Object.keys(legacyFields).length) {
      annotation.legacyExtensions = structuredClone({ ...previous?.legacyExtensions, ...legacyFields });
    }
    edits.push({ spriteId, annotation });
    proposals.push({ spriteId, relations, legacyFields });
  }
  return { schema: envelope.schema, edits, proposals, warnings };
}
