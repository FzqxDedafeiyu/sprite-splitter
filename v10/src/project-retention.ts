import type { HistorySnapshot } from './session-history.ts';

const ageLimit = 30 * 24 * 60 * 60 * 1000;
const byteLimit = 1024 ** 3;
type Timeline = { id: string; snapshot: HistorySnapshot<unknown> };

export function trimProjectHistory(timelines: Timeline[], now: number) {
  const changed = new Set<string>();
  const cutoff = now - ageLimit;
  for (const { id, snapshot } of timelines) {
    for (const direction of ['undo', 'redo'] as const) {
      const entries = snapshot[direction];
      let lastExpired = -1;
      for (const [index, entry] of entries.entries()) if (entry.createdAt <= cutoff) lastExpired = index;
      if (lastExpired >= 0) {
        // Never leave a hole in the retained command chain.
        snapshot[direction] = direction === 'redo' ? [] : entries.slice(lastExpired + 1);
        changed.add(id);
      }
    }
  }
  const entries = timelines.flatMap(timeline => (['undo', 'redo'] as const).flatMap(direction =>
    timeline.snapshot[direction].map(entry => ({
      timeline, direction, entry
    })))).sort((left, right) => left.entry.createdAt - right.entry.createdAt);
  let count = entries.length;
  let bytes = entries.reduce((sum, { entry }) => sum + entry.bytes, 0);
  for (const { timeline, direction, entry } of entries) {
    if (count <= 100 && bytes <= byteLimit) break;
    const stack = timeline.snapshot[direction];
    const index = stack.indexOf(entry);
    if (index < 0) continue;
    const discarded = direction === 'redo' ? stack.splice(0) : stack.splice(0, index + 1);
    bytes -= discarded.reduce((sum, item) => sum + item.bytes, 0);
    count -= discarded.length;
    changed.add(timeline.id);
  }
  const pinnedMaskIds = new Set<string>();
  for (const { snapshot } of timelines) {
    for (const entry of [...snapshot.undo, ...snapshot.redo]) {
      const change = entry.change;
      if (!change || typeof change !== 'object' || !('kind' in change) || change.kind !== 'mask-presence') continue;
      for (const direction of ['undo', 'redo'] as const) {
        const edit = (change as Record<string, unknown>)[direction];
        if (edit && typeof edit === 'object' && 'resourceId' in edit && typeof edit.resourceId === 'string') {
          pinnedMaskIds.add(edit.resourceId);
        }
      }
    }
  }
  return { changed, pinnedMaskIds };
}
