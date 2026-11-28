import { invariant, safeAssetPath } from './project.ts';

const maxEntryBytes = 128 * 1024 ** 2;
const maxArchiveBytes = 512 * 1024 ** 2;
const maxEntries = 8192;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

async function extract(payload: Uint8Array<ArrayBuffer>, method: number, size: number) {
  if (method === 0) {
    invariant(payload.length === size, 'Stored ZIP member has inconsistent length');
    return payload;
  }
  const reader = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const bytes = new Uint8Array(size);
  let count = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      invariant(count + chunk.value.length <= size, 'ZIP member exceeds declared expanded size');
      bytes.set(chunk.value, count);
      count += chunk.value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  invariant(count === size, 'ZIP member has incorrect expanded size');
  return bytes;
}

type Member = { name: string; start: number; end: number; local: number; size: number; method: number; crc: number };

export async function readV9Zip(archive: Blob): Promise<Map<string, Blob>> {
  invariant(archive.size >= 22 && archive.size <= maxArchiveBytes, 'Unsupported ZIP archive size');
  const buffer = await archive.arrayBuffer();
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  let end = data.length - 22;
  const earliest = Math.max(0, end - 0xffff);
  while (end >= earliest && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== data.length)) end--;
  invariant(end >= earliest && u16(end + 4) === 0 && u16(end + 6) === 0, 'Missing ZIP directory or split archive');
  const count = u16(end + 10);
  const directory = u32(end + 16);
  invariant(count <= maxEntries && count === u16(end + 8) && directory + u32(end + 12) === end,
    'Invalid or unsupported ZIP central directory');

  const names = new Set<string>();
  const members: Member[] = [];
  let cursor = directory;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    invariant(cursor + 46 <= end && u32(cursor) === 0x02014b50, 'Invalid ZIP member header');
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const compressedSize = u32(cursor + 20);
    const size = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + u16(cursor + 30) + u16(cursor + 32);
    const local = u32(cursor + 42);
    invariant(next <= end && (flags & ~0x080e) === 0 && (method === 0 || method === 8) && u16(cursor + 34) === 0,
      'Unsupported ZIP entry encoding, compression or encryption');
    expanded += size;
    invariant(size <= maxEntryBytes && expanded <= maxArchiveBytes, 'ZIP contents exceed expanded size limits');
    const rawName = data.subarray(nameStart, nameStart + nameLength);
    const name = utf8.decode(rawName);
    const isDirectory = name.endsWith('/');
    const path = isDirectory ? name.slice(0, -1) : name;
    const normalized = path.normalize('NFC');
    invariant(safeAssetPath(path) && !names.has(normalized), 'Unsafe or duplicate ZIP path: ' + name);
    names.add(normalized);
    invariant(local + 30 <= directory && u32(local) === 0x04034b50 &&
      u16(local + 6) === flags && u16(local + 8) === method, 'Invalid ZIP local member: ' + name);
    const localNameLength = u16(local + 26);
    const start = local + 30 + localNameLength + u16(local + 28);
    invariant(start + compressedSize <= directory && localNameLength === nameLength &&
      rawName.every((byte, offset) => byte === data[local + 30 + offset]), 'ZIP local and central name or size disagree');
    if ((flags & 8) === 0) {
      invariant(u32(local + 14) === crc && u32(local + 18) === compressedSize && u32(local + 22) === size,
        'ZIP local and central metadata disagree');
    }
    invariant(!isDirectory || size === 0, 'ZIP directory entry contains data');
    members.push({ name, start, end: start + compressedSize, local, size, method, crc });
    cursor = next;
  }
  invariant(cursor === end, 'Unexpected trailing ZIP directory data');
  const byOffset = [...members].sort((left, right) => left.local - right.local);
  for (let index = 1; index < byOffset.length; index++) {
    invariant(byOffset[index - 1].end <= byOffset[index].local, 'Overlapping ZIP members');
  }

  const files = new Map<string, Blob>();
  for (const member of members) {
    const bytes = await extract(data.subarray(member.start, member.end), member.method, member.size);
    invariant(crc32(bytes) === member.crc, 'ZIP CRC mismatch: ' + member.name);
    if (!member.name.endsWith('/')) files.set(member.name, new Blob([bytes]));
  }
  return files;
}

export async function readV9Archive(archive: Blob) {
  const files = await readV9Zip(archive);
  const json = files.get('manifest.json');
  invariant(json, 'V9 ZIP is missing manifest.json');
  const manifest: unknown = JSON.parse(utf8.decode(await json.arrayBuffer()));
  invariant(manifest && typeof manifest === 'object' && 'format' in manifest &&
    manifest.format === 'spatial-scene-layout/v2' && 'sprites' in manifest &&
    Array.isArray(manifest.sprites), 'Unsupported V9 manifest format');
  files.delete('manifest.json');
  return { manifest: { ...manifest, format: 'spatial-scene-layout/v2' as const, sprites: manifest.sprites as unknown[] }, files };
}
