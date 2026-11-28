import type { ProjectDocument, ResourceVersion } from './domain.ts';
import { entities, invariant, resources, sameValue, validateProject } from './project.ts';
import { inspectRaster } from './mask.ts';

type Expectation = { state: 'absent' } | { state: 'present'; revision: number };
type ResourceExpectation = { state: 'absent' } | { state: 'tombstone'; revision: number } |
  { state: 'present'; revision: number; contentHash: string };
export type CommitExpectation = {
  projectRevision: number;
  entities: Record<string, Expectation>;
  resources: Record<string, ResourceExpectation>;
};
export class ConflictError extends Error {
  constructor(readonly kind: 'target-entity' | 'resource' | 'project-cas', readonly target: string) {
    super(kind + ': ' + target);
  }
}
type StagedInput = { resourceId: string; revision: number; bytes: Blob };
type StoredResource = { version: ResourceVersion; bytes: Blob; raster?: Awaited<ReturnType<typeof inspectRaster>> };
type Stage = { id: string; projectId: string; createdAt: number; records: StoredResource[] };
const lifetime = 24 * 60 * 60 * 1000;

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function settled(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
  });
}

async function atomic<T>(transaction: IDBTransaction, run: () => Promise<T>): Promise<T> {
  const completion = settled(transaction);
  try {
    const value = await run();
    await completion;
    return value;
  } catch (error) {
    try { transaction.abort(); } catch { /* Transaction already ended. */ }
    await completion.catch(() => {});
    throw error;
  }
}

