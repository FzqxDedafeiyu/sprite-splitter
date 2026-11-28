import type { AgentAnnotation, MigrationMetadata, MigrationWarning, Point, ProjectDocument,
  Rect, SceneLayout, SpriteAsset } from './domain.ts';
import { inspectRaster } from './mask.ts';
import { createProject, invariant, safeAssetPath, validateProject } from './project.ts';
import { resourceHash, type ProjectStore } from './project-store.ts';

type Json = Record<string, unknown>;
type Candidate = { raw: Json; legacyId: string; path: string; index?: number; ordinal: number };
type Quarantined = { legacyId?: string; reason: string; row: unknown };
const keysFor = (keys: string) => new Set(keys.split(' '));
const topKeys = keysFor('format source canvas layoutMode sprites');
const spriteKeys = keysFor('id index name category description group visible locked sourceRect anchor layout transform relations shape points file tags confidence reviewStatus review_status');
const json = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown) => typeof value === 'string' && value.trim().length ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const positive = (value: unknown) => { const n = integer(value); return n !== undefined && n > 0 ? n : undefined; };
function point(value: unknown): Point | undefined {
  const { x, y } = json(value);
  const px = number(x);
  const py = number(y);
  return px !== undefined && py !== undefined ? { x: px, y: py } : undefined;
}
function rect(value: unknown): Rect | undefined {
  const { x, y, width, height } = json(value);
  const origin = point({ x, y });
  const w = positive(width);
  const h = positive(height);
  return origin && Number.isSafeInteger(origin.x) && origin.x >= 0 && Number.isSafeInteger(origin.y) && origin.y >= 0 &&
    w && h && Number.isSafeInteger(origin.x + w) && Number.isSafeInteger(origin.y + h)
    ? { ...origin, width: w, height: h } : undefined;
}
function extras(value: Json, consumed: Set<string>) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !consumed.has(key)));
}
function counts(values: readonly string[]) {
  const result = new Map<string, number>();
  for (const key of values) result.set(key, (result.get(key) ?? 0) + 1);
  return result;
}
function annotation(raw: Json): AgentAnnotation | undefined {
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((value): value is string => typeof value === 'string') : undefined;
  const confidence = number(raw.confidence);
  const reviewStatus = text(raw.reviewStatus) ?? text(raw.review_status);
  if (!tags && confidence === undefined && !reviewStatus) return undefined;
  return { tags: tags ?? [], ...(confidence !== undefined && confidence >= 0 && confidence <= 1 ? { confidence } : {}),
    ...(reviewStatus ? { reviewStatus } : {}) };
}

