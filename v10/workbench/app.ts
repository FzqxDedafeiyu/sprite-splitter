import { cropSourcePng, openSourceBitmap, previewSourceProject } from '../src/source-project.ts';
import { sameValue } from '../src/project.ts';
import { bindCropEditor } from './crop-editor.ts';
import { saveProjectDraft, type ProjectDraft } from '../src/project-draft.ts';
import type { DetectionOptions } from '../src/v9-detection.ts';
import { previewV9AgentAnnotations } from '../src/v9-agent.ts';
import { CommandBus, type CommandResult } from '../src/command-bus.ts';
import { ProjectStore } from '../src/project-store.ts';
import { readV9Archive } from '../src/v9-archive.ts';
import { previewV9Migration } from '../src/v9-migration.ts';
import { exportV9Scene } from '../src/v9-export.ts';
import type { MigrationWarning, ProjectDocument, Rect, SpriteAsset } from '../src/domain.ts';

function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const zip = element<HTMLInputElement>('zip');
const orphans = element<HTMLInputElement>('orphans');
const projects = element<HTMLSelectElement>('projects');
const save = element<HTMLButtonElement>('save');
const exportButton = element<HTMLButtonElement>('export');
const status = element('status');
const image = element<HTMLImageElement>('image');
const sprites = element('sprites');
const reload = element<HTMLButtonElement>('reload');
const undo = element<HTMLButtonElement>('undo');
const redo = element<HTMLButtonElement>('redo');
const spriteName = element<HTMLInputElement>('sprite-name');
const spriteCategory = element<HTMLInputElement>('sprite-category');
const spriteDescription = element<HTMLTextAreaElement>('sprite-description');
const sceneX = element<HTMLInputElement>('scene-x');
const sceneY = element<HTMLInputElement>('scene-y');
const sceneZ = element<HTMLInputElement>('scene-z');
const sceneVisible = element<HTMLInputElement>('scene-visible');
const sceneLocked = element<HTMLInputElement>('scene-locked');
const agentFile = element<HTMLInputElement>('agent-file');
const applyAgent = element<HTMLButtonElement>('apply-agent');
const cancelAgent = element<HTMLButtonElement>('cancel-agent');
let agentPending: { document: ProjectDocument; preview: ReturnType<typeof previewV9AgentAnnotations> } | undefined;
const sourceFile = element<HTMLInputElement>('source-file');
const detectAgain = element<HTMLButtonElement>('detect-again');
const detectionInputs = ['detect-mode', 'detect-alpha', 'detect-background', 'detect-area', 'detect-padding',
  'detect-connectivity'].map(id => element<HTMLInputElement | HTMLSelectElement>(id));
let sourceSelection: { bytes: Blob; filename: string } | undefined;
let store: ProjectStore;
let bus: CommandBus;
let pending: ProjectDraft | undefined;
let opened: Awaited<ReturnType<ProjectStore['load']>>;
let selectedId: string | undefined;
let previewUrl: string | undefined;
let busy = false;
let ready = false;
const cropEditor = bindCropEditor(applyCrop);

function timelineId() {
  const key = 'sprite-v10-workbench-history';
  const fresh = crypto.randomUUID();
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    sessionStorage.setItem(key, fresh);
  } catch { /* Local editing still works with a temporary timeline. */ }
  return fresh;
}

function historyAvailable(direction: 'undo' | 'redo') {
  const entry = opened?.history?.[direction].at(-1);
  return entry?.revision === opened?.document.revision && Boolean(entry &&
    Date.now() - entry.createdAt < 30 * 24 * 60 * 60 * 1000);
}

function describeFailure(result: Extract<CommandResult, { ok: false }>) {
  if (result.error.conflict) return '项目在别处发生过更改。请选择「重新读取」，再核对并应用修改。';
  if (result.error.code === 'empty-history') return '当前没有可操作的历史记录。';
  return result.error.cause ?? result.error.message;
}

async function applyCommand(projectId: string, operation: () => Promise<CommandResult>, done: string) {
  const result = await operation();
  if (!result.ok) {
    say(describeFailure(result), true);
    return;
  }
  try { await openSaved(projectId); }
  catch { say('修改已保存，但界面未能刷新。请选择「重新读取」。', true); return; }
  say(done);
}

