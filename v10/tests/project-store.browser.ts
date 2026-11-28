import { trimProjectHistory } from '../src/project-retention.ts';
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
    const publicationBus = new CommandBus(persistence, () => { throw new Error('subscriber failed'); });
    const afterPublish = await publicationBus.dispatch(publicationBus.prepareSpriteProperties(latest, [
      { spriteId: id, patch: { name: '已持久化' } }
    ]));
    equal(afterPublish.ok && Boolean(afterPublish.publishError), true);
    const stable = (await persistence.load(project.projectId))!.document;
    equal(stable.assets[0].name, '已持久化');
    let races = 0;
    const racing = new CommandBus({
      load: projectId => persistence.load(projectId),
      async commit(next, expectation) {
        races++;
        const current = (await persistence.load(next.projectId))!.document;
        current.revision++;
        current.legacyExtensions = { race: races };
        await persistence.commit(current, { projectRevision: current.revision - 1, entities: {}, resources: {} });
        return persistence.commit(next, expectation);
      }
    }, () => { throw new Error('Conflict must not publish'); });
    const race = await racing.dispatch(racing.prepareSpriteProperties(stable, [{ spriteId: id, patch: { name: '不可覆盖' } }]));
    equal(races, 2);
    equal(!race.ok && [race.error.code, race.error.retryable, race.baseRevision, race.attemptedRevision, race.attempts],
      ['project-cas', true, 5, 6, 2]);
    equal((await persistence.load(project.projectId))?.document.assets[0].name, '已持久化');

    const staleBase = (await persistence.load(project.projectId))!.document;
    const staleBatch = bus.prepareSpriteProperties(staleBase, [
      { spriteId: id, patch: { name: '拒绝 A' } }, { spriteId: secondId, patch: { name: '拒绝 B' } }
    ]);
    const other = new CommandBus(persistence, () => {});
    const external = await other.dispatch(other.prepareSpriteProperties(staleBase, [{ spriteId: id, patch: { name: '另一标签页' } }]));
    equal(external.ok, true);
    const onlyFirstStale = await bus.dispatch(staleBatch);
    equal(!onlyFirstStale.ok && onlyFirstStale.error.conflict?.target, keys[0]);
    const final = (await persistence.load(project.projectId))!.document;
    equal(final.assets.map(asset => asset.name), ['另一标签页', '中文名 B']);
    equal(final.revision, staleBase.revision + 1);
    const beforeRetry = (await persistence.load(project.projectId))!.document;
    const fresh = structuredClone(beforeRetry);
    fresh.revision++;
    fresh.legacyExtensions = { advance: 'before first attempt' };
    await persistence.commit(fresh, { projectRevision: beforeRetry.revision, entities: {}, resources: {} });
    let attempts = 0;
    const succeedsOnRetry = new CommandBus({
      load: projectId => persistence.load(projectId),
      async commit(next, expectation) {
        if (++attempts === 1) {
          const current = (await persistence.load(project.projectId))!.document;
          current.revision++;
          current.legacyExtensions = { advance: 'during first attempt' };
          await persistence.commit(current, { projectRevision: current.revision - 1, entities: {}, resources: {} });
        }
        await persistence.commit(next, expectation);
      }
    }, () => {});
    const retried = await succeedsOnRetry.dispatch(succeedsOnRetry.prepareSpriteProperties(beforeRetry, [
      { spriteId: secondId, patch: { name: '重试成功' } }
    ]));
    equal([retried.ok, attempts], [true, 2]);
    equal((await persistence.load(project.projectId))?.document.assets[1].name, '重试成功');

    const prepare = () => bus.prepareSpriteProperties(beforeRetry, [{ spriteId: id, patch: { name: '草稿' } }]);
    const pending = Array.from({ length: 128 }, prepare);
    let rejectedAtCap = false;
    try { prepare(); } catch (error) { rejectedAtCap = String(error).includes('Too many pending commands'); }
    equal(rejectedAtCap, true);
    equal(bus.cancel(pending[0]), true);
    equal(bus.cancel(prepare()), true);
    pending.slice(1).forEach(command => bus.cancel(command));
    const historyBus = new CommandBus(persistence, () => {});
    const historyBase = (await persistence.load(project.projectId))!.document;
    const apply = async (snapshot: ProjectDocument, patch: { name?: string; description?: string }) =>
      historyBus.dispatch(historyBus.prepareSpriteProperties(snapshot, [{ spriteId: id, patch }]));
    equal((await apply(historyBase, { description: '临时说明' })).ok, true);
    const afterFirst = (await persistence.load(project.projectId))!.document;
    equal((await apply(afterFirst, { name: '历史名称' })).ok, true);
    equal((await historyBus.undo(project.projectId)).ok, true);
    equal((await historyBus.undo(project.projectId)).ok, true);
    const undone = (await persistence.load(project.projectId))!.document;
    equal(undone.assets[0].name, historyBase.assets[0].name);
    equal(Object.hasOwn(undone.assets[0], 'description'), false);
    equal(undone.assets[0].revision, historyBase.assets[0].revision + 4);
    equal((await historyBus.redo(project.projectId)).ok, true);
    equal((await historyBus.redo(project.projectId)).ok, true);
    const redone = (await persistence.load(project.projectId))!.document;
    equal([redone.assets[0].name, redone.assets[0].description], ['历史名称', '临时说明']);
    equal(redone.assets[0].revision, historyBase.assets[0].revision + 6);
    const changedOutside = structuredClone(redone);
    changedOutside.revision++;
    changedOutside.legacyExtensions = { outside: true };
    await persistence.commit(changedOutside, { projectRevision: redone.revision, entities: {}, resources: {} });
    for (let check = 0; check < 2; check++) {
      const refused = await historyBus.undo(project.projectId);
      equal(!refused.ok && [refused.error.code, refused.error.retryable, refused.attempts], ['project-cas', false, 0]);
    }
    equal((await persistence.load(project.projectId))?.document.assets[0].name, '历史名称');
    equal((await apply(changedOutside, { name: '新历史段' })).ok, true);
    equal((await historyBus.undo(project.projectId)).ok, true);
    const blocked = await historyBus.undo(project.projectId);
    equal(!blocked.ok && blocked.error.code, 'project-cas');
    const compositeBase = (await persistence.load(project.projectId))!.document;
    const compositeBus = new CommandBus(persistence, () => {});
    let invalidChild = false;
    try {
      compositeBus.prepareCompositeSpriteProperties(compositeBase, [
        [{ spriteId: id, patch: { name: '不应写入' } }],
        [{ spriteId: crypto.randomUUID(), patch: { name: '不存在' } }]
      ]);
    } catch (error) { invalidChild = String(error).includes('Unknown sprite'); }
    equal(invalidChild, true);
    equal((await persistence.load(project.projectId))?.document.revision, compositeBase.revision);
    const composed = await compositeBus.dispatch(compositeBus.prepareCompositeSpriteProperties(compositeBase, [
      [{ spriteId: id, patch: { name: '第一步', description: '组合说明' } }],
      [{ spriteId: id, patch: { name: '第二步' } }, { spriteId: secondId, patch: { name: '第二素材' } }]
    ]));
    equal(composed.ok && composed.projectRevision, compositeBase.revision + 1);
    const afterComposite = (await persistence.load(project.projectId))!.document;
    equal(afterComposite.assets.map(asset => [asset.name, asset.revision]),
      [['第二步', compositeBase.assets[0].revision + 1], ['第二素材', compositeBase.assets[1].revision + 1]]);
    equal(afterComposite.assets[0].description, '组合说明');
    equal((await compositeBus.undo(project.projectId)).ok, true);
    const afterUndo = (await persistence.load(project.projectId))!.document;
    equal(afterUndo.revision, compositeBase.revision + 2);
    equal(afterUndo.assets.map(asset => [asset.name, asset.description, asset.revision]),
      compositeBase.assets.map(asset => [asset.name, asset.description, asset.revision + 2]));
    equal((await compositeBus.redo(project.projectId)).ok, true);
    const afterRedo = (await persistence.load(project.projectId))!.document;
    equal(afterRedo.assets.map(asset => [asset.name, asset.description, asset.revision]),
      afterComposite.assets.map(asset => [asset.name, asset.description, asset.revision + 2]));

    const noOpChild = compositeBus.prepareCompositeSpriteProperties(afterRedo, [
      [{ spriteId: id, patch: { name: '有效子操作' } }],
      [{ spriteId: secondId, patch: { name: afterRedo.assets[1].name } }]
    ]);
    equal((await compositeBus.dispatch(noOpChild)).ok, true);
    equal((await compositeBus.undo(project.projectId)).ok, true);
    equal((await persistence.load(project.projectId))?.document.assets[1].revision, afterRedo.assets[1].revision);
    return { compositeAtomicity: 'pass', compositeUndoRedo: 'pass', compositeNoOpChild: 'pass', historyRoundTrip: 'pass', historyExternalConflict: 'pass', retrySucceedsAfterRebase: 'pass', pendingCap: 'pass', publishFailure: 'pass', retryLimit: 'pass', oneStaleTarget: 'pass', atomicBatch: 'pass', safeRebase: 'pass', staleConflict: 'pass', duplicateDispatch: 'pass', noOp: 'pass' };
  } finally { persistence.close(); indexedDB.deleteDatabase(db); }
}

