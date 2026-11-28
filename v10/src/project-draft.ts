import type { MigrationWarning, ProjectDocument } from './domain.ts';
import type { ProjectStore } from './project-store.ts';

export type ProjectDraft = {
  project: ProjectDocument;
  binaries: Map<string, Blob>;
  report: { imported: number; quarantined: readonly unknown[]; warnings: readonly MigrationWarning[] };
};

export async function saveProjectDraft(draft: Pick<ProjectDraft, 'project' | 'binaries'>,
  store: Pick<ProjectStore, 'create' | 'createImportedProject' | 'stage'>) {
  const project = structuredClone(draft.project);
  const input = Array.from(draft.binaries, ([resourceId, bytes]) => ({ resourceId, revision: 1, bytes }));
  if (!input.length) await store.create(project);
  else {
    const stage = await store.stage(project.projectId, input);
    await store.createImportedProject(project, stage.id);
  }
  return project.projectId;
}
