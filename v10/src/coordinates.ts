import type { Point, Rect, SceneTransform } from './domain.ts';

export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];
export type Viewport = { offset: Point; zoom: number; devicePixelRatio: number };
type Size = { width: number; height: number };

export function mapPoint([a, b, c, d, e, f]: Matrix, { x, y }: Point): Point {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

export function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError('Non-invertible transform');
  return [d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}

export function compose([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix {
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j,
    a * k + c * l + e, b * k + d * l + f];
}

export function clientToViewport(point: Point, elementBounds: Rect): Point {
  return { x: point.x - elementBounds.x, y: point.y - elementBounds.y };
}

export function viewportMatrix(view: Viewport): Matrix {
  if (!Number.isFinite(view.zoom) || view.zoom <= 0) throw new RangeError('Invalid zoom');
  return [view.zoom, 0, 0, view.zoom, view.offset.x, view.offset.y];
}

export function viewportToDeviceMatrix(view: Viewport): Matrix {
  const dpr = view.devicePixelRatio;
  if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError('Invalid device pixel ratio');
  return [dpr, 0, 0, dpr, 0, 0];
}

export const sceneWorldToViewport = (point: Point, view: Viewport) => mapPoint(viewportMatrix(view), point);
export const viewportToSceneWorld = (point: Point, view: Viewport) => mapPoint(invert(viewportMatrix(view)), point);
export const clipCanvasToViewport = (point: Point, view: Viewport) => mapPoint(viewportMatrix(view), point);
export const viewportToClipCanvas = (point: Point, view: Viewport) => mapPoint(invert(viewportMatrix(view)), point);
const add = (left: Point, right: Point) => ({ x: left.x + right.x, y: left.y + right.y });
const subtract = (left: Point, right: Point) => ({ x: left.x - right.x, y: left.y - right.y });
export const sourceToSpriteLocal = (point: Point, sourceTrimOrigin: Point) => subtract(point, sourceTrimOrigin);
export const spriteToSourceLocal = (point: Point, sourceTrimOrigin: Point) => add(point, sourceTrimOrigin);
export const frameDrawOrigin = (target: Point, pivotLocal: Point, offset: Point) => add(subtract(target, pivotLocal), offset);
export const spriteToClipCanvas = (point: Point, drawOrigin: Point) => add(point, drawOrigin);
export const clipCanvasToSprite = (point: Point, drawOrigin: Point) => subtract(point, drawOrigin);
export const spriteToAtlasLocal = (point: Point, atlasTrimOffset: Point) => subtract(point, atlasTrimOffset);
export const spriteToAtlasImage = (point: Point, atlasTrimOffset: Point, frameRect: Rect) =>
  add(spriteToAtlasLocal(point, atlasTrimOffset), frameRect);
export const atlasImageToSprite = (point: Point, atlasTrimOffset: Point, frameRect: Rect) =>
  add(subtract(point, frameRect), atlasTrimOffset);

export function spriteSceneMatrix(position: Point, size: Size, transform: SceneTransform): Matrix {
  const center = { x: size.width / 2, y: size.height / 2 };
  const radians = transform.rotation * Math.PI / 180;
  const a = Math.cos(radians) * transform.scaleX;
  const b = Math.sin(radians) * transform.scaleX;
  const c = -Math.sin(radians) * transform.scaleY;
  const d = Math.cos(radians) * transform.scaleY;
  return [a, b, c, d, position.x + center.x - a * center.x - c * center.y,
    position.y + center.y - b * center.x - d * center.y];
}

export const spriteLocalToViewport = (point: Point, spriteToViewport: Matrix) => mapPoint(spriteToViewport, point);
export const viewportToSpriteLocal = (point: Point, spriteToViewport: Matrix) => mapPoint(invert(spriteToViewport), point);

export function getSpriteTransformedBounds(size: Size, spriteToViewport: Matrix): Rect {
  const corners = [{ x: 0, y: 0 }, { x: size.width, y: 0 },
    { x: 0, y: size.height }, { x: size.width, y: size.height }]
    .map(point => mapPoint(spriteToViewport, point));
  const xs = corners.map(point => point.x);
  const ys = corners.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

type HitTarget = Size & {
  id: string;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  spriteToViewport: Matrix;
  alphaAt?: (x: number, y: number) => number;
};

// Ties follow draw order: the last item drawn is selected first.
export function hitTestSprite(point: Point, drawOrder: readonly HitTarget[]): string | undefined {
  let hit: HitTarget | undefined;
  for (const target of drawOrder) {
    if (!target.visible || target.locked || (hit && target.zIndex < hit.zIndex)) continue;
    const [a, b, c, d] = target.spriteToViewport;
    if (a * d - b * c === 0) continue;
    const local = viewportToSpriteLocal(point, target.spriteToViewport);
    if (local.x < 0 || local.y < 0 || local.x >= target.width || local.y >= target.height) continue;
    if (target.alphaAt?.(Math.floor(local.x), Math.floor(local.y)) === 0) continue;
    hit = target;
  }
  return hit?.id;
}

export function hitTestHandle(point: Point, handleViewport: Point, radiusCssPixels: number): boolean {
  return radiusCssPixels >= 0 &&
    Math.hypot(point.x - handleViewport.x, point.y - handleViewport.y) <= radiusCssPixels;
}
