import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

// Fixture inspection only. This is deliberately not a general-purpose ZIP parser.
export async function readOfficeTestZip(blob: Blob): Promise<Map<string, string>> {
  const maxArchive = 4 * 1024 * 1024;
  const maxEntry = 8 * 1024 * 1024;
  const maxExpanded = 24 * 1024 * 1024;
  assert.ok(blob.size >= 22 && blob.size <= maxArchive, "Office ZIP fixture size is out of bounds.");
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, "Office file must start with a ZIP local header.");
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (end >= earliest && (bytes.readUInt32LE(end) !== 0x06054b50
    || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  assert.ok(end >= earliest, "ZIP central directory is missing.");
  assert.equal(bytes.readUInt16LE(end + 4), 0, "Multi-disk ZIP is not supported.");
  assert.equal(bytes.readUInt16LE(end + 6), 0, "Multi-disk ZIP is not supported.");
  const entries = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), entries);
  assert.ok(entries > 0 && entries <= 512, "Too many ZIP fixture entries.");
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  assert.equal(directoryStart + directorySize, end, "ZIP64 or malformed central directory.");
  let cursor = directoryStart;
  let expanded = 0;
  const result = new Map<string, string>();
  for (let i = 0; i < entries; i++) {
    assert.ok(cursor + 46 <= end, "Truncated ZIP directory entry.");
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(flags & 1, 0, "Encrypted ZIP fixtures are not supported.");
    assert.equal(bytes.readUInt16LE(cursor + 34), 0);
    assert.ok(method === 0 || method === 8, "Unsupported ZIP fixture compression.");
    assert.ok(size <= maxEntry && compressedSize <= maxArchive, "ZIP fixture entry is too large.");
    expanded += size;
    assert.ok(expanded <= maxExpanded, "Expanded ZIP fixture is too large.");
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    assert.ok(next <= end && nameLength > 0, "Invalid ZIP fixture name.");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    assert.ok(!name.startsWith("/") && !name.includes("\\") && !name.includes("\0")
      && !name.split("/").includes("..") && !result.has(name), "Unsafe or duplicate ZIP fixture name.");
    assert.ok(local + 30 <= directoryStart, "Invalid ZIP fixture local header.");
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), flags);
    assert.equal(bytes.readUInt16LE(local + 8), method);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    assert.equal(localNameLength, nameLength);
    assert.deepEqual(bytes.subarray(local + 30, local + 30 + localNameLength), nameBytes);
    const start = local + 30 + localNameLength + localExtraLength;
    assert.ok(start <= directoryStart && start + compressedSize <= directoryStart, "Truncated ZIP fixture entry.");
    const compressed = bytes.subarray(start, start + compressedSize);
    const content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(size + 1, maxEntry) });
    assert.equal(content.length, size, "ZIP fixture size mismatch.");
    result.set(name, content.toString("utf8"));
    cursor = next;
  }
  assert.equal(cursor, end, "Unexpected trailing central directory data.");
  return result;
}