export async function resourceHash(bytes: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer());
  return 'sha256:' + Array.from(new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

function resourceKey(projectId: string, version: ResourceVersion): IDBValidKey {
  return [projectId, version.resourceId, version.revision];
}

function checkExpectations(document: ProjectDocument, expected: CommitExpectation) {
  const liveEntities = entities(document);
  const liveResources = resources(document);
  for (const [key, value] of Object.entries(expected.entities)) {
    const current = liveEntities.get(key);
    if (value.state === 'absent' ? Object.hasOwn(document.revisionLedger.entities, key) :
      current?.revision !== value.revision) throw new ConflictError('target-entity', key);
  }
  for (const [id, value] of Object.entries(expected.resources)) {
    const current = liveResources.get(id)?.version;
    const watermark = document.revisionLedger.resources[id];
    if (value.state === 'absent' ? watermark !== undefined :
      value.state === 'tombstone' ? current !== undefined || watermark !== value.revision :
      current?.revision !== value.revision || current.contentHash !== value.contentHash) {
      throw new ConflictError('resource', id);
    }
  }
  if (document.revision !== expected.projectRevision) throw new ConflictError('project-cas', document.projectId);
}

function checkTransition(current: ProjectDocument, next: ProjectDocument, expected: CommitExpectation) {
  const oldEntities = entities(current);
  const newEntities = entities(next);
  const oldResources = resources(current);
  const newResources = resources(next);
  invariant(next.revision === current.revision + 1, 'Project revision must advance by one');
  const entityLedger = { ...current.revisionLedger.entities };
  const resourceLedger = { ...current.revisionLedger.resources };
  for (const key of new Set([...oldEntities.keys(), ...newEntities.keys()])) {
    const before = oldEntities.get(key);
    const after = newEntities.get(key);
    const changed = !sameValue(before && { ...before, revision: 0 }, after && { ...after, revision: 0 });
    if (changed) invariant(Object.hasOwn(expected.entities, key), 'Missing entity expectation: ' + key);
    if (!after) {
      entityLedger[key] = before!.revision + 1;
      continue;
    }
    const revision = before ? before.revision + Number(changed) : 1;
    invariant((before || !Object.hasOwn(entityLedger, key)) && after.revision === revision,
      'Unexpected entity revision or reused ID: ' + key);
    entityLedger[key] = revision;
  }
  const newVersions: ResourceVersion[] = [];
  for (const id of new Set([...oldResources.keys(), ...newResources.keys()])) {
    const before = oldResources.get(id)?.version;
    const after = newResources.get(id)?.version;
    const changed = before?.contentHash !== after?.contentHash;
    if (changed) invariant(Object.hasOwn(expected.resources, id), 'Missing resource expectation: ' + id);
    if (!after) {
      resourceLedger[id] = before!.revision + 1;
      continue;
    }
    const restoration = expected.resources[id];
    const restoring = !before && restoration?.state === 'tombstone';
    const revision = before ? before.revision + Number(changed) : restoring ? restoration.revision + 1 : 1;
    invariant((before || restoring || !Object.hasOwn(resourceLedger, id)) && after.revision === revision &&
      (changed || sameValue(before, after)), 'Unexpected resource version or reused ID: ' + id);
    if (changed) newVersions.push(after);
    resourceLedger[id] = revision;
  }
  invariant(sameValue(next.revisionLedger, { entities: entityLedger, resources: resourceLedger }),
    'Revision ledger must retain tombstones and track current versions');
  const previousSprites = new Map(current.assets.map(asset => [asset.id, asset]));
  for (const asset of next.assets) {
    const before = previousSprites.get(asset.id);
    const pixelState = (sprite: typeof asset) => [
      sprite.rasterResource.contentHash, sprite.mask?.contentHash, sprite.sourceRect,
      sprite.sourceRectStatus, sprite.shape, sprite.points
    ];
    const revision = before
      ? before.contentVersion + Number(!sameValue(pixelState(before), pixelState(asset)))
      : 1;
    invariant(asset.contentVersion === revision, 'Unexpected sprite content version: ' + asset.id);
  }
  return newVersions;
}

export class ProjectStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(name = 'sprite-splitter-v10', factory = indexedDB) {
    const opening = factory.open(name, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('projects');
      opening.result.createObjectStore('resources');
      opening.result.createObjectStore('staging', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
    };
    const database = await result(opening);
    database.onversionchange = () => database.close();
    return new ProjectStore(database);
  }

  close(): void { this.database.close(); }

  async create(document: ProjectDocument) {
    const snapshot = structuredClone(document);
    validateProject(snapshot);
    invariant(snapshot.revision === 1 && resources(snapshot).size === 0, 'New projects must start without binary resources');
    const tx = this.database.transaction('projects', 'readwrite');
    await atomic(tx, async () => {
      const projects = tx.objectStore('projects');
      if (await result(projects.getKey(snapshot.projectId)) !== undefined) {
        throw new ConflictError('project-cas', snapshot.projectId);
      }
      await result(projects.add(snapshot, snapshot.projectId));
    });
  }

  async load(projectId: string) {
    const tx = this.database.transaction(['projects', 'resources'], 'readonly');
    const snapshot = await atomic(tx, async () => {
      const document = await result<ProjectDocument | undefined>(tx.objectStore('projects').get(projectId));
      if (!document) return undefined;
      validateProject(document);
      const records = await Promise.all(Array.from(resources(document).values(), async ({ version }) => ({
        version,
        stored: await result<StoredResource | undefined>(tx.objectStore('resources').get(resourceKey(projectId, version)))
      })));
      return { document, records };
    });
    if (!snapshot) return undefined;
    const bytes = new Map<string, Blob>();
    for (const { version, stored } of snapshot.records) {
      invariant(stored && sameValue(stored.version, version) && stored.bytes.size === version.byteLength &&
        await resourceHash(stored.bytes) === version.contentHash, 'Missing or damaged resource: ' + version.resourceId);
      bytes.set(version.resourceId, stored.bytes);
    }
    return { document: snapshot.document, bytes };
  }

  async stage(projectId: string, input: readonly StagedInput[]) {
    const records = await Promise.all(input.map(async ({ resourceId, revision, bytes }) => ({
      version: { resourceId, revision, byteLength: bytes.size, contentHash: await resourceHash(bytes) },
      bytes, raster: await inspectRaster(bytes)
    })));
    invariant(records.length > 0 && new Set(records.map(({ version }) => version.resourceId)).size === records.length,
      'Staging requires unique resources');
    const id = crypto.randomUUID();
    const stage: Stage = { id, projectId, createdAt: Date.now(), records };
    const tx = this.database.transaction('staging', 'readwrite');
    await atomic(tx, async () => { await result(tx.objectStore('staging').add(stage)); });
    return { id, versions: records.map(({ version }) => version) };
  }

  async commit(document: ProjectDocument, expectation: CommitExpectation, stageId?: string) {
    const next = structuredClone(document);
    const expected = structuredClone(expectation);
    try {
      validateProject(next);
      const tx = this.database.transaction(['projects', 'resources', 'staging'], 'readwrite');
      await atomic(tx, async () => {
        const projects = tx.objectStore('projects');
        const staging = tx.objectStore('staging');
        const current = await result<ProjectDocument | undefined>(projects.get(next.projectId));
        if (!current) throw new ConflictError('project-cas', next.projectId);
        validateProject(current);
        checkExpectations(current, expected);
        const versions = checkTransition(current, next, expected);
        const stage = stageId && await result<Stage | undefined>(staging.get(stageId));
        if (stageId && (!stage || stage.projectId !== next.projectId || Date.now() - stage.createdAt >= lifetime)) {
          throw new ConflictError('resource', stageId);
        }
        const records = stage ? stage.records : [];
        if (records.length !== versions.length) throw new ConflictError('resource', stageId ?? 'missing stage');
        const byId = new Map(records.map(record => [record.version.resourceId, record]));
        for (const version of versions) {
          const record = byId.get(version.resourceId);
          if (!record || !sameValue(record.version, version) || record.bytes.size !== version.byteLength) {
            throw new ConflictError('resource', version.resourceId);
          }
          const binary = tx.objectStore('resources');
          const restore = expected.resources[version.resourceId];
          if (restore?.state === 'tombstone') {
            const previous = await result<StoredResource | undefined>(binary.get([
              next.projectId, version.resourceId, restore.revision - 1
            ]));
            if (record.raster?.kind !== 'mask' || previous?.raster?.kind !== 'mask' ||
                previous.version.contentHash !== version.contentHash || previous.version.byteLength !== version.byteLength) {
              throw new ConflictError('resource', version.resourceId);
            }
          }
          await result(binary.add(record, resourceKey(next.projectId, version)));
        }
        const binary = tx.objectStore('resources');
        for (const sprite of next.assets) {
          const png = await result<StoredResource | undefined>(binary.get(resourceKey(next.projectId, sprite.rasterResource)));
          invariant(png?.raster?.kind === 'png', 'Missing or invalid sprite PNG: ' + sprite.id);
          if (sprite.mask) {
            const mask = await result<StoredResource | undefined>(binary.get(resourceKey(next.projectId, sprite.mask)));
            invariant(sprite.mask.encoding === 'bitmap' && mask?.raster?.kind === 'mask' &&
              mask.raster.width === sprite.mask.width && mask.raster.height === sprite.mask.height &&
              mask.raster.width === png.raster.width && mask.raster.height === png.raster.height,
              'Mask dimensions or encoding do not match sprite PNG: ' + sprite.id);
          }
        }
        await result(projects.put(next, next.projectId));
        if (stageId) await result(staging.delete(stageId));
      });
    } catch (error) {
      if (stageId) {
        try { await this.discardStage(next.projectId, stageId); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Commit and staging cleanup failed'); }
      }
      throw error;
    }
  }

  private async discardStage(projectId: string, id: string) {
    const tx = this.database.transaction('staging', 'readwrite');
    await atomic(tx, async () => {
      const staging = tx.objectStore('staging');
      const stage = await result<Stage | undefined>(staging.get(id));
      if (stage?.projectId === projectId) await result(staging.delete(id));
    });
  }

  async collectExpiredStages(now = Date.now()): Promise<number> {
    const tx = this.database.transaction('staging', 'readwrite');
    return atomic(tx, async () => {
      const staging = tx.objectStore('staging');
      const expired = await result(staging.index('createdAt').getAllKeys(IDBKeyRange.upperBound(now - lifetime)));
      await Promise.all(expired.map(id => result(staging.delete(id))));
      return expired.length;
    });
  }
}
