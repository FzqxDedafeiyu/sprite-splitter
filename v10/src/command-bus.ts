import type { ProjectDocument, SpriteAsset } from './domain.ts';
import { entities, invariant, resources, sameValue } from './project.ts';
import { ConflictError, type CommitExpectation, type ProjectStore } from './project-store.ts';

export type ChangeSet = {
  readEntities: readonly string[];
  writeEntities: readonly string[];
  resources: readonly string[];
};
type Committed = { ok: true; commandId: string; affectedIds: string[]; projectRevision: number };
type Failed = { ok: false; commandId: string; affectedIds: string[]; projectRevision: number;
  error: { code: string; message: string; retryable: boolean; conflict?: { kind: ConflictError['kind']; target: string } } };
export type CommandResult = Committed | Failed;
type Operation = {
  affectedIds: readonly string[];
  changes: ChangeSet;
  rebase: 'never' | 'independent-absolute-sprite-fields';
  apply(document: ProjectDocument): void;
};
type Captured = {
  projectId: string;
  before: ProjectDocument;
  operation: Operation;
  expectation: CommitExpectation;
};

function captureExpectations(document: ProjectDocument, changes: ChangeSet): CommitExpectation {
  const entityMap = entities(document);
  const resourceMap = resources(document);
  return {
    projectRevision: document.revision,
    entities: Object.fromEntries([...new Set([...changes.readEntities, ...changes.writeEntities])].map(key => {
      const current = entityMap.get(key);
      return [key, current ? { state: 'present', revision: current.revision } : { state: 'absent' }];
    })),
    resources: Object.fromEntries([...new Set(changes.resources)].map(id => {
      const current = resourceMap.get(id)?.version;
      return [id, current
        ? { state: 'present', revision: current.revision, contentHash: current.contentHash }
        : { state: 'absent' }];
    }))
  };
}

type PropertyPatch = Partial<Pick<SpriteAsset, 'name' | 'category' | 'description' | 'groupName'>>;
const propertyNames = new Set(['name', 'category', 'description', 'groupName']);
const spriteKey = (id: string) => 'spriteAsset:' + id;

export class CommandBus {
  // The caller retains an opaque ID; the bus owns the snapshot and captured expectations.
  #plans = new Map<string, Captured>();
  #queue = Promise.resolve();

  constructor(private readonly persistence: ProjectStore,
    private readonly publish: (document: ProjectDocument) => void) {}

  prepareSpriteProperties(snapshot: ProjectDocument, changes: readonly { spriteId: string; patch: PropertyPatch }[]): string {
    const before = structuredClone(snapshot);
    const patches = new Map<string, PropertyPatch>();
    for (const { spriteId, patch } of changes) {
      invariant(!patches.has(spriteId), 'Duplicate sprite in property command: ' + spriteId);
      const entries = Object.entries(patch);
      invariant(entries.length && entries.every(([key, value]) => propertyNames.has(key) &&
        (typeof value === 'string' || (value === null && key === 'groupName'))), 'Invalid sprite property patch');
      invariant(before.assets.some(asset => asset.id === spriteId), 'Unknown sprite: ' + spriteId);
      patches.set(spriteId, { ...patch });
    }
    invariant(patches.size, 'Property command has no targets');
    const affectedIds = [...patches.keys()];
    const operation: Operation = {
      affectedIds,
      changes: { readEntities: [], writeEntities: affectedIds.map(spriteKey), resources: [] },
      rebase: 'independent-absolute-sprite-fields',
      apply(document) {
        let changed = false;
        document.assets = document.assets.map(sprite => {
          const patch = patches.get(sprite.id);
          if (!patch || sameValue(sprite, { ...sprite, ...patch })) return sprite;
          changed = true;
          const next = { ...sprite, ...patch, revision: sprite.revision + 1 };
          document.revisionLedger.entities[spriteKey(sprite.id)] = next.revision;
          return next;
        });
        invariant(changed, 'Property command would make no changes');
      }
    };
    const commandId = crypto.randomUUID();
    this.#plans.set(commandId, { projectId: before.projectId, before, operation,
      expectation: captureExpectations(before, operation.changes) });
    return commandId;
  }

  cancel(commandId: string): boolean { return this.#plans.delete(commandId); }

  async dispatch(commandId: string): Promise<CommandResult> {
    const plan = this.#plans.get(commandId);
    if (!plan) return { ok: false, commandId, affectedIds: [], projectRevision: 0,
      error: { code: 'unknown-command', message: 'Command was cancelled or already dispatched', retryable: false } };
    this.#plans.delete(commandId);
    const task = this.#queue.then(() => this.#execute(commandId, plan));
    this.#queue = task.then(() => {}, () => {});
    return task;
  }

  async #execute(commandId: string, plan: Captured): Promise<CommandResult> {
    const { operation, expectation, before, projectId } = plan;
    const affectedIds = [...operation.affectedIds];
    let observed = before.revision;
    const attempt = async (document: ProjectDocument, checks: CommitExpectation) => {
      const next = structuredClone(document);
      operation.apply(next);
      next.revision++;
      await this.persistence.commit(next, checks);
      return next;
    };
    let committed: ProjectDocument;
    try {
      try { committed = await attempt(before, expectation); }
      catch (error) {
        if (!(error instanceof ConflictError) || error.kind !== 'project-cas' || operation.rebase === 'never') throw error;
        const latest = await this.persistence.load(projectId);
        if (!latest) throw error;
        observed = latest.document.revision;
        const refreshed = captureExpectations(latest.document, operation.changes);
        if (!sameValue(expectation.entities, refreshed.entities) || !sameValue(expectation.resources, refreshed.resources)) {
          const changedEntity = Object.keys(expectation.entities).find(key =>
            !sameValue(expectation.entities[key], refreshed.entities[key]));
          if (changedEntity) throw new ConflictError('target-entity', changedEntity);
          const changedResource = Object.keys(expectation.resources).find(key =>
            !sameValue(expectation.resources[key], refreshed.resources[key]));
          throw new ConflictError('resource', changedResource!);
        }
        committed = await attempt(latest.document, refreshed);
      }
    } catch (error) {
      const conflict = error instanceof ConflictError ? { kind: error.kind, target: error.target } : undefined;
      return { ok: false, commandId, affectedIds, projectRevision: observed,
        error: { code: conflict?.kind ?? 'command-failed', message: String(error), retryable: false, conflict } };
    }
    // Publish only after the storage transaction completes. Publication errors are not storage rollbacks.
    this.publish(committed);
    return { ok: true, commandId, affectedIds, projectRevision: committed.revision };
  }
}
