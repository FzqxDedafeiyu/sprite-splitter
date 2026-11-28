import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProject, entities, validateProject } from '../src/project.ts';

function fixture() {
  const project = createProject();
  const spriteId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  project.assets.push({
    id: spriteId, name: '蓝色方块', category: 'prop', shape: 'rectangle', sourceRectStatus: 'unknown',
    revision: 1, contentVersion: 1, assetRef: 'sprites/blue.png',
    rasterResource: { resourceId, revision: 1, contentHash: 'sha256:' + '0'.repeat(64), byteLength: 1 }
  });
  project.revisionLedger.resources[resourceId] = 1;

  const preset = { id: crypto.randomUUID(), revision: 1, name: '画面底部',
    assetType: 'both', actionTypes: [], strategy: 'bottom_center' };
  project.pivotPresets.push(preset);
  for (const assetType of ['character', 'object']) {
    const set = { id: crypto.randomUUID(), revision: 1, name: assetType, assetType,
      createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:00:00Z', spriteIds: [spriteId] };
    project.animationSets.push(set);
    project.animationClips.push({ id: crypto.randomUUID(), revision: 1, setId: set.id, name: 'idle', actionType: 'idle',
      fps: 12, loop: true, canvas: { width: 32, height: 32 }, pivotPresetId: preset.id, pivotTarget: { x: 15.5, y: 27.25 },
      frames: [1, 2.5].map(duration => ({ id: crypto.randomUUID(), revision: 1, spriteId, duration,
        alignment: { pivotLocal: { x: 1.75, y: 3.5 }, offset: { x: -0.25, y: 2.5 },
          pivotSource: 'manual', offsetSource: 'imported', locked: true, confidence: 0.5 } })) });
  }
  return project;
}

function check(project) {
  project.revisionLedger.entities = Object.fromEntries(Array.from(entities(project), ([key, value]) => [key, value.revision]));
  validateProject(project);
}

test('角色、物体和重复精灵帧共用动画模型，接受小数时间与坐标', () => {
  const project = fixture();
  check(project);
  assert.equal(project.animationClips[0].frames[1].duration, 2.5);
  assert.equal(project.animationClips[0].frames[0].alignment.offset.x, -0.25);
  validateProject(createProject());
});

for (const [description, mutate, message] of [
  ['帧 ID 与 Sprite ID 混用', project => { project.animationClips[0].frames[0].id = project.assets[0].id; }, /frame identity/],
  ['不同动作复用帧身份', project => { project.animationClips[1].frames[0].id = project.animationClips[0].frames[0].id; }, /duplicate entity/],
  ['帧未纳入动作组成员', project => { project.animationSets[0].spriteIds = []; }, /frame identity/],
  ['非正数帧时长', project => { project.animationClips[0].frames[0].duration = 0; }, /timing or alignment/],
  ['非有限帧率', project => { project.animationClips[0].fps = Infinity; }, /Invalid animation clip/],
  ['非有限枢轴', project => { project.animationClips[0].frames[0].alignment.pivotLocal.x = NaN; }, /timing or alignment/],
  ['AI 候选直接作为生效数据', project => { project.animationClips[0].frames[0].alignment.pivotSource = 'ai_suggested'; }, /timing or alignment/]
]) {
  test('拒绝' + description, () => {
    const project = fixture();
    mutate(project);
    assert.throws(() => check(project), message);
  });
}
