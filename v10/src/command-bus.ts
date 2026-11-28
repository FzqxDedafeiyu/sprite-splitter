import type { ProjectDocument, SpriteAsset } from './domain.ts';
import { entities, invariant, resources, sameValue } from './project.ts';
import { ConflictError, type CommitExpectation, type ProjectStore } from './project-store.ts';

export type ChangeSet = {
  readEntities: readonly string[];
  writeEntities: readonly string[];
  resources: readonly string[];
};
type Committed = { ok: true; commandId: string; affectedIds: string[]; projectRevision: number; publishError?: string };
type Failed = { ok: false; commandId: string; affectedIds: string[]; baseRevision: number | null; attemptedRevision: number | null; attempts: number;
  error: { code: string; message: string; retryable: boolean; cause?: string; conflict?: { kind: ConflictError['kind']; target: string } } };
export type CommandResult = Committed | Failed;
type Operation = {
  affectedIds: readonly string[];
  changes: ChangeSet;
  rebase: 'never' | 'independent-absolute-sprite-fields';
  apply(document: ProjectDocument): void;
};
type Captured = {
  projectId: string;
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
  // The caller retains an opaque ID; the bus owns only the patch and captured expectations.
  #plans = new Map<string, Captured>();
  #queue = Promise.resolve();

  constructor(private readonly persistence: Pick<ProjectStore, 'load' | 'commit'>,
    private readonly publish: (document: ProjectDocument) => void) {}

  prepareSpriteProperties(snapshot: ProjectDocument, changes: readonly { spriteId: string; patch: PropertyPatch }[]): string {
    invariant(this.#plans.size < 128, 'Too many pending commands');
    const patches = new Map<string, PropertyPatch>();
    for (const { spriteId, patch } of changes) {
      invariant(!patches.has(spriteId), 'Duplicate sprite in property command: ' + spriteId);
      const entries = Object.entries(patch);
      invariant(entries.length && entries.every(([key, value]) => propertyNames.has(key) &&
        (typeof value === 'string' || (value === null && key === 'groupName'))), 'Invalid sprite property patch');
      invariant(snapshot.assets.some(asset => asset.id === spriteId), 'Unknown sprite: ' + spriteId);
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
    this.#plans.set(commandId, { projectId: snapshot.projectId, operation,
      expectation: captureExpectations(snapshot, operation.changes) });
    return commandId;
  }

  cancel(commandId: string): boolean { return this.#plans.delete(commandId); }

  async dispatch(commandId: string): Promise<CommandResult> {
    const plan = this.#plans.get(commandId);
    if (!plan) return { ok: false, commandId, affectedIds: [], baseRevision: null, attemptedRevision: null, attempts: 0,
      error: { code: 'unknown-command', message: 'Command was cancelled or already dispatched', retryable: false } };
    this.#plans.delete(commandId);
    const task = this.#queue.then(() => this.#execute(commandId, plan));
    this.#queue = task.then(() => {}, () => {});
    return task;
  }

  async #execute(commandId: string, plan: Captured): Promise<CommandResult> {
    const { operation, expectation, projectId } = plan;
    const affectedIds = [...operation.affectedIds];
    let attemptedRevision: number | null = null;
    let attempts = 0;
    let rebased = false;
    let committed: ProjectDocument;
    try {
      while (true) {
        const loaded = await this.persistence.load(projectId);
        invariant(loaded, 'Project no longer exists');
        const next = loaded.document;
        const checks = captureExpectations(next, operation.changes);
        for (const [key, expected] of Object.entries(expectation.entities)) {
          if (!sameValue(expected, checks.entities[key])) throw new ConflictError('target-entity', key);
        }
        for (const [id, expected] of Object.entries(expectation.resources)) {
          if (!sameValue(expected, checks.resources[id])) throw new ConflictError('resource', id);
        }
        if (next.revision !== expectation.projectRevision) {
          if (operation.rebase === 'never') throw new ConflictError('project-cas', projectId);
          rebased = true;
        }
        operation.apply(next);
        next.revision++;
        try {
          attempts++;
          attemptedRevision = checks.projectRevision;
          await this.persistence.commit(next, checks);
          committed = next;
          break;
        } catch (error) {
          if (!(error instanceof ConflictError) || error.kind !== 'project-cas' ||
              rebased || operation.rebase === 'never') throw error;
          rebased = true;
        }
      }
    } catch (error) {
      const conflict = error instanceof ConflictError ? { kind: error.kind, target: error.target } : undefined;
      const code = conflict?.kind ?? 'command-failed';
      const message = {
        'project-cas': attempts === 2 ? 'Project changed again. Reload and prepare a new command.' :
          'Project changed. Reload and prepare a new command.',
        'target-entity': 'A target changed. Review it before preparing a new command.',
        resource: 'A resource changed. Reload it before preparing a new command.',
        'command-failed': 'Command could not be completed.'
      }[code];
      return { ok: false, commandId, affectedIds, baseRevision: expectation.projectRevision, attemptedRevision, attempts,
        error: { code, message, cause: String(error), retryable: code === 'project-cas', conflict } };
    }
    const result: Committed = { ok: true, commandId, affectedIds, projectRevision: committed.revision };
    try { this.publish(committed); }
    catch (error) { result.publishError = String(error); }
    return result;
  }
}
