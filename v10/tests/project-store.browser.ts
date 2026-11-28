import { CommandBus } from '../src/command-bus.ts';
import type { ProjectDocument, RasterRef } from '../src/domain.ts';
import { createProject, safeAssetPath } from '../src/project.ts';
import { ConflictError, ProjectStore } from '../src/project-store.ts';
import { decodeMask, effectiveAlpha, encodeMask, remapMask } from '../src/mask.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual));
  }
}
async function rejects(operation: Promise<unknown>, predicate: (error: unknown) => boolean) {
  try { await operation; }
  catch (error) { if (predicate(error)) return; throw error; }
  throw new Error('Expected rejection');
}

async function png(): Promise<Blob> {
  const canvas = new OffscreenCanvas(2, 2);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#09f';
  context.fillRect(0, 0, 2, 2);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function run() {
  const db = 'sprite-v10-test-' + crypto.randomUUID();
  let first = await ProjectStore.open(db);
  const second = await ProjectStore.open(db);
  try {
    const blank = createProject();
    const { projectId } = blank;
    await first.create(blank);
    await rejects(second.create(blank), error => error instanceof ConflictError && error.kind === 'project-cas');
    const id = crypto.randomUUID();
    const resourceId = crypto.randomUUID();
    const maskId = crypto.randomUUID();
    const pixels = await png();
    const samples = [255, 128, 0, 64];
    const maskBytes = encodeMask(2, 2, Uint8Array.from(samples));
    const stage = await first.stage(projectId, [
      { resourceId, revision: 1, bytes: pixels },
      { resourceId: maskId, revision: 1, bytes: maskBytes }
    ]);
    equal((await second.load(projectId))?.document.revision, 1);
    const [rasterResource, maskVersion] = stage.versions;
    const mask: RasterRef = { ...maskVersion, kind: 'mask', coordinateSpace: 'spriteLocal',
      encoding: 'bitmap', width: 2, height: 2, assetRef: 'masks/角色.ssm' };
    const spriteKey = 'spriteAsset:' + id;
    const added: ProjectDocument = structuredClone(blank);
    added.revision++;
    added.assets.push({ id, revision: 1, contentVersion: 1, legacyId: 'sprite_001', name: '角色',
      category: 'character', rasterResource, mask, assetRef: 'sprites/角色.png', sourceRectStatus: 'unknown',
      shape: 'rectangle', legacyExtensions: { sourceHint: ['kept'] } });
    added.revisionLedger.entities[spriteKey] = 1;
    added.revisionLedger.resources = { [resourceId]: 1, [maskId]: 1 };
    await first.commit(added, { projectRevision: 1, entities: { [spriteKey]: { state: 'absent' } },
      resources: { [resourceId]: { state: 'absent' }, [maskId]: { state: 'absent' } } }, stage.id);
    first.close();
    first = await ProjectStore.open(db);
    const reopened = (await first.load(projectId))!;
    equal(reopened.document.assets, added.assets);
    equal(Array.from((await decodeMask(reopened.bytes.get(maskId)!)).samples), samples);
    equal(Array.from(effectiveAlpha(new Uint8Array([128, 128, 128, 128]), Uint8Array.from(samples))),
      [128, 64, 0, 32]);

    equal(Array.from(remapMask(Uint8Array.from(samples), { x: 3, y: 5, width: 2, height: 2 },
      { x: 4, y: 4, width: 2, height: 3 })), [255, 255, 128, 255, 64, 255]);

    const broken = await first.stage(projectId, [
      { resourceId: maskId, revision: 2, bytes: encodeMask(1, 1, new Uint8Array([255])) }
    ]);
    const invalid = structuredClone(added);
    invalid.revision++;
    invalid.assets[0].revision++;
    invalid.assets[0].contentVersion++;
    invalid.assets[0].mask = { ...mask, ...broken.versions[0] };
    invalid.revisionLedger.entities[spriteKey] = 2;
    invalid.revisionLedger.resources[maskId] = 2;
    const updateExpectation = { projectRevision: 2, entities: { [spriteKey]: { state: 'present' as const, revision: 1 } },
      resources: { [maskId]: { state: 'present' as const, revision: 1, contentHash: mask.contentHash } } };
    await rejects(first.commit(invalid, updateExpectation, broken.id), error => String(error).includes('Mask dimensions'));
    equal((await first.load(projectId))?.document.revision, 2);
    await rejects(first.commit(invalid, updateExpectation, broken.id), error =>
      error instanceof ConflictError && error.kind === 'resource');

    const fixed = await first.stage(projectId, [
      { resourceId: maskId, revision: 2, bytes: encodeMask(2, 2, new Uint8Array([0, 1, 2, 3])) }
    ]);
    const updated = structuredClone(invalid);
    updated.assets[0].mask = { ...mask, ...fixed.versions[0] };
    await first.commit(updated, updateExpectation, fixed.id);
    equal((await second.load(projectId))?.document.revisionLedger.resources[maskId], 2);
    await rejects(second.commit(updated, updateExpectation), error =>
      error instanceof ConflictError && error.kind === 'target-entity');
    await rejects(second.commit(updated, { ...updateExpectation, entities: {} }), error =>
      error instanceof ConflictError && error.kind === 'resource');

    const settingsKey = 'projectSettings:' + projectId;
    const settings = (fps: number) => {
      const value = structuredClone(updated);
      value.revision++;
      value.projectSettings.revision++;
      value.projectSettings.defaultFps = fps;
      value.revisionLedger.entities[settingsKey] = 2;
      return value;
    };
    const expected = { projectRevision: 3, entities: {}, resources: {} };
    const race = await Promise.allSettled([
      first.commit(settings(18), { ...expected, entities: { [settingsKey]: { state: 'present', revision: 1 } } }),
      second.commit({ ...updated, revision: 4, legacyExtensions: { flag: true } }, expected)
    ]);
    equal(race.filter(value => value.status === 'fulfilled').length, 1);
    const rejected = race.find(value => value.status === 'rejected');
    equal(rejected?.status === 'rejected' && rejected.reason.kind, 'project-cas');

    const latest = (await first.load(projectId))!.document;
    const deleted = structuredClone(latest);
    deleted.revision++;
    deleted.assets = [];
    deleted.revisionLedger.entities[spriteKey] = 3;
    deleted.revisionLedger.resources[resourceId] = 2;
    deleted.revisionLedger.resources[maskId] = 3;
    await first.commit(deleted, { projectRevision: latest.revision, entities: {
      [spriteKey]: { state: 'present', revision: 2 }
    }, resources: {
      [resourceId]: { state: 'present', revision: 1, contentHash: rasterResource.contentHash },
      [maskId]: { state: 'present', revision: 2, contentHash: fixed.versions[0].contentHash }
    } });
    const afterDelete = (await second.load(projectId))!;
    equal(afterDelete.document.revisionLedger.entities[spriteKey], 3);
    equal(afterDelete.document.revisionLedger.resources[maskId], 3);
    equal(afterDelete.bytes.size, 0);
    await rejects(first.commit({ ...deleted, revision: deleted.revision + 1 }, {
      projectRevision: deleted.revision, entities: { [spriteKey]: { state: 'absent' } }, resources: {}
    }), error => error instanceof ConflictError && error.kind === 'target-entity');
    await first.stage(projectId, [{ resourceId: crypto.randomUUID(), revision: 1, bytes: pixels }]);
    equal(await first.collectExpiredStages(Date.now() + 24 * 60 * 60 * 1000), 1);
    equal(await first.collectExpiredStages(Date.now() + 24 * 60 * 60 * 1000), 0);
    equal(['../a', '/a', 'a/%2e%2e/b', 'C:/a', 'sprites/角色.png'].map(safeAssetPath),
      [false, false, false, false, true]);

    const opening = indexedDB.open(db);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      const tx = raw.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({ ...updated, revision: deleted.revision }, projectId);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const missing = raw.transaction('resources', 'readwrite');
      missing.objectStore('resources').delete([projectId, maskId, 2]);
      await new Promise<void>((resolve, reject) => {
        missing.oncomplete = () => resolve();
        missing.onabort = () => reject(missing.error);
      });
      await rejects(first.load(projectId), error => String(error).includes('Missing or damaged resource'));
    } finally { raw.close(); }

    return { createReopen: 'pass', maskAndPng: 'pass', rollback: 'pass', conflictTypes: 3,
      tombstones: 'pass', expiredStaging: 'pass', missingResource: 'pass', pathSafety: 'pass' };
  } finally {
    first.close();
    second.close();
    indexedDB.deleteDatabase(db);
  }
}

