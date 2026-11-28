import type { Point } from './domain.ts';
import { clientToViewport } from './coordinates.ts';

export type GestureType = 'pan' | 'drag-sprite' | 'resize-sprite' | 'draw-rect' | 'draw-polygon' |
  'lasso' | 'refine-brush' | 'move-pivot' | 'move-frame-offset' | 'timeline-reorder';
export type GestureSnapshot = Readonly<{ gestureType: GestureType | 'idle'; isInteracting: boolean }>;
export type PointerSample = Readonly<{ point: Point; shift: boolean; alt: boolean; pressure: number }>;
export type Gesture<Command> = {
  type: GestureType;
  update(sample: PointerSample): void;
  finish(sample: PointerSample): Command | undefined;
  cancel(reason: string): void;
};
type Session<Command> = { pointerId: number; gesture: Gesture<Command> };
type Hooks<Command> = {
  begin(sample: PointerSample, event: PointerEvent): Gesture<Command> | undefined;
  publish(snapshot: GestureSnapshot): void;
  requestCommand(command: Command): void;
};
const idle: GestureSnapshot = Object.freeze({ gestureType: 'idle', isInteracting: false });

function isControl(event: Event): boolean {
  return event.composedPath().some(node => node instanceof Element &&
    node.matches('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable=false]), [data-ignore-gesture]'));
}

export class InteractionManager<Command> {
  #session?: Session<Command>;
  #listeners = new AbortController();
  #destroyed = false;
  #inTransition = false;

  constructor(private readonly surface: HTMLElement, private readonly hooks: Hooks<Command>) {
    const options = { signal: this.#listeners.signal };
    surface.addEventListener('pointerdown', this.#begin, options);
    surface.addEventListener('pointermove', this.#move, options);
    surface.addEventListener('pointerup', this.#finish, options);
    surface.addEventListener('pointercancel', this.#cancelPointer, options);
    surface.addEventListener('lostpointercapture', this.#lostCapture, options);
    surface.ownerDocument.defaultView?.addEventListener('blur', this.#blur, options);
  }

  #sample(event: PointerEvent): PointerSample {
    return { point: clientToViewport({ x: event.clientX, y: event.clientY }, this.surface.getBoundingClientRect()),
      shift: event.shiftKey, alt: event.altKey, pressure: event.pressure };
  }

  #begin = (event: PointerEvent) => {
    if (this.#destroyed || this.#inTransition || this.#session || !event.isPrimary ||
        event.button !== 0 || isControl(event)) return;
    const gesture = this.hooks.begin(this.#sample(event), event);
    if (!gesture) return;
    try {
      this.surface.setPointerCapture(event.pointerId);
    } catch {
      gesture.cancel('capture-failed');
      return;
    }
    this.#session = { pointerId: event.pointerId, gesture };
    this.hooks.publish(Object.freeze({ gestureType: gesture.type, isInteracting: true }));
  };

  #move = (event: PointerEvent) => {
    if (this.#session?.pointerId !== event.pointerId) return;
    try { this.#session.gesture.update(this.#sample(event)); }
    catch (error) {
      this.cancel('update-failed');
      throw error;
    }
  };

  #finish = (event: PointerEvent) => {
    if (this.#session?.pointerId !== event.pointerId) return;
    const session = this.#session;
    let command: Command | undefined;
    this.#exit(session, () => {
      try { command = session.gesture.finish(this.#sample(event)); }
      catch (error) {
        session.gesture.cancel('finish-failed');
        throw error;
      }
    });
    if (command !== undefined) this.hooks.requestCommand(command);
  };

  #cancelPointer = (event: PointerEvent) => {
    if (this.#session?.pointerId === event.pointerId) this.cancel('pointer-cancel');
  };

  #lostCapture = (event: PointerEvent) => {
    if (this.#session?.pointerId === event.pointerId) this.cancel('capture-lost');
  };

  #blur = () => this.cancel('window-blur');

  #exit(session: Session<Command>, end: () => void) {
    this.#session = undefined;
    this.#inTransition = true;
    try { end(); }
    finally {
      try {
        if (this.surface.hasPointerCapture(session.pointerId)) this.surface.releasePointerCapture(session.pointerId);
      } finally {
        this.#inTransition = false;
        this.hooks.publish(idle);
      }
    }
  }

  cancel(reason: 'workspace-switch' | 'tool-switch' | 'import' | 'auto-detect' | 'unmount' |
      'pointer-cancel' | 'capture-lost' | 'window-blur' | 'update-failed'): void {
    const session = this.#session;
    if (session) this.#exit(session, () => session.gesture.cancel(reason));
  }

  destroy(): void {
    this.#destroyed = true;
    try { this.cancel('unmount'); } finally { this.#listeners.abort(); }
  }
}