function sourceFor(asset?: SpriteAsset) {
  const source = opened?.document.sourceImages.find(item => item.id === asset?.sourceImageId);
  const version = source?.resourceVersion;
  const bytes = version && opened?.bytes.get(version.resourceId);
  if (!source || source.width === undefined || source.height === undefined || !version || !bytes) return undefined;
  return { key: version.resourceId + '@' + version.contentHash, bytes, width: source.width, height: source.height };
}

function applyCrop(rect: Rect) {
  const current = opened;
  const asset = current?.document.assets.find(item => item.id === selectedId);
  const source = sourceFor(asset);
  const original = asset?.sourceRect;
  const previous = asset && current?.bytes.get(asset.rasterResource.resourceId);
  if (pending || !current || !asset || !source || !original || !previous) return;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
    rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
    rect.x + rect.width > source.width || rect.y + rect.height > source.height) {
    say('裁切框必须在源图范围内，宽高至少为 1 像素。', true);
    return;
  }
  if (sameValue(rect, original)) { say('裁切框没有变化。'); return; }
  void run('正在裁切素材…', async () => {
    const { bitmap } = await openSourceBitmap(source.bytes);
    try {
      const png = await cropSourcePng(bitmap, rect, { preserve: { rect: original, bytes: previous } });
      const command = bus.prepareSpriteCrop(current.document, asset.id, rect, png);
      await applyCommand(current.document.projectId, () => bus.dispatch(command), '裁切框已保存。');
    } finally { bitmap.close(); }
  });
}

function showAgentReview() {
  const preview = agentPending?.preview;
  element('agent-review').hidden = !preview;
  element('agent-summary').textContent = preview
    ? preview.edits.length + ' 项可应用 · ' + preview.warnings.length + ' 条提示' : '';
  const warnings = element('agent-warnings');
  warnings.replaceChildren();
  for (const warning of preview?.warnings ?? []) {
    const entry = document.createElement('li');
    const labels = {
      'unknown-target': '找不到唯一素材',
      'duplicate-target': '重复目标已跳过',
      'unresolved-relation': '无法映射的关系',
      'invalid-field': '字段无效，已保留原值'
    };
    entry.textContent = [warning.legacyId, labels[warning.code]].filter(Boolean).join(' · ');
    warnings.append(entry);
  }
}

function say(text: string, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function controls() {
  sourceFile.disabled = zip.disabled = orphans.disabled = projects.disabled = !ready || busy;
  detectAgain.disabled = !ready || busy || !sourceSelection;
  for (const input of detectionInputs) input.disabled = !ready || busy;
  save.disabled = !ready || busy || !pending;
  const saved = ready && !busy && !pending && Boolean(opened);
  exportButton.disabled = !saved || !opened?.document.assets.length;
  reload.disabled = !saved;
  agentFile.disabled = !saved;
  applyAgent.disabled = !saved || !agentPending?.preview.edits.length;
  cancelAgent.disabled = !saved || !agentPending;
  undo.disabled = !saved || !historyAvailable('undo');
  redo.disabled = !saved || !historyAvailable('redo');
  cropEditor.setEnabled(saved && Boolean(selectedId));
  element<HTMLFieldSetElement>('metadata-fields').disabled = !saved || !selectedId;
  element<HTMLFieldSetElement>('scene-fields').disabled = !saved || !selectedId ||
    !opened?.document.sceneLayout.items[selectedId];
}

async function run(message: string, operation: () => Promise<void>) {
  if (!ready || busy) return;
  busy = true;
  controls();
  say(message);
  try { await operation(); }
  catch (error) { say(error instanceof Error ? error.message : String(error), true); }
  finally { busy = false; controls(); }
}

function showPreview(id?: string) {
  selectedId = id;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  image.removeAttribute('src');
  image.hidden = true;
  const asset = opened?.document.assets.find(sprite => sprite.id === id);
  const bytes = asset && opened?.bytes.get(asset.rasterResource.resourceId);
  for (const button of sprites.querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.spriteId === id));
  }
  if (asset && bytes) {
    previewUrl = URL.createObjectURL(bytes);
    image.src = previewUrl;
    image.alt = asset.name;
    image.hidden = false;
    element('selection').textContent = asset.name + (asset.sourceRect
      ? ' · ' + asset.sourceRect.width + ' × ' + asset.sourceRect.height + ' px' : ' · 来源范围未知');
  } else element('selection').textContent = '选择素材查看裁切图。';
  const annotation = element('annotation');
  annotation.hidden = !asset?.agentAnnotation;
  annotation.textContent = asset?.agentAnnotation
    ? ['Agent 标注', ...asset.agentAnnotation.tags].join(' · ') : '';
  spriteName.value = asset?.name ?? '';
  spriteCategory.value = asset?.category ?? '';
  spriteDescription.value = asset?.description ?? '';
  const scene = id ? opened?.document.sceneLayout.items[id] : undefined;
  sceneX.value = scene ? String(scene.position.x) : '';
  sceneY.value = scene ? String(scene.position.y) : '';
  sceneZ.value = scene ? String(scene.zIndex) : '';
  sceneVisible.checked = scene?.visible ?? false;
  sceneLocked.checked = scene?.locked ?? false;
  cropEditor.select(pending ? undefined : sourceFor(asset),
    asset?.sourceRectStatus === 'known' ? asset.sourceRect : undefined);
  controls();
}

