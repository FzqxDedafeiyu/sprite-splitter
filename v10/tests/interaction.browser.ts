import { WorkspaceLifecycle } from '../src/workspace-lifecycle.ts';
import { compose, viewportMatrix, spriteSceneMatrix, mapPoint, viewportToSpriteLocal,
  getSpriteTransformedBounds, hitTestSprite, hitTestHandle, sourceToSpriteLocal, frameDrawOrigin,
  spriteToAtlasImage, atlasImageToSprite, viewportToDeviceMatrix } from '../src/coordinates.ts';
import { InteractionManager, type GestureSnapshot } from '../src/interaction.ts';
import { createProject } from '../src/project.ts';
import { createReactiveStore } from '../src/reactive-store.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function coordinateTests() {
  const view = { offset: { x: -10, y: 18 }, zoom: 1.5, devicePixelRatio: 2 };
  const size = { width: 8, height: 4 };
  const matrix = compose(viewportMatrix(view),
    spriteSceneMatrix({ x: 50, y: 23 }, size, { rotation: 90, scaleX: -2, scaleY: 1 }));
  const target = { ...size, visible: true, locked: false, zIndex: 1, spriteToViewport: matrix };
  const point = mapPoint(matrix, { x: 3.25, y: 2.5 });
  const local = viewportToSpriteLocal(point, matrix);
  assert(Math.hypot(local.x - 3.25, local.y - 2.5) < 1e-10, 'rotated transform round trip');
  const bounds = getSpriteTransformedBounds(size, matrix);
  assert(Math.abs(bounds.width - 6) < 1e-10 && Math.abs(bounds.height - 24) < 1e-10, 'rotated bounds');
  assert(mapPoint(viewportToDeviceMatrix(view), point).x === point.x * 2, 'DPR conversion');
  assert(hitTestSprite(point, [
    { ...target, id: 'base' }, { ...target, id: 'top', zIndex: 2 },
    { ...target, id: 'alpha', zIndex: 3, alphaAt: () => 0 },
    { ...target, id: 'locked', zIndex: 4, locked: true },
    { ...target, id: 'hidden', zIndex: 5, visible: false }
  ]) === 'top', 'order, lock, visibility and alpha');
  assert(hitTestSprite(point, [{ ...target, id: 'first' }, { ...target, id: 'last' }]) === 'last', 'draw order tie');
  assert(hitTestSprite(mapPoint(matrix, { x: 9, y: 2 }), [{ ...target, id: 'outside' }]) === undefined,
    'excludes points outside the rotated rectangle');
  assert(hitTestHandle({ x: 13, y: 14 }, { x: 10, y: 10 }, 5), 'handle radius in CSS pixels');
  const pivot = sourceToSpriteLocal({ x: 52, y: 34 }, { x: 47, y: 28 });
  const origin = frameDrawOrigin({ x: 20, y: 50 }, pivot, { x: 1, y: -2 });
  assert(origin.x === 16 && origin.y === 42, 'Trim applied once');
  const rect = { x: 100, y: 30, width: 20, height: 20 };
  const trim = { x: 3, y: 4 };
  const atlas = spriteToAtlasImage(pivot, trim, rect);
  const recovered = atlasImageToSprite(atlas, trim, rect);
  assert(atlas.x === 102 && atlas.y === 32 && recovered.x === pivot.x && recovered.y === pivot.y,
    'atlas trim remains separate');
}

function gestureTests() {
  const surface = document.createElement('div');
  const button = document.createElement('button');
  surface.append(button);
  document.body.append(surface);
  let captured: number | undefined;
  surface.setPointerCapture = id => { captured = id; };
  surface.releasePointerCapture = id => { if (captured === id) captured = undefined; };
  surface.hasPointerCapture = id => captured === id;
  let updates = 0;
  const commands: number[] = [];
  const cancellations: string[] = [];
  const snapshots: GestureSnapshot[] = [];
  const manager = new InteractionManager(surface, {
    begin: () => ({
      type: 'draw-rect',
      update: () => { updates++; },
      finish: sample => sample.point.x,
      cancel: reason => { cancellations.push(reason); }
    }),
    publish: value => snapshots.push(value),
    requestCommand: command => commands.push(command as number)
  });
  function event(type: string, id: number, element: HTMLElement = surface, isPrimary = true) {
    element.dispatchEvent(new PointerEvent(type, { pointerId: id, isPrimary, bubbles: true, clientX: 30 }));
  }
  try {
    event('pointerdown', 1, button);
    event('pointerdown', 2, surface, false);
    assert(captured === undefined, 'control and secondary pointer excluded');
    event('pointerdown', 3);
    event('pointerdown', 4);
    event('pointermove', 4);
    event('pointerup', 4);
    assert(captured === 3 && updates === 0 && commands.length === 0, 'gesture owns one pointer');
    event('pointermove', 3);
    event('pointercancel', 3);
    event('pointerup', 3);
    assert(captured === undefined && updates === 1 && commands.length === 0, 'cancel discards draft');
    event('pointerdown', 5);
    event('lostpointercapture', 5);
    event('pointerdown', 6);
    window.dispatchEvent(new Event('blur'));
    event('pointerdown', 7);
    manager.cancel('workspace-switch');
    event('pointerdown', 8);
    event('pointerup', 8);
    event('pointerup', 8);
    assert(commands.length === 1 && captured === undefined, 'successful finish dispatches exactly once');
    event('pointerdown', 9);
    manager.destroy();
    event('pointerdown', 10);
    assert(cancellations.join(',') === 'pointer-cancel,capture-lost,window-blur,workspace-switch,unmount',
      'abnormal exits clean up all gestures');
    assert(snapshots.at(-1)?.gestureType === 'idle' && snapshots.every(snapshot =>
      Object.isFrozen(snapshot) && Object.keys(snapshot).length === 2), 'read-only gesture snapshot');
  } finally { manager.destroy(); surface.remove(); }
}

