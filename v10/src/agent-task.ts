import type { ProjectDocument } from './domain.ts';
import { invariant } from './project.ts';
import { cropSourcePng, openSourceBitmap } from './source-project.ts';
import { writeV9Zip } from './v9-export.ts';

const instructions = [
  '请根据 source.png 和 agent_task.json，对候选精灵做语义和空间标注。',
  'sprite_id 是持久素材标识，请逐字复制。保留候选范围与顺序，并且只引用清单中的素材。',
  'anchor 使用原图像素坐标。layer 使用 background、midground 或 foreground。depth 为 0–1，parallax 为 0–2，zIndex 为整数。',
  '不确定的字段省略，并将 reviewStatus 标为 needs_review。confidence 为 0–1。关系数组填入目标 sprite_id。',
  '只返回 JSON。使用 schema spatial-scene-agent-result/v2，复制 projectId 及 source 的 width、height、contentHash。',
  'sprites 中每项可包含 sprite_id、name、slug、category、description、tags、anchor、layout、relations、confidence 和 reviewStatus。',
  'tags 是字符串数组，layout 可包含 layer、depth、parallax、zIndex，relations 可包含 nearTo、attachedTo、supports。'
].join('\n');

export function agentTaskSource(project: ProjectDocument) {
  const [source] = project.sourceImages;
  if (project.sourceImages.length !== 1 || source.availability !== 'available' || !source.resourceVersion ||
    source.width !== project.sceneLayout.world.width || source.height !== project.sceneLayout.world.height ||
    source.width === undefined || source.height === undefined || !project.assets.length ||
    !project.assets.every(sprite => sprite.sourceImageId === source.id && sprite.sourceRectStatus === 'known' && sprite.sourceRect)) return;
  return { ...source, width: source.width, height: source.height, resourceVersion: source.resourceVersion };
}

export async function exportAgentTask(project: ProjectDocument, bytes: ReadonlyMap<string, Blob>) {
  const source = agentTaskSource(project);
  const original = source && bytes.get(source.resourceVersion.resourceId);
  invariant(source && original, 'Agent 任务包需要原图及已保存的素材范围。');
  const manifest = {
    schema: 'spatial-scene-agent-task/v2', projectId: project.projectId, instructions,
    source: { filename: source.filename, width: source.width, height: source.height,
      contentHash: source.resourceVersion.contentHash, coordinateOrigin: 'top-left', coordinateUnits: 'source-pixels' },
    sprites: project.assets.map(sprite => {
      const item = project.sceneLayout.items[sprite.id];
      const bbox = sprite.sourceRect!;
      return {
        sprite_id: sprite.id, name: sprite.name, bbox, category: sprite.category, description: sprite.description ?? '',
        currentLayout: item ? { layer: item.layer, depth: item.depth, parallax: item.parallax, zIndex: item.zIndex,
          anchor: { x: item.sceneAnchor.x - (item.position.x - bbox.x),
            y: item.sceneAnchor.y - (item.position.y - bbox.y) } } : null,
        mask_available: Boolean(sprite.mask)
      };
    })
  };
  const { bitmap } = await openSourceBitmap(original);
  try {
    invariant(bitmap.width === source.width && bitmap.height === source.height, '任务包原图尺寸与项目不一致。');
    const image = await cropSourcePng(bitmap, { x: 0, y: 0, width: source.width, height: source.height });
    return await writeV9Zip(new Map([
      ['source.png', image], ['agent_task.json', new Blob([JSON.stringify(manifest, null, 2)])],
      ['AGENT_PROMPT.txt', new Blob([instructions])]
    ]));
  } finally { bitmap.close(); }
}
