import type { Point, Rect } from '../src/domain.ts';
import { InteractionManager } from '../src/interaction.ts';

type SourceView = { key: string; bytes: Blob; width: number; height: number };

export function bindCropEditor(apply: (rect: Rect, create: boolean) => void) {
  const panel = document.querySelector<HTMLDetailsElement>('#source-crop')!;
  const surface = document.querySelector<HTMLElement>('#crop-surface')!;
  const image = document.querySelector<HTMLImageElement>('#crop-image')!;
  const fields = document.querySelector<HTMLFieldSetElement>('#crop-fields')!;
  const applyButton = document.querySelector<HTMLButtonElement>('#crop-apply')!;
  const originalGuide = document.querySelector<HTMLElement>('#crop-original')!;
  const draftGuide = document.querySelector<HTMLElement>('#crop-draft')!;
  const [x, y, width, height] = ['x', 'y', 'w', 'h'].map(key => document.querySelector<HTMLInputElement>('#crop-' + key)!);
  let source: SourceView | undefined;
  let original: Rect | undefined;
  let url: string | undefined;
  let enabled = false;

  function draw(element: HTMLElement, rect?: Rect) {
    element.hidden = !rect || !source || !Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0;
    if (!source || !rect) return;
    element.style.left = (100 * rect.x / source.width) + '%';
    element.style.top = (100 * rect.y / source.height) + '%';
    element.style.width = (100 * rect.width / source.width) + '%';
    element.style.height = (100 * rect.height / source.height) + '%';
  }

  function read(): Rect {
    return { x: x.valueAsNumber, y: y.valueAsNumber, width: width.valueAsNumber, height: height.valueAsNumber };
  }

  function show(rect?: Rect) {
    x.value = rect && Number.isFinite(rect.x) ? String(rect.x) : '';
    y.value = rect && Number.isFinite(rect.y) ? String(rect.y) : '';
    width.value = rect && Number.isFinite(rect.width) ? String(rect.width) : '';
    height.value = rect && Number.isFinite(rect.height) ? String(rect.height) : '';
    draw(draftGuide, rect);
  }

  const interaction = new InteractionManager<never>(surface, {
    begin(sample) {
      if (!enabled || !source || !image.naturalWidth) return;
      const { width, height } = source;
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const pointInSource = (point: Point) => ({
        x: Math.min(width, Math.max(0, Math.round(point.x / bounds.width * width))),
        y: Math.min(height, Math.max(0, Math.round(point.y / bounds.height * height)))
      });
      const start = pointInSource(sample.point);
      const before = read();
      const update = (point: Point) => {
        const end = pointInSource(point);
        const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
        show(rect);
        return rect.width > 0 && rect.height > 0;
      };
      return {
        type: 'draw-rect',
        update: next => { update(next.point); },
        finish: next => { if (!update(next.point)) show(before); return undefined; },
        cancel: () => show(before)
      };
    },
    publish() {},
    requestCommand() {}
  });

  fields.addEventListener('input', () => {
    const rect = read();
    if (Object.values(rect).every(Number.isFinite)) draw(draftGuide, rect);
    else draw(draftGuide);
  });
  document.querySelector('#crop-reset')!.addEventListener('click', () => show(original));
  document.querySelector('#crop-form')!.addEventListener('submit', event => {
    event.preventDefault();
    const create = (event as SubmitEvent).submitter?.id === 'crop-create';
    if (enabled && (create || original)) apply(read(), create);
  });

  return {
    select(next: SourceView | undefined, rect: Rect | undefined) {
      interaction.cancel('workspace-switch');
      if (next?.key !== source?.key) {
        if (url) URL.revokeObjectURL(url);
        url = next && URL.createObjectURL(next.bytes);
        if (url && next) {
          surface.style.setProperty('--crop-width', Math.min(700, next.width / next.height * 440) + 'px');
          image.src = url;
        } else image.removeAttribute('src');
      }
      source = next;
      original = rect;
      panel.hidden = !next;
      applyButton.disabled = !rect;
      draw(originalGuide, rect);
      show(rect);
    },
    setEnabled(value: boolean) {
      enabled = value;
      fields.disabled = !value;
      if (!value) interaction.cancel('tool-switch');
    }
  };
}