function render(warnings: readonly MigrationWarning[], skipped: number) {
  const project = opened?.document;
  element('asset-count').textContent = (project?.assets.length ?? 0) + ' 个';
  const name = project?.sourceImages[0]?.filename ?? '场景素材';
  element('summary').hidden = !project;
  element('summary-text').textContent = project ? [name,
    skipped ? skipped + ' 条已隔离' : '', pending ? (project.migrationMetadata ? '迁移预览' : '识别预览') : 'V10 本地项目'].filter(Boolean).join(' · ') : '';
  const list = element('warnings');
  list.replaceChildren();
  element('report').hidden = warnings.length === 0;
  for (const warning of warnings) {
    const entry = document.createElement('li');
    const labels: Record<string, string> = {
      'missing-source': '原始整图未包含在 V9 导出包中。',
      'mask-unavailable': 'V9 导出包没有可恢复的编辑蒙版。',
      'ambiguous-sprite': '旧编号或文件路径重复，已隔离。',
      'invalid-resource': 'PNG 缺失、损坏或与裁切尺寸不符，已隔离。',
      'orphan-png': '未引用的 PNG 未纳入预览。',
      'orphan-imported': '已纳入未引用的 PNG，原图范围未知。'
    };
    entry.textContent = [warning.legacyId ?? warning.path, labels[warning.code] ?? warning.message].filter(Boolean).join(' · ');
    list.append(entry);
  }
  sprites.replaceChildren();
  for (const asset of project?.assets ?? []) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.spriteId = asset.id;
    button.textContent = asset.name;
    button.addEventListener('click', () => showPreview(asset.id));
    item.append(button);
    sprites.append(item);
  }
  const first = project?.assets.find(item => item.id === selectedId) ?? project?.assets[0];
  showPreview(first?.id);
  controls();
}

async function refreshProjects(selected = '') {
  const items = await store.listProjects();
  const placeholder = new Option('选择项目', '');
  projects.replaceChildren(placeholder, ...items.map(item => new Option(item.name + ' · ' + item.assets + ' 项', item.projectId)));
  projects.value = selected;
}

async function openSaved(projectId: string) {
  const snapshot = await store.load(projectId, bus.historyId);
  if (!snapshot) throw new Error('找不到该项目。');
  pending = undefined;
  agentPending = undefined;
  showAgentReview();
  opened = snapshot;
  const source = snapshot.document.sourceImages[0];
  const bytes = source?.resourceVersion && snapshot.bytes.get(source.resourceVersion.resourceId);
  sourceSelection = bytes ? { bytes, filename: source.filename } : undefined;
  const metadata = snapshot.document.migrationMetadata;
  render(metadata?.warnings ?? [], metadata?.idMap.filter(item => item.status !== 'mapped').length ?? 0);
}

