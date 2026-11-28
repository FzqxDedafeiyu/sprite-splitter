import type { ProjectDocument } from './domain.ts';
import type { GestureSnapshot } from './interaction.ts';
import type { Viewport } from './coordinates.ts';

type Immutable<T> = T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T;
export type UIState = {
  activeWorkspace: string;
  activeToolByWorkspace: Record<string, string>;
  selectedSpriteIds: string[];
  selectedAnimationSetId?: string;
  selectedClipId?: string;
  selectedFrameId?: string;
  inspectorTab?: string;
  panels: Record<string, boolean>;
  viewportByWorkspace: Record<string, Viewport>;
};
type PlaybackState = 'stopped' | 'playing' | 'paused';
export type State = Immutable<{
  project: { document: ProjectDocument; revision: number };
  ui: UIState;
  interaction: GestureSnapshot;
  animationUI: { playbackState: PlaybackState };
}>;

function share(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next) || next === null || typeof next !== 'object') return next;
  const old = previous !== null && typeof previous === 'object' &&
    Array.isArray(previous) === Array.isArray(next) ? previous as Record<string, unknown> : undefined;
  const prototype = Object.getPrototypeOf(next);
  if (!Array.isArray(next) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Store snapshots must contain plain data');
  }
  const entries = Object.entries(next).map(([key, value]) =>
    [key, share(old && Object.hasOwn(old, key) ? old[key] : undefined, value)] as const);
  if (old && Object.keys(old).length === entries.length &&
      entries.every(([key, value]) => Object.hasOwn(old, key) && Object.is(old[key], value))) return old;
  return Object.freeze(Array.isArray(next) ? entries.map(([, value]) => value) : Object.fromEntries(entries));
}

export function createReactiveStore(project: ProjectDocument, ui: UIState) {
  let state = share(undefined, {
    project: { document: project, revision: project.revision },
    ui,
    interaction: { gestureType: 'idle', isInteracting: false },
    animationUI: { playbackState: 'stopped' }
  }) as State;
  const subscriptions = new Set<(snapshot: State) => void>();
  const pending: State[] = [];
  let notifying = false;

  function publish(next: State) {
    if (next === state) return;
    state = next;
    pending.push(next);
    if (notifying) return;
    notifying = true;
    try {
      while (pending.length) {
        const snapshot = pending.shift()!;
        for (const notify of [...subscriptions]) if (subscriptions.has(notify)) notify(snapshot);
      }
    } finally {
      pending.length = 0;
      notifying = false;
    }
  }

  const view = {
    snapshot: () => state,
    subscribe<T>(select: (snapshot: State) => T, listener: (value: T) => void,
      equal: (before: T, after: T) => boolean = Object.is) {
      let selected = select(state);
      const notify = (snapshot: State) => {
        const value = select(snapshot);
        if (!equal(selected, value)) {
          selected = value;
          listener(value);
        }
      };
      subscriptions.add(notify);
      return () => { subscriptions.delete(notify); };
    }
  };
  return {
    view,
    updateUI(ui: UIState) {
      const value = share(state.ui, ui) as State['ui'];
      if (value !== state.ui) publish(Object.freeze({ ...state, ui: value }));
    },
    publishPersistedProject(document: ProjectDocument) {
      if (document.projectId !== state.project.document.projectId || document.revision <= state.project.revision) {
        throw new Error('Cannot publish a different project or a non-advancing revision');
      }
      const project = share(state.project, { document, revision: document.revision }) as State['project'];
      publish(Object.freeze({ ...state, project }));
    },
    publishInteraction(interaction: GestureSnapshot) {
      const value = share(state.interaction, { gestureType: interaction.gestureType,
        isInteracting: interaction.isInteracting }) as GestureSnapshot;
      if (value !== state.interaction) publish(Object.freeze({ ...state, interaction: value }));
    },
    publishPlayback(playbackState: PlaybackState) {
      if (playbackState !== state.animationUI.playbackState) {
        publish(Object.freeze({ ...state, animationUI: Object.freeze({ playbackState }) }));
      }
    }
  };
}