export async function previewV9Migration(input: unknown, files: ReadonlyMap<string, Blob>,
  { includeOrphans = false }: { includeOrphans?: boolean } = {}) {
  const manifest = json(input);
  invariant(manifest.format === 'spatial-scene-layout/v2' && Array.isArray(manifest.sprites), 'Unsupported V9 manifest format');
  const project = createProject();
  const binaries = new Map<string, Blob>();
  const warnings: MigrationWarning[] = [];
  const quarantined: Quarantined[] = [];
  const idMap: MigrationMetadata['idMap'] = [];
  const warn = (code: string, message: string, severity: MigrationWarning['severity'], legacyId?: string, path?: string) =>
    warnings.push({ code, message, severity, legacyId, path });

  const canvas = json(manifest.canvas);
  const width = positive(canvas.width);
  const height = positive(canvas.height);
  const filename = text(manifest.source);
  const sourceId = width && height && filename ? crypto.randomUUID() : undefined;
  if (width && height) Object.assign(project.sceneLayout.world, { width, height });
  const mode = text(manifest.layoutMode);
  if (mode) project.sceneLayout.mode = mode;
  if (sourceId) {
    project.sourceImages.push({ id: sourceId, revision: 1, filename: filename!,
      width: width!, height: height!, availability: 'missing' });
    project.revisionLedger.entities['sourceImage:' + sourceId] = 1;
  }
  if (filename || manifest.canvas !== undefined) {
    warn('missing-source', 'V9 export does not carry the full source image bytes', 'warning');
  }
  warn('mask-unavailable', 'V9 export does not include editable masks', 'info');

  const declared = new Set<string>();
  const candidates: Candidate[] = [];
  manifest.sprites.forEach((row: unknown, ordinal: number) => {
    const raw = json(row);
    const legacyId = text(raw.id);
    const file = text(raw.file);
    const path = file ? 'sprites/' + file : '';
    if (file && safeAssetPath(file) && !file.includes('/')) declared.add(path);
    if (!legacyId) {
      warn('invalid-id', 'Manifest row has no usable legacy ID', 'error', undefined, path);
      quarantined.push({ reason: 'invalid-id', row });
      return;
    }
    candidates.push({ raw, legacyId, path, index: positive(raw.index), ordinal });
  });

  const ids = counts(candidates.map(candidate => candidate.legacyId));
  const paths = counts(candidates.filter(candidate => candidate.path).map(candidate => candidate.path.normalize('NFC')));
  const candidateOrder = candidates.every(candidate => candidate.index !== undefined) &&
    new Set(candidates.map(candidate => candidate.index)).size === candidates.length
    ? [...candidates].sort((a, b) => a.index! - b.index!) : undefined;
  const rank = new Map((candidateOrder ?? candidates).map((candidate, index) => [candidate.ordinal, index]));
  if (!candidateOrder && candidates.some(candidate => integer(json(candidate.raw.layout).zIndex) === undefined)) {
    warn('unstable-index', 'Missing or duplicate index; default Z order follows manifest order', 'warning');
  }

  const imported: Array<{ candidate: Candidate; asset: SpriteAsset; bounds: Rect }> = [];
  const resolver = new Map<string, string>();
  async function addRaster(path: string, blob: Blob, name: string, category: string): Promise<SpriteAsset> {
    const id = crypto.randomUUID();
    const resourceId = crypto.randomUUID();
    const resource = { resourceId, revision: 1, contentHash: await resourceHash(blob), byteLength: blob.size };
    binaries.set(resourceId, blob);
    project.revisionLedger.entities['spriteAsset:' + id] = 1;
    project.revisionLedger.resources[resourceId] = 1;
    const asset: SpriteAsset = { id, name, category, assetRef: path, rasterResource: resource,
      revision: 1, contentVersion: 1, sourceRectStatus: 'unknown', shape: 'rectangle' };
    project.assets.push(asset);
    return asset;
  }
  for (const candidate of candidates) {
    const { raw, legacyId, path, index } = candidate;
    const sourceFile = path || undefined;
    const ambiguous = ids.get(legacyId)! > 1 || (path && paths.get(path.normalize('NFC'))! > 1);
    const rejected = (status: 'missing_asset' | 'ambiguous', code: string, message: string) => {
      idMap.push({ status, legacyId, legacyIndex: index, sourceFile });
      warn(code, message, 'error', legacyId, sourceFile);
      quarantined.push({ legacyId, reason: code, row: structuredClone(raw) });
    };
    if (ambiguous) {
      rejected('ambiguous', 'ambiguous-sprite', 'Duplicate legacy ID or file path');
      continue;
    }
    const bounds = rect(raw.sourceRect);
    const file = path && safeAssetPath(path) && path.split('/').length === 2 ? files.get(path) : undefined;
    let raster;
    try { if (file?.size) raster = await inspectRaster(file); } catch { /* Unusable PNG goes to quarantine. */ }
    if (!bounds || !file || raster?.kind !== 'png' || raster.width !== bounds.width || raster.height !== bounds.height) {
      rejected('missing_asset', 'invalid-resource', 'Missing or invalid PNG, source rectangle, or size match');
      continue;
    }
    const shape = raw.shape === 'polygon' ? 'polygon' : 'rectangle';
    const points = Array.isArray(raw.points) ? Array.from(raw.points, point) : [];
    if (shape === 'polygon' && (points.length < 3 || points.some(value => !value))) {
      rejected('missing_asset', 'invalid-polygon', 'Invalid polygon coordinates');
      continue;
    }
    const asset = await addRaster(path, file, text(raw.name) ?? legacyId, text(raw.category) ?? 'uncategorized');
    Object.assign(asset, { legacyId, legacyIndex: index, sourceImageId: sourceId,
      sourceRect: bounds, sourceRectStatus: 'known', shape });
    if (shape === 'polygon') asset.points = points as Point[];
    if (typeof raw.description === 'string') asset.description = raw.description;
    if (raw.group === null || typeof raw.group === 'string') asset.groupName = raw.group;
    const note = annotation(raw);
    if (note) asset.agentAnnotation = note;
    const extra = extras(raw, spriteKeys);
    for (const [key, known] of [['layout', 'layer depth parallax zIndex'], ['transform', 'x y scaleX scaleY rotation'],
      ['relations', 'nearTo near_to attachedTo attached_to supports'], ['sourceRect', 'x y width height'],
      ['anchor', 'x y']] as const) {
      const unknown = extras(json(raw[key]), keysFor(known));
      if (Object.keys(unknown).length) extra[key] = unknown;
    }
    if (Object.keys(extra).length) {
      asset.legacyExtensions = extra;
      warn('unknown-field', 'Unrecognized sprite fields preserved: ' + Object.keys(extra).join(', '), 'info', legacyId);
    }
    resolver.set(legacyId, asset.id);
    idMap.push({ status: 'mapped', legacyId, spriteId: asset.id, legacyIndex: index, sourceFile });
    imported.push({ candidate, asset, bounds });
  }

  for (const { candidate, asset, bounds } of imported) {
    const { raw, legacyId, ordinal } = candidate;
    const layout = json(raw.layout);
    const offset = json(raw.transform);
    const dx = number(offset.x) ?? 0;
    const dy = number(offset.y) ?? 0;
    const rawAnchor = point(raw.anchor);
    const anchor = rawAnchor ?? { x: Math.round(bounds.x + bounds.width / 2), y: bounds.y + bounds.height };
    if (rawAnchor) asset.legacyAnchor = rawAnchor;
    else if (Object.hasOwn(raw, 'anchor')) {
      asset.legacyExtensions = { ...asset.legacyExtensions, invalidAnchor: raw.anchor };
      warn('invalid-anchor', 'Invalid legacy anchor preserved; using bottom center for preview', 'warning', legacyId);
    }
    const sourceRelations = json(raw.relations);
    const relations: SceneLayout['relations'] = { nearTo: [], attachedTo: [], supports: [] };
    const unresolved = {};
    for (const [key, value] of [['nearTo', sourceRelations.nearTo ?? sourceRelations.near_to],
      ['attachedTo', sourceRelations.attachedTo ?? sourceRelations.attached_to],
      ['supports', sourceRelations.supports]] as const) {
      const missing: unknown[] = [];
      for (const target of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
        const known = typeof target === 'string' ? resolver.get(target) : undefined;
        if (known) relations[key].push(known);
        else missing.push(target);
      }
      if (missing.length) {
        Object.assign(unresolved, { [key]: missing });
        warn('unresolved-relation', 'Unresolved legacy relation: ' + key, 'warning', legacyId);
      }
    }
    if (Object.keys(unresolved).length) asset.legacyExtensions = { ...asset.legacyExtensions, unresolvedRelations: unresolved };
    const layer = layout.layer === 'background' || layout.layer === 'foreground' ? layout.layer : 'midground';
    const item: SceneLayout = {
      spriteId: asset.id, layer, depth: number(layout.depth) ?? (layer === 'background' ? 0.85 : layer === 'foreground' ? 0.15 : 0.5),
      parallax: number(layout.parallax) ?? (layer === 'background' ? 0.35 : layer === 'foreground' ? 1 : 0.7),
      zIndex: integer(layout.zIndex) ?? (rank.get(ordinal) ?? ordinal) * 10,
      visible: raw.visible !== false, locked: raw.locked === true,
      position: { x: bounds.x + dx, y: bounds.y + dy },
      transform: { scaleX: number(offset.scaleX) ?? 1, scaleY: number(offset.scaleY) ?? 1, rotation: number(offset.rotation) ?? 0 },
      sceneAnchor: { x: anchor.x + dx, y: anchor.y + dy },
      anchorSource: Object.hasOwn(raw, 'anchor') ? 'legacy-unknown' : 'defaulted',
      relations, revision: 1
    };
    project.sceneLayout.items[asset.id] = item;
    project.revisionLedger.entities['sceneItem:' + asset.id] = 1;
  }

  const normalizedNames = new Set([...declared].map(path => path.normalize('NFC')));
  for (const [path, blob] of files) {
    if (normalizedNames.has(path.normalize('NFC')) || !safeAssetPath(path) || !/^sprites\/[^/]+\.png$/i.test(path)) continue;
    if (!includeOrphans) {
      warn('orphan-png', 'Unreferenced PNG omitted from preview', 'warning', undefined, path);
      continue;
    }
    let raster;
    try { raster = await inspectRaster(blob); } catch { /* Corrupt orphan cannot be imported. */ }
    if (raster?.kind !== 'png') {
      warn('orphan-invalid', 'Unreferenced PNG could not be decoded', 'warning', undefined, path);
      continue;
    }
    await addRaster(path, blob, path.slice(8, -4), 'uncategorized');
    normalizedNames.add(path.normalize('NFC'));
    warn('orphan-imported', 'Retained PNG with unknown source rectangle', 'info', undefined, path);
  }
  const extra = extras(manifest, topKeys);
  const canvasExtras = extras(canvas, keysFor('width height coordinateOrigin units'));
  if (Object.keys(canvasExtras).length) extra.canvas = canvasExtras;
  if (!sourceId && manifest.source !== undefined) extra.unmappedSource = manifest.source;
  if (Object.keys(extra).length) {
    project.legacyExtensions = extra;
    warn('unknown-project-field', 'Unrecognized project fields preserved: ' + Object.keys(extra).join(', '), 'info');
  }
  project.migrationMetadata = {
    sourceFormat: ['spatial-scene-layout/v2'], migratedAt: new Date().toISOString(),
    adapterVersion: 'v9-scene/1', idMap, warnings
  };
  validateProject(project);
  return { project, binaries, report: { imported: project.assets.length, quarantined, warnings } };
}

// Persist only after the caller accepts the preview; the original ZIP is untouched.
export async function saveV9Migration(preview: Awaited<ReturnType<typeof previewV9Migration>>,
  store: Pick<ProjectStore, 'create' | 'createImportedProject' | 'stage'>) {
  const project = structuredClone(preview.project);
  const input = Array.from(preview.binaries, ([resourceId, bytes]) => ({ resourceId, revision: 1, bytes }));
  if (!input.length) {
    await store.create(project);
    return project.projectId;
  }
  const stage = await store.stage(project.projectId, input);
  await store.createImportedProject(project, stage.id);
  return project.projectId;
}