function subscriptionTests() {
  const project = createProject();
  const ui = { activeWorkspace: 'scene', activeToolByWorkspace: { scene: 'select' },
    selectedSpriteIds: [], panels: {}, viewportByWorkspace: {} };
  const store = createReactiveStore(project, ui);
  const projectEvents: number[] = [];
  let settingsEvents = 0;
  let gestureEvents = 0;
  let playbackEvents = 0;
  store.view.subscribe(state => state.project.revision, value => projectEvents.push(value));
  store.view.subscribe(state => state.project.document.projectSettings, () => { settingsEvents++; });
  store.view.subscribe(state => state.interaction, () => { gestureEvents++; });
  store.view.subscribe(state => state.animationUI.playbackState, () => { playbackEvents++; });
  store.updateUI({ ...ui, activeWorkspace: 'animation' });
  store.publishInteraction({ gestureType: 'draw-rect', isInteracting: true });
  store.publishPlayback('playing');
  project.projectSettings.defaultFps = 99;
  assert(store.view.snapshot().project.document.projectSettings.defaultFps === 12, 'immutable project snapshot');
  project.projectSettings.defaultFps = 12;
  store.publishPersistedProject({ ...project, revision: 2, legacyExtensions: { label: 'changed' } });
  assert(settingsEvents === 0 && projectEvents.join() === '2', 'subscriptions preserve unrelated references');
  assert(gestureEvents === 1 && playbackEvents === 1, 'playback and interaction are independent');
  assert(Object.isFrozen(store.view.snapshot().ui.activeToolByWorkspace), 'immutable nested UI state');
}

function workspaceTests() {
  let ui = { activeWorkspace: 'scene', activeToolByWorkspace: { scene: 'select', animation: 'pivot' } as Record<string, string> };
  const events: string[] = [];
  const lifecycle = new WorkspaceLifecycle({ cancel: reason => events.push(reason), destroy: () => events.push('destroy') },
    () => ui, value => { ui = value; });
  const sceneTask = lifecycle.signal;
  lifecycle.switchWorkspace('animation');
  assert(sceneTask.aborted && ui.activeToolByWorkspace.animation === 'pivot', 'workspace preserves tool preference');
  const pivotTask = lifecycle.signal;
  lifecycle.activateTool('pan');
  assert(pivotTask.aborted && ui.activeToolByWorkspace.animation === 'pan' &&
    ui.activeToolByWorkspace.scene === 'select', 'tool switch cancels only the active session');
  lifecycle.beforeImport();
  lifecycle.beforeAutoDetect();
  const task = lifecycle.signal;
  lifecycle.destroy();
  assert(task.aborted && events.join(',') === 'workspace-switch,tool-switch,import,auto-detect,destroy',
    'workspace tasks cancel at transition boundaries');
}

try {
  workspaceTests();
  coordinateTests();
  gestureTests();
  subscriptionTests();
  document.querySelector('#result')!.textContent = JSON.stringify({
    coordinates: 'pass', hitTesting: 'pass', gestures: 'pass', subscriptions: 'pass', workspace: 'pass'
  });
} catch (error) {
  document.querySelector('#result')!.textContent = JSON.stringify({ test: { error: String(error) } });
}

// CDP sends browser-trusted pointer events to this surface, exercising native capture.
const captureSurface = document.createElement('div');
captureSurface.style.cssText = 'position:fixed;left:20px;top:120px;width:140px;height:100px;background:#ccc';
captureSurface.id = 'capture-surface';
document.body.append(captureSurface);
let nativeResult: { captured: boolean; commandCount: number; inactive: boolean } = {
  captured: false, commandCount: 0, inactive: true
};
const resultNode = document.createElement('output');
resultNode.id = 'native-result';
document.body.append(resultNode);
function renderNativeResult() { resultNode.textContent = JSON.stringify(nativeResult); }
renderNativeResult();
const nativeManager = new InteractionManager(captureSurface, {
  begin: (_sample, event) => ({
    type: 'drag-sprite',
    update: () => { nativeResult.captured = captureSurface.hasPointerCapture(event.pointerId); },
    finish: () => {
      nativeResult.captured ||= captureSurface.hasPointerCapture(event.pointerId);
      return true;
    },
    cancel() {}
  }),
  publish: snapshot => { nativeResult.inactive = !snapshot.isInteracting; renderNativeResult(); },
  requestCommand: () => { nativeResult.commandCount++; renderNativeResult(); }
});
window.addEventListener('pagehide', () => nativeManager.destroy(), { once: true });
