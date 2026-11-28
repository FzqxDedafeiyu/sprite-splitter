import { SessionHistory, type HistoryDirection } from './session-history.ts';
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
  apply(document: ProjectDocument): PropertyHistory;
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

type PropertyChanges = Map<string, PropertyPatch>;
type PropertyHistory = { undo: PropertyChanges; redo: PropertyChanges };

function applyProperties(document: ProjectDocument, changes: PropertyChanges): PropertyHistory {
  const undo: PropertyChanges = new Map();
  const redo: PropertyChanges = new Map();
  document.assets = document.assets.map(sprite => {
    const patch = changes.get(sprite.id);
    if (!patch) return sprite;
    const next = { ...sprite };
    const previous: PropertyPatch = {};
    for (const key of Object.keys(patch) as Array<keyof PropertyPatch>) {
      Object.assign(previous, { [key]: sprite[key] });
      if (patch[key] === undefined) Reflect.deleteProperty(next, key);
      else Object.assign(next, { [key]: patch[key] });
    }
    if (sameValue(sprite, next)) return sprite;
    undo.set(sprite.id, previous);
    redo.set(sprite.id, patch);
    next.revision++;
    document.revisionLedger.entities[spriteKey(sprite.id)] = next.revision;
    return next;
  });
  invariant(undo.size, 'Property command would make no changes');
  return { undo, redo };
}

export class CommandBus {
  #history = new Map<string, SessionHistory<PropertyHistory>>();
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
      apply: document => applyProperties(document, patches)
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
    return this.#enqueue(() => this.#execute(commandId, plan));
  }

  undo(projectId: string): Promise<CommandResult> { return this.#enqueue(() => this.#restore(projectId, 'undo')); }
  redo(projectId: string): Promise<CommandResult> { return this.#enqueue(() => this.#restore(projectId, 'redo')); }

  #enqueue(task: () => Promise<CommandResult>) {
    const result = this.#queue.then(task);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  #historyFor(projectId: string) {
    let history = this.#history.get(projectId);
    if (!history) {
      history = new SessionHistory<PropertyHistory>();
      this.#history.set(projectId, history);
    }
    return history;
  }

  async #restore(projectId: string, direction: HistoryDirection): Promise<CommandResult> {
    const commandId = crypto.randomUUID();
    const history = this.#history.get(projectId);
    const entry = history?.peek(direction);
    const changes = entry?.change[direction];
    const affectedIds = [...(changes?.keys() ?? [])];
    let attempts = 0;
    let document: ProjectDocument;
    try {
      invariant(history && entry && changes, 'No history entry');
      const snapshot = await this.persistence.load(projectId);
      invariant(snapshot, 'Project no longer exists');
      document = snapshot.document;
      if (document.revision !== entry.revision) throw new ConflictError('project-cas', projectId);
      const checks = captureExpectations(document, { readEntities: [], writeEntities: affectedIds.map(spriteKey), resources: [] });
      applyProperties(document, changes);
      document.revision++;
      attempts++;
      await this.persistence.commit(document, checks);
      history.complete(direction, document.revision);
    } catch (error) {
      const conflict = error instanceof ConflictError ? { kind: error.kind, target: error.target } : undefined;
      return { ok: false, commandId, affectedIds, baseRevision: entry?.revision ?? null,
        attemptedRevision: attempts ? entry!.revision : null, attempts,
        error: { code: conflict?.kind ?? (entry ? 'history-failed' : 'empty-history'),
          message: conflict ? 'Project changed after this history entry. Reload and review the current state.' :
            entry ? 'History update did not complete.' : 'There is no history entry to apply.',
          retryable: false, cause: String(error), conflict } };
    }
    return this.#publish(commandId, affectedIds, document);
  }

  async #execute(commandId: string, plan: Captured): Promise<CommandResult> {
    const { operation, expectation, projectId } = plan;
    const affectedIds = [...operation.affectedIds];
    let attemptedRevision: number | null = null;
    let attempts = 0;
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
        }
        const history = operation.apply(next);
        next.revision++;
        try {
          attempts++;
          attemptedRevision = checks.projectRevision;
          await this.persistence.commit(next, checks);
          this.#historyFor(projectId).record(history, checks.projectRevision, next.revision);
          committed = next;
          break;
        } catch (error) {
          if (!(error instanceof ConflictError) || error.kind !== 'project-cas' ||
              attempts >= 2 || operation.rebase === 'never') throw error;
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
    return this.#publish(commandId, affectedIds, committed);
  }

  #publish(commandId: string, affectedIds: string[], committed: ProjectDocument): Committed {
    const result: Committed = { ok: true, commandId, affectedIds, projectRevision: committed.revision };
    try { this.publish(committed); }
    catch (error) { result.publishError = String(error); }
    return result;
  }
}