async function rasterCommandTests() {
  const db = 'sprite-v10-raster-commands-' + crypto.randomUUID();
  let store = await ProjectStore.open(db);
  try {
    const blank = createProject();
    await store.create(blank);
    const id = crypto.randomUUID();
    const pngId = crypto.randomUUID();
    const maskId = crypto.randomUUID();
    const oldPng = await png();
    const oldMask = encodeMask(2, 2, new Uint8Array([0, 1, 2, 3]));
    const staged = await store.stage(blank.projectId, [
      { resourceId: pngId, revision: 1, bytes: oldPng }, { resourceId: maskId, revision: 1, bytes: oldMask }
    ]);
    const start = structuredClone(blank);
    start.revision++;
    const key = 'spriteAsset:' + id;
    start.assets.push({
      id, name: '角色', category: 'character', revision: 1, contentVersion: 1, shape: 'polygon',
      sourceRect: { x: 10, y: 20, width: 2, height: 2 },
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }],
      sourceRectStatus: 'known', assetRef: 'sprites/角色.png', rasterResource: staged.versions[0],
      mask: { ...staged.versions[1], assetRef: 'masks/角色.ssm', kind: 'mask', encoding: 'bitmap',
        coordinateSpace: 'spriteLocal', width: 2, height: 2 }
    });
    start.revisionLedger.entities[key] = 1;
    start.revisionLedger.resources = { [pngId]: 1, [maskId]: 1 };
    await store.commit(start, { projectRevision: 1, entities: { [key]: { state: 'absent' } },
      resources: { [pngId]: { state: 'absent' }, [maskId]: { state: 'absent' } } }, staged.id);
    const canvas = new OffscreenCanvas(2, 2);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#000';
    context.fillRect(0, 0, 2, 2);
    const newPng = await canvas.convertToBlob({ type: 'image/png' });
    const newMask = encodeMask(2, 2, new Uint8Array([4, 3, 2, 1]));
    const bus = new CommandBus(store, () => {});
    const invalid = await bus.dispatch(bus.prepareSpriteRasterReplacement(start, id,
      { png: newPng, mask: encodeMask(1, 1, new Uint8Array([255])) }));
    equal(invalid.ok, false);
    equal((await store.load(blank.projectId))?.document.revision, 2);
    equal(await store.collectExpiredStages(Date.now() + 24 * 60 * 60 * 1000), 0);
    const draft = bus.prepareSpriteRasterReplacement(start, id, { png: newPng, mask: newMask });
    const stale = bus.prepareSpriteRasterReplacement(start, id, { mask: newMask });
    equal((await bus.dispatch(draft)).ok, true);
    const rejected = await bus.dispatch(stale);
    equal(!rejected.ok && [rejected.error.code, rejected.attempts], ['target-entity', 0]);
    const verify = async (revision: number, pngBytes: Blob, maskBytes: Blob) => {
      const loaded = (await store.load(blank.projectId))!;
      const asset = loaded.document.assets[0];
      equal([loaded.document.revision, asset.revision, asset.contentVersion, asset.rasterResource.revision,
        asset.mask?.revision], [revision + 1, revision, revision, revision, revision]);
      for (const [resourceId, bytes] of [[pngId, pngBytes], [maskId, maskBytes]] as const) {
        equal(Array.from(new Uint8Array(await loaded.bytes.get(resourceId)!.arrayBuffer())),
          Array.from(new Uint8Array(await bytes.arrayBuffer())));
      }
    };
    await verify(2, newPng, newMask);
    equal((await bus.undo(blank.projectId)).ok, true);
    await verify(3, oldPng, oldMask);
    equal((await bus.redo(blank.projectId)).ok, true);
    await verify(4, newPng, newMask);
    const final = (await store.load(blank.projectId))!.document;
    const newer = structuredClone(final);
    newer.revision++;
    newer.legacyExtensions = { external: true };
    await store.commit(newer, { projectRevision: final.revision, entities: {}, resources: {} });
    const undo = await bus.undo(blank.projectId);
    equal(!undo.ok && [undo.error.code, undo.attempts], ['project-cas', 0]);
    equal((await store.load(blank.projectId))?.document.assets[0].mask?.revision, 4);
    const withRect = (await store.load(blank.projectId))!.document;
    const widerCanvas = new OffscreenCanvas(3, 2);
    const wideContext = widerCanvas.getContext('2d')!;
    wideContext.fillStyle = '#f0a';
    wideContext.fillRect(0, 0, 3, 2);
    const widerPng = await widerCanvas.convertToBlob({ type: 'image/png' });
    const badCrop = await bus.dispatch(bus.prepareSpriteCrop(withRect, id, { x: 9, y: 20, width: 4, height: 2 }, widerPng));
    equal(badCrop.ok, false);
    equal((await store.load(blank.projectId))?.document.revision, withRect.revision);
    const crop = { x: 9, y: 20, width: 3, height: 2 };
    const cropped = await bus.dispatch(bus.prepareSpriteCrop(withRect, id, crop, widerPng));
    equal(cropped.ok, true);
    const verifyCrop = async (rect: typeof crop, points: Array<{ x: number; y: number }>, samples: number[], advance: number) => {
      const loaded = (await store.load(blank.projectId))!;
      const asset = loaded.document.assets[0];
      equal(loaded.document.revision, withRect.revision + advance);
      equal(asset.contentVersion, withRect.assets[0].contentVersion + advance);
      equal(asset.sourceRect, rect);
      equal(asset.points, points);
      const maskPixels = await decodeMask(loaded.bytes.get(maskId)!);
      equal([maskPixels.width, maskPixels.height, ...maskPixels.samples], [rect.width, rect.height, ...samples]);
    };
    const shifted = [{ x: 1, y: 0 }, { x: 3, y: 0 }, { x: 1, y: 2 }];
    await verifyCrop(crop, shifted, [255, 4, 3, 255, 2, 1], 1);
    equal((await bus.undo(blank.projectId)).ok, true);
    await verifyCrop(withRect.assets[0].sourceRect!, withRect.assets[0].points!, [4, 3, 2, 1], 2);
    equal((await bus.redo(blank.projectId)).ok, true);
    await verifyCrop(crop, shifted, [255, 4, 3, 255, 2, 1], 3);
    const beforeRemoval = (await store.load(blank.projectId))!.document;
    const remove = bus.prepareSpriteMaskRemoval(beforeRemoval, id);
    equal((await bus.dispatch(remove)).ok, true);
    const removed = (await store.load(blank.projectId))!;
    equal(removed.document.assets[0].mask, undefined);
    equal(removed.bytes.has(maskId), false);
    const tombstone = removed.document.revisionLedger.resources[maskId];
    equal(tombstone, beforeRemoval.assets[0].mask!.revision + 1);

    const forged = await store.stage(blank.projectId, [
      { resourceId: maskId, revision: tombstone + 1, bytes: encodeMask(3, 2, new Uint8Array(6)) }
    ]);
    const falseRestore = structuredClone(removed.document);
    falseRestore.revision++;
    falseRestore.assets[0].revision++;
    falseRestore.assets[0].contentVersion++;
    falseRestore.assets[0].mask = { ...beforeRemoval.assets[0].mask!, ...forged.versions[0] };
    falseRestore.revisionLedger.entities[key]++;
    falseRestore.revisionLedger.resources[maskId]++;
    const restoreExpectation = { projectRevision: removed.document.revision,
      entities: { [key]: { state: 'present' as const, revision: removed.document.assets[0].revision } },
      resources: { [maskId]: { state: 'tombstone' as const, revision: tombstone } } };
    await rejects(store.commit(falseRestore, restoreExpectation, forged.id), error =>
      error instanceof ConflictError && error.kind === 'resource');
    equal((await store.load(blank.projectId))?.document.revision, removed.document.revision);
    equal(await store.collectExpiredStages(Date.now() + 24 * 60 * 60 * 1000), 0);

    equal((await bus.undo(blank.projectId)).ok, true);
    const restored = (await store.load(blank.projectId))!;
    equal(restored.document.assets[0].mask?.revision, tombstone + 1);
    equal(restored.document.assets[0].mask?.contentHash, beforeRemoval.assets[0].mask?.contentHash);
    equal((await bus.redo(blank.projectId)).ok, true);

    const blankMask = (await store.load(blank.projectId))!.document;
    const wrongSize = bus.prepareSpriteMaskAttachment(blankMask, id, encodeMask(1, 1, new Uint8Array([0])));
    equal((await bus.dispatch(wrongSize)).ok, false);
    const attach = bus.prepareSpriteMaskAttachment(blankMask, id, encodeMask(3, 2, new Uint8Array([0, 1, 2, 3, 4, 5])));
    equal((await bus.dispatch(attach)).ok, true);
    const newAttachment = (await store.load(blank.projectId))!.document.assets[0].mask!;
    equal(newAttachment.revision, 1);
    equal(newAttachment.resourceId === maskId, false);
    equal((await bus.undo(blank.projectId)).ok, true);
    equal((await store.load(blank.projectId))?.document.assets[0].mask, undefined);
    equal((await bus.redo(blank.projectId)).ok, true);
    const reattached = (await store.load(blank.projectId))!.document.assets[0].mask!;
    equal([reattached.resourceId, reattached.revision, reattached.contentHash],
      [newAttachment.resourceId, 3, newAttachment.contentHash]);
    store.close();
    store = await ProjectStore.open(db);
    const reopenedBus = new CommandBus(store, () => {}, bus.historyId);
    const otherEditor = new CommandBus(store, () => {});
    const isolated = await otherEditor.undo(blank.projectId);
    equal(!isolated.ok && isolated.error.code, 'empty-history');
    equal((await reopenedBus.undo(blank.projectId)).ok, true);
    equal((await store.load(blank.projectId))?.document.assets[0].mask, undefined);
    equal((await reopenedBus.redo(blank.projectId)).ok, true);
    const persisted = (await store.load(blank.projectId, bus.historyId))!;
    equal(persisted.document.assets[0].mask?.resourceId, newAttachment.resourceId);
    equal(persisted.document.assets[0].mask?.revision, 5);
    const rejectedSnapshot = structuredClone(persisted.document);
    rejectedSnapshot.revision++;
    await rejects(store.commit(rejectedSnapshot,
      { projectRevision: persisted.document.revision - 1, entities: {}, resources: {} }, undefined,
      { id: bus.historyId, snapshot: { undo: [], redo: [], segment: 999 } }),
      error => error instanceof ConflictError && error.kind === 'project-cas');
    const unchanged = (await store.load(blank.projectId, bus.historyId))!;
    equal(unchanged.document.revision, persisted.document.revision);
    equal(unchanged.history?.segment, persisted.history?.segment);
    equal(unchanged.history?.undo.length, persisted.history?.undo.length);
    equal((await reopenedBus.dispatch(reopenedBus.prepareSpriteMaskRemoval(unchanged.document, id))).ok, true);
    const removal = (await store.load(blank.projectId, bus.historyId))!;
    const priorMaskRevision = removal.document.revisionLedger.resources[newAttachment.resourceId] - 1;
    const day = 24 * 60 * 60 * 1000;
    const immediateCount = await store.collectRetiredResources(blank.projectId);
    equal(immediateCount, 0);
    const cleaned = await store.collectRetiredResources(blank.projectId, Date.now() + day + 1000);
    equal(cleaned > 0, true);
    equal((await reopenedBus.undo(blank.projectId)).ok, true);
    equal((await store.load(blank.projectId))?.document.assets[0].mask?.revision, priorMaskRevision + 2);
    equal((await reopenedBus.redo(blank.projectId)).ok, true);
    const secondRemoval = (await store.load(blank.projectId))!.document;
    const afterExpiry = await store.collectRetiredResources(blank.projectId, Date.now() + 31 * day);
    equal(afterExpiry > 0, true);
    const collectedProject = (await store.load(blank.projectId, bus.historyId))!;
    equal(collectedProject.document.revision, secondRemoval.revision);
    equal(collectedProject.document.revisionLedger.resources[newAttachment.resourceId],
      secondRemoval.revisionLedger.resources[newAttachment.resourceId]);
    equal(collectedProject.history, undefined);
    equal(collectedProject.bytes.has(pngId), true);
    return { retiredResourceCollection: 'pass', retiredMaskPin: 'pass', persistedHistoryReopen: 'pass', isolatedHistoryTimeline: 'pass', historyAtomicity: 'pass', maskPresenceHistory: 'pass', maskTombstoneProtection: 'pass', cropMaskRoundTrip: 'pass', cropDimensionReject: 'pass', rasterAtomicity: 'pass', rasterUndoRedo: 'pass', rasterStaleReject: 'pass' };
  } finally { store.close(); indexedDB.deleteDatabase(db); }
}

