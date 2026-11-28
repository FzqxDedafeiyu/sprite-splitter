export type HistoryDirection = 'undo' | 'redo';

type Entry<T> = { change: T; revision: number; segment: number; createdAt: number; bytes: number };
const retention = 30 * 24 * 60 * 60 * 1000;

export class SessionHistory<T> {
  #undo: Entry<T>[] = [];
  #redo: Entry<T>[] = [];
  #segment = 0;

  record(change: T, before: number, after: number, bytes = 0) {
    this.#prune();
    const tip = this.#undo.at(-1);
    if (!tip || tip.revision !== before) this.#segment++;
    this.#undo.push({ change, revision: after, segment: this.#segment, createdAt: Date.now(), bytes });
    this.#redo = [];
    let total = this.#undo.reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.#undo.length > 100 || total > 1024 ** 3) total -= this.#undo.shift()!.bytes;
  }

  peek(direction: HistoryDirection) {
    this.#prune();
    return (direction === 'undo' ? this.#undo : this.#redo).at(-1);
  }

  complete(direction: HistoryDirection, revision: number) {
    const [from, to] = direction === 'undo' ? [this.#undo, this.#redo] : [this.#redo, this.#undo];
    const entry = from.pop()!;
    const previous = from.at(-1);
    if (previous?.segment === entry.segment) previous.revision = revision;
    to.push({ ...entry, revision });
  }

  #prune() {
    const cutoff = Date.now() - retention;
    this.#undo = this.#undo.filter(entry => entry.createdAt > cutoff);
    this.#redo = this.#redo.filter(entry => entry.createdAt > cutoff);
  }
}
