import type { ProjectDocument, Rect, ResourceVersion, SceneLayout, SpriteAsset } from './domain.ts';
import { createProject, invariant, validateProject } from './project.ts';
import type { ProjectDraft } from './project-draft.ts';
import { resourceHash } from './project-store.ts';
import { detectV9Sprites, maxSourcePixels, type DetectionOptions } from './v9-detection.ts';

const sourceByteLimit = 64 * 1024 ** 2;

export async function openSourceBitmap(input: Blob) {
  invariant(input.size > 0 && input.size <= sourceByteLimit, '源图文件不可为空或大于 64 MiB。');
  const signature = new Uint8Array(await input.slice(0, 12).arrayBuffer());
  const format = signature[0] === 137 && signature[1] === 80 && signature[2] === 78 && signature[3] === 71 ? 'png' :
    signature[0] === 255 && signature[1] === 216 ? 'jpg' :
      String.fromCharCode(...signature.slice(0, 4)) === 'RIFF' &&
        String.fromCharCode(...signature.slice(8, 12)) === 'WEBP' ? 'webp' : undefined;
  invariant(format, '请选择 PNG、JPEG 或 WebP 源图。');
  const bitmap = await createImageBitmap(input);
  if (bitmap.width * bitmap.height > maxSourcePixels) {
    bitmap.close();
    throw new Error('源图超过当前工作台的 1600 万像素上限。');
  }
  return { format, bitmap };
}

export async function cropSourcePng(bitmap: ImageBitmap, rect: Rect, mask?: Uint8Array) {
  const { x, y, width, height } = rect;
  invariant([x, y, width, height].every(Number.isSafeInteger) && x >= 0 && y >= 0 &&
    width > 0 && height > 0 && x + width <= bitmap.width && y + height <= bitmap.height &&
    (!mask || mask.length === width * height), '裁切矩形或邻域蒙版无效。');
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: Boolean(mask) });
  invariant(context, '浏览器无法创建裁切画布。');
  context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
  if (mask) {
    const pixels = context.getImageData(0, 0, width, height);
    for (let index = 0; index < mask.length; index++) if (!mask[index]) pixels.data[index * 4 + 3] = 0;
    context.putImageData(pixels, 0, 0);
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

export function defaultSourceSceneItem(spriteId: string, sourceRect: Rect, order: number): SceneLayout {
  return {
    spriteId, layer: 'midground', depth: 0.5, parallax: 0.7, zIndex: order,
    visible: true, locked: false, position: { x: sourceRect.x, y: sourceRect.y },
    transform: { scaleX: 1, scaleY: 1, rotation: 0 },
    sceneAnchor: { x: Math.round(sourceRect.x + sourceRect.width / 2), y: sourceRect.y + sourceRect.height },
    anchorSource: 'defaulted', relations: { nearTo: [], attachedTo: [], supports: [] }, revision: 1
  };
}

export async function previewSourceProject(input: Blob, filename: string, settings: DetectionOptions): Promise<ProjectDraft & {
  detectionMode: 'alpha' | 'lightbg';
}> {
  const { bitmap, format } = await openSourceBitmap(input);
  try {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    invariant(context, '浏览器无法创建源图画布。');
    context.drawImage(bitmap, 0, 0);
    const detected = detectV9Sprites(context.getImageData(0, 0, width, height).data, width, height, settings);
    const project: ProjectDocument = createProject();
    const binaries = new Map<string, Blob>();
    const addResource = async (blob: Blob): Promise<ResourceVersion> => {
      const resourceId = crypto.randomUUID();
      binaries.set(resourceId, blob);
      project.revisionLedger.resources[resourceId] = 1;
      return { resourceId, revision: 1, contentHash: await resourceHash(blob), byteLength: blob.size };
    };

    const sourceImageId = crypto.randomUUID();
    const original = await addResource(input);
    project.sourceImages.push({ id: sourceImageId, revision: 1, filename: filename || '源图',
      width, height, availability: 'available', resourceVersion: original,
      assetRef: 'sources/' + original.resourceId + '.' + format });
    project.revisionLedger.entities['sourceImage:' + sourceImageId] = 1;
    project.sceneLayout.world = { ...project.sceneLayout.world, width, height };
    for (const [index, item] of detected.sprites.entries()) {
      const sourceRect = { x: item.x, y: item.y, width: item.width, height: item.height };
      const png = await cropSourcePng(bitmap, sourceRect, item.mask);
      const rasterResource = await addResource(png);
      const id = crypto.randomUUID();
      const suffix = String(index + 1).padStart(3, '0');
      const name = 'sprite_' + suffix;
      const asset: SpriteAsset = { id, name, category: 'uncategorized', sourceImageId, sourceRect,
        sourceRectStatus: 'known', shape: 'rectangle', assetRef: 'sprites/' + suffix + '_' + name + '.png',
        rasterResource, contentVersion: 1, revision: 1 };
      project.assets.push(asset);
      project.revisionLedger.entities['spriteAsset:' + id] = 1;
      project.sceneLayout.items[id] = defaultSourceSceneItem(id, sourceRect, index);
      project.revisionLedger.entities['sceneItem:' + id] = 1;
    }
    validateProject(project);
    return { project, binaries, detectionMode: detected.mode,
      report: { imported: project.assets.length, quarantined: [], warnings: [] } };
  } finally { bitmap.close(); }
}