function detectionSettings(): DetectionOptions {
  const value = (name: string) => element<HTMLInputElement>(name).valueAsNumber;
  const mode = element<HTMLSelectElement>('detect-mode').value as DetectionOptions['requested'];
  return { requested: mode, alphaThreshold: value('detect-alpha'), bgThreshold: value('detect-background'),
    minArea: value('detect-area'), pad: value('detect-padding'),
    conn: element<HTMLSelectElement>('detect-connectivity').value === '4' ? 4 : 8 };
}

async function detectSource(input: { bytes: Blob; filename: string }) {
  const preview = await previewSourceProject(input.bytes, input.filename, detectionSettings());
  sourceSelection = input;
  pending = preview;
  agentPending = undefined;
  showAgentReview();
  opened = { document: preview.project, bytes: preview.binaries, history: undefined };
  projects.value = '';
  render(preview.report.warnings, 0);
  if (!preview.project.assets.length) say('源图已载入，但没有识别到素材。可以调整阈值或最小面积后重试。');
  else {
    const mode = preview.detectionMode === 'alpha' ? 'Alpha' : '浅色背景';
    say('自动识别完成（' + mode + '）。请检查素材后保存为 V10 项目。');
  }
}

sourceFile.addEventListener('change', () => {
  const file = sourceFile.files?.[0];
  if (!file) return;
  void run('正在识别源图…', () => detectSource({ bytes: file, filename: file.name }))
    .finally(() => { sourceFile.value = ''; });
});

detectAgain.addEventListener('click', () => {
  const input = sourceSelection;
  if (input) void run('正在重新识别源图…', () => detectSource(input));
});

zip.addEventListener('change', () => {
  const file = zip.files?.[0];
  if (!file) return;
  const includeOrphans = orphans.checked;
  void run('正在检查 ZIP 和素材…', async () => {
    const archive = await readV9Archive(file);
    const preview = await previewV9Migration(archive.manifest, archive.files, { includeOrphans });
    sourceSelection = undefined;
    pending = preview;
    agentPending = undefined;
    showAgentReview();
    opened = { document: preview.project, bytes: preview.binaries, history: undefined };
    projects.value = '';
    render(preview.report.warnings, preview.report.quarantined.length);
    say('预览已就绪。确认迁移报告后可保存为 V10 项目。');
  }).finally(() => { zip.value = ''; });
});

projects.addEventListener('change', () => {
  const projectId = projects.value;
  if (!projectId) return;
  void run('正在打开本地项目…', async () => {
    await openSaved(projectId);
    say('已打开 V10 本地项目。');
  });
});

save.addEventListener('click', () => {
  const preview = pending;
  if (!preview) return;
  void run('正在保存 V10 项目…', async () => {
    const id = await saveProjectDraft(preview, store);
    // Storage succeeded. Further view refresh must not offer a duplicate save.
    pending = undefined;
    await openSaved(id);
    await refreshProjects(id);
    say('已保存为 V10 本地项目。');
  });
});

element<HTMLFormElement>('metadata-form').addEventListener('submit', event => {
  event.preventDefault();
  const snapshot = opened?.document;
  const id = selectedId;
  const asset = snapshot?.assets.find(item => item.id === id);
  if (!snapshot || !id || !asset || pending) return;
  const name = spriteName.value.trim();
  const category = spriteCategory.value.trim() || 'uncategorized';
  const description = spriteDescription.value;
  if (!name) { say('请输入素材名称。', true); return; }
  if (name === asset.name && category === asset.category && description === (asset.description ?? '')) {
    say('素材属性没有变化。');
    return;
  }
  void run('正在保存素材属性…', () => {
    const patch = { name, category, ...(description !== (asset.description ?? '') ? { description } : {}) };
    const command = bus.prepareSpriteProperties(snapshot, [{ spriteId: id, patch }]);
    return applyCommand(snapshot.projectId, () => bus.dispatch(command), '素材属性已保存。');
  });
});

