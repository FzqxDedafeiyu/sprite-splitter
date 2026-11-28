import type { UIState } from './reactive-store.ts';

type Cancellation = 'workspace-switch' | 'tool-switch' | 'import' | 'auto-detect' | 'unmount';
type InteractionLifecycle = { cancel(reason: Cancellation): void; destroy(): void };
type ToolState = Pick<UIState, 'activeWorkspace' | 'activeToolByWorkspace'>;

export class WorkspaceLifecycle {
  #activity = new AbortController();
  #closed = false;

  constructor(private readonly interaction: InteractionLifecycle,
    private readonly readUI: () => { readonly activeWorkspace: string;
      readonly activeToolByWorkspace: Readonly<Record<string, string>> },
    private readonly writeUI: (update: ToolState) => void) {}

  get signal(): AbortSignal { return this.#activity.signal; }

  switchWorkspace(workspace: string) {
    const ui = this.readUI();
    if (this.#closed || ui.activeWorkspace === workspace) return;
    this.#reset('workspace-switch');
    this.writeUI({ ...ui, activeWorkspace: workspace, activeToolByWorkspace: { ...ui.activeToolByWorkspace } });
  }

  activateTool(tool: string) {
    const ui = this.readUI();
    if (this.#closed || ui.activeToolByWorkspace[ui.activeWorkspace] === tool) return;
    this.#reset('tool-switch');
    this.writeUI({ activeWorkspace: ui.activeWorkspace,
      activeToolByWorkspace: { ...ui.activeToolByWorkspace, [ui.activeWorkspace]: tool } });
  }

  beforeImport() { if (!this.#closed) this.#reset('import'); }
  beforeAutoDetect() { if (!this.#closed) this.#reset('auto-detect'); }

  destroy() {
    if (this.#closed) return;
    this.#closed = true;
    this.#activity.abort('unmount');
    this.interaction.destroy();
  }

  #reset(reason: Cancellation) {
    this.interaction.cancel(reason);
    const old = this.#activity;
    this.#activity = new AbortController();
    old.abort(reason);
  }
}
