import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const [v9Path, zipPath, output] = process.argv.slice(2);
const html = readFileSync(v9Path, 'utf8');
const helpers = html.slice(html.indexOf('function crc32('), html.indexOf('async function exportZip('));
const { crc32, zipStore } = new Function(helpers + '\nreturn { crc32, zipStore };')();
const original = readFileSync(zipPath);

function readZip(data) {
  const end = data.length - 22;
  assert.ok(end >= 0);
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  const count = data.readUInt16LE(end + 10);
  let cursor = data.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50);
    const method = data.readUInt16LE(cursor + 10);
    const expectedCrc = data.readUInt32LE(cursor + 16);
    const stored = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(cursor + 46, cursor + 46 + nameLength));
    assert.ok(!files.has(name) && !name.startsWith('/') && !name.includes('\\') && !name.includes(':') && !name.split('/').includes('..'));
    const local = data.readUInt32LE(cursor + 42);
    assert.equal(data.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const packed = data.subarray(start, start + stored);
    assert.ok(method === 0 || method === 8);
    const bytes = method === 0 ? packed : inflateRawSync(packed);
    assert.equal(bytes.length, size);
    assert.equal(crc32(bytes), expectedCrc);
    files.set(name, bytes);
    cursor += 46 + nameLength + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  return files;
}

const before = readZip(original);
const generated = Buffer.from(await zipStore(Array.from(before, ([name, data]) => ({ name, data }))).arrayBuffer());
assert.deepEqual(readZip(generated), before);
assert.throws(() => readZip(generated.subarray(0, -1)));
const damaged = Buffer.from(generated);
const firstPayload = 30 + damaged.readUInt16LE(26) + damaged.readUInt16LE(28);
damaged[firstPayload] ^= 1;
assert.throws(() => readZip(damaged));
writeFileSync(output, generated);
console.log(before.size + ' entries byte-identical after V9 ZIP writer round-trip; corrupt and truncated archives rejected');