async function commandTests() {
  const db = 'sprite-v10-commands-' + crypto.randomUUID();
  const persistence = await ProjectStore.open(db);
  try {
    const blank = createProject();
    await persistence.create(blank);
    const id = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const resourceId = crypto.randomUUID();
    const staged = await persistence.stage(blank.projectId, [{ resourceId, revision: 1, bytes: await png() }]);
    const [rasterResource] = staged.versions;
    const project = structuredClone(blank);
    project.revision = 2;
    const ids = [id, secondId];
    project.assets = ids.map((spriteId, index) => ({
      id: spriteId, name: '旧名称 ' + index, category: 'prop', sourceRectStatus: 'unknown', shape: 'rectangle',
      assetRef: 'sprites/shared.png', rasterResource, contentVersion: 1, revision: 1
    }));
    const keys = ids.map(spriteId => 'spriteAsset:' + spriteId);
    for (const key of keys) project.revisionLedger.entities[key] = 1;
    project.revisionLedger.resources[resourceId] = 1;
    await persistence.commit(project, { projectRevision: 1, entities: {
      [keys[0]]: { state: 'absent' }, [keys[1]]: { state: 'absent' }
    }, resources: { [resourceId]: { state: 'absent' } } }, staged.id);

    const published: Array<{ revision: number; names: string[] }> = [];
    const bus = new CommandBus(persistence, document =>
      published.push({ revision: document.revision, names: document.assets.map(sprite => sprite.name) }));
    const batch = bus.prepareSpriteProperties(project, [
      { spriteId: id, patch: { name: '中文名 A' } }, { spriteId: secondId, patch: { name: '中文名 B' } }
    ]);
    const conflicting = bus.prepareSpriteProperties(project, [
      { spriteId: id, patch: { name: '过期值' } }, { spriteId: secondId, patch: { name: '整批不得写入' } }
    ]);
    const unrelated = structuredClone(project);
    unrelated.revision++;
    unrelated.legacyExtensions = { unrelated: true };
    await persistence.commit(unrelated, { projectRevision: 2, entities: {}, resources: {} });
    const success = await bus.dispatch(batch);
    equal(success.ok && success.projectRevision, 4);
    const result = await bus.dispatch(conflicting);
    equal(!result.ok && result.error.conflict?.kind, 'target-entity');
    const replay = await bus.dispatch(batch);
    equal(!replay.ok && replay.error.code, 'unknown-command');
    equal((await persistence.load(project.projectId))?.document.legacyExtensions, { unrelated: true });
    equal(published, [{ revision: 4, names: ['中文名 A', '中文名 B'] }]);
    const latest = (await persistence.load(project.projectId))!.document;
    const noOp = await bus.dispatch(bus.prepareSpriteProperties(latest, [{ spriteId: id, patch: { name: '中文名 A' } }]));
    equal(noOp.ok, false);
    equal((await persistence.load(project.projectId))?.document.revision, 4);
    return { atomicBatch: 'pass', safeRebase: 'pass', staleConflict: 'pass', duplicateDispatch: 'pass', noOp: 'pass' };
  } finally { persistence.close(); indexedDB.deleteDatabase(db); }
}

Promise.all([run(), commandTests()]).then(([fixture, commands]) => {
  const value = { ...fixture, commands };
  document.querySelector('#result')!.textContent = JSON.stringify(value); },
  error => { document.querySelector('#result')!.textContent = JSON.stringify({ test: { error: String(error.stack ?? error) } }); });