element<HTMLFormElement>('scene-form').addEventListener('submit', event => {
  event.preventDefault();
  const snapshot = opened?.document;
  const id = selectedId;
  if (!snapshot || !id || pending) return;
  const item = snapshot.sceneLayout.items[id];
  if (!item) return;
  const position = { x: sceneX.valueAsNumber, y: sceneY.valueAsNumber };
  const zIndex = sceneZ.valueAsNumber;
  const visible = sceneVisible.checked;
  const locked = sceneLocked.checked;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isSafeInteger(zIndex)) {
    say('请输入有效的场景坐标和整数层级顺序。', true);
    return;
  }
  const moved = position.x !== item.position.x || position.y !== item.position.y;
  const patch = {
    ...(moved ? { position } : {}),
    ...(zIndex !== item.zIndex ? { zIndex } : {}),
    ...(visible !== item.visible ? { visible } : {}),
    ...(locked !== item.locked ? { locked } : {})
  };
  if (!Object.keys(patch).length) { say('场景属性没有变化。'); return; }
  if (moved && item.locked && locked) { say('素材位置已锁定。请先取消锁定。', true); return; }
  void run('正在保存场景属性…', () => {
    const command = bus.prepareSceneItemUpdates(snapshot, [{ spriteId: id, patch }]);
    return applyCommand(snapshot.projectId, () => bus.dispatch(command), '场景属性已保存。');
  });
});

for (const direction of ['undo', 'redo'] as const) {
  element<HTMLButtonElement>(direction).addEventListener('click', () => {
    const projectId = opened?.document.projectId;
    if (!projectId || pending) return;
    const label = direction === 'undo' ? '撤销' : '重做';
    void run('正在' + label + '…', () => applyCommand(projectId, () => bus[direction](projectId), '已' + label + '。'));
  });
}

reload.addEventListener('click', () => {
  const projectId = opened?.document.projectId;
  if (!projectId || pending) return;
  void run('正在重新读取…', async () => { await openSaved(projectId); say('已重新读取项目。'); });
});

agentFile.addEventListener('change', () => {
  const file = agentFile.files?.[0];
  const snapshot = opened?.document;
  if (!file || !snapshot || pending) return;
  agentPending = undefined;
  showAgentReview();
  void run('正在核对 Agent 标注…', async () => {
    if (file.size > 20 * 1024 ** 2) throw new Error('Agent JSON 文件超过 20 MiB。');
    const payload: unknown = JSON.parse(await file.text());
    const preview = previewV9AgentAnnotations(snapshot, payload);
    agentPending = { document: snapshot, preview };
    showAgentReview();
    say('Agent 标注预览已就绪。确认后可应用。');
  }).finally(() => { agentFile.value = ''; });
});

applyAgent.addEventListener('click', () => {
  const draft = agentPending;
  if (!draft) return;
  void run('正在应用 Agent 标注…', () => {
    const commandId = bus.prepareAgentAnnotationImport(draft.document, draft.preview.edits);
    return applyCommand(draft.document.projectId, () => bus.dispatch(commandId), 'Agent 标注已应用。');
  });
});

cancelAgent.addEventListener('click', () => {
  agentPending = undefined;
  showAgentReview();
  controls();
  say('已取消标注预览。');
});

exportButton.addEventListener('click', () => {
  const snapshot = opened;
  if (!snapshot) return;
  void run('正在生成兼容 ZIP…', async () => {
    const { archive } = await exportV9Scene(snapshot.document, snapshot.bytes);
    const url = URL.createObjectURL(archive);
    const link = document.createElement('a');
    link.href = url;
    link.download = (snapshot.document.sourceImages[0]?.filename ?? 'scene').replace(/[\\/:*?"<>|]/g, '_') + '-v9.zip';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    say('V9 兼容 ZIP 已生成。');
  });
});

window.addEventListener('pagehide', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
void (async () => {
  controls();
  try {
    store = await ProjectStore.open();
    bus = new CommandBus(store, () => {}, timelineId());
    await refreshProjects();
    ready = true;
    say('请选择 V9 场景 ZIP、源图，或打开已保存项目。');
  } catch (error) { say('无法打开浏览器本地存储：' + String(error), true); }
  finally { controls(); }
})();
