import { ProjectStore } from '../src/project-store.ts';
import { readV9Archive } from '../src/v9-archive.ts';
import { previewV9Migration, saveV9Migration } from '../src/v9-migration.ts';
import { exportV9Scene } from '../src/v9-export.ts';
import type { MigrationWarning, ProjectDocument } from '../src/domain.ts';

function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const zip = element<HTMLInputElement>('zip');
const orphans = element<HTMLInputElement>('orphans');
const projects = element<HTMLSelectElement>('projects');
const save = element<HTMLButtonElement>('save');
const exportButton = element<HTMLButtonElement>('export');
const status = element('status');
const image = element<HTMLImageElement>('image');
const sprites = element('sprites');
let store: ProjectStore;
let pending: Awaited<ReturnType<typeof previewV9Migration>> | undefined;
let opened: { document: ProjectDocument; bytes: ReadonlyMap<string, Blob> } | undefined;
let selectedId: string | undefined;
let previewUrl: string | undefined;
let busy = false;
let ready = false;

function say(text: string, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function controls() {
  zip.disabled = orphans.disabled = projects.disabled = !ready || busy;
  save.disabled = !ready || busy || !pending;
  exportButton.disabled = !ready || busy || Boolean(pending) || !opened || !opened.document.assets.length;
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
}

function render(warnings: readonly MigrationWarning[], skipped: number) {
  const project = opened?.document;
  element('asset-count').textContent = (project?.assets.length ?? 0) + ' 个';
  const name = project?.sourceImages[0]?.filename ?? '场景素材';
  element('summary').hidden = !project;
  element('summary-text').textContent = project ? [name,
    skipped ? skipped + ' 条已隔离' : '', pending ? '迁移预览' : 'V10 本地项目'].filter(Boolean).join(' · ') : '';
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
  const snapshot = await store.load(projectId);
  if (!snapshot) throw new Error('找不到该项目。');
  pending = undefined;
  opened = snapshot;
  const metadata = snapshot.document.migrationMetadata;
  render(metadata?.warnings ?? [], metadata?.idMap.filter(item => item.status !== 'mapped').length ?? 0);
}

zip.addEventListener('change', () => {
  const file = zip.files?.[0];
  if (!file) return;
  const includeOrphans = orphans.checked;
  void run('正在检查 ZIP 和素材…', async () => {
    const archive = await readV9Archive(file);
    const preview = await previewV9Migration(archive.manifest, archive.files, { includeOrphans });
    pending = preview;
    opened = { document: preview.project, bytes: preview.binaries };
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
    const id = await saveV9Migration(preview, store);
    // Storage succeeded. Further view refresh must not offer a duplicate save.
    pending = undefined;
    await openSaved(id);
    await refreshProjects(id);
    say('已保存为 V10 本地项目。');
  });
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
    await refreshProjects();
    ready = true;
    say('请选择 V9 场景 ZIP，或打开已保存项目。');
  } catch (error) { say('无法打开浏览器本地存储：' + String(error), true); }
  finally { controls(); }
})();