function historyBudgetTests() {
  const now = Date.now();
  const entry = (createdAt: number, bytes = 0) => ({ change: null, revision: 1, segment: 1, createdAt, bytes });
  const a = { id: 'a', snapshot: { undo: Array.from({ length: 75 }, (_, i) => entry(now - 200 + i)), redo: [], segment: 1 } };
  const b = { id: 'b', snapshot: { undo: Array.from({ length: 50 }, (_, i) => entry(now - 80 + i)), redo: [], segment: 1 } };
  const result = trimProjectHistory([a, b], now);
  equal([a.snapshot.undo.length, b.snapshot.undo.length, ...result.changed], [50, 50, 'a']);
  const max = 1024 ** 3;
  const first = { id: 'first', snapshot: { undo: [entry(now - 2, max)], redo: [], segment: 1 } };
  const second = { id: 'second', snapshot: { undo: [entry(now - 1, 1)], redo: [], segment: 1 } };
  trimProjectHistory([first, second], now);
  equal([first.snapshot.undo.length, second.snapshot.undo.length], [0, 1]);
  return 'pass';
}

async function historySchemaUpgrade() {
  const db = 'sprite-v10-upgrade-' + crypto.randomUUID();
  const project = createProject();
  const opening = indexedDB.open(db, 1);
  opening.onupgradeneeded = () => {
    const database = opening.result;
    database.createObjectStore('resources');
    database.createObjectStore('staging', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
    database.createObjectStore('projects').add(project, project.projectId);
  };
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  legacy.close();
  const upgraded = await ProjectStore.open(db);
  try {
    const loaded = await upgraded.load(project.projectId, crypto.randomUUID());
    equal(loaded?.document, project);
    equal(loaded?.history, undefined);
    return 'pass';
  } finally { upgraded.close(); indexedDB.deleteDatabase(db); }
}

Promise.all([run(), commandTests(), rasterCommandTests(), historySchemaUpgrade()]).then(([fixture, commands, rasterCommands, historyUpgrade]) => {
  const value = { ...fixture, commands, rasterCommands, historyUpgrade, projectHistoryBudget: historyBudgetTests() };
  document.querySelector('#result')!.textContent = JSON.stringify(value); },
  error => { document.querySelector('#result')!.textContent = JSON.stringify({ test: { error: String(error.stack ?? error) } }); });
