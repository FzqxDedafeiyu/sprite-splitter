type Point = { x: number; y: number };
type View = { origin: Point; zoom: number; dpr: number };

export function toDevice(source: Point, view: View): Point {
  return {
    x: (source.x * view.zoom + view.origin.x) * view.dpr,
    y: (source.y * view.zoom + view.origin.y) * view.dpr
  };
}

export function toSource(device: Point, view: View): Point {
  return {
    x: (device.x / view.dpr - view.origin.x) / view.zoom,
    y: (device.y / view.dpr - view.origin.y) / view.zoom
  };
}

export function toSprite(source: Point, trimOrigin: Point): Point {
  return { x: source.x - trimOrigin.x, y: source.y - trimOrigin.y };
}
