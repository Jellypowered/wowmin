// Minimal reader for the IFF-style chunk containers used by WDT, ADT, and WMO
// files. Chunk IDs are stored byte-reversed on disk ("REVM" for MVER).

export function readChunks(buffer, start = 0, end = buffer.length) {
  const chunks = [];
  let offset = start;
  while (offset + 8 <= end) {
    const id = buffer.toString('ascii', offset, offset + 4).split('').reverse().join('');
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    chunks.push({ id, data: buffer.subarray(dataStart, Math.min(dataStart + size, end)) });
    offset = dataStart + size;
  }
  return chunks;
}

export function findChunk(chunks, id) {
  return chunks.find((chunk) => chunk.id === id)?.data ?? null;
}

export function readCString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return buffer.toString('latin1', offset, end < 0 ? buffer.length : end);
}

export function readFloats(buffer, offset, count) {
  return Array.from({ length: count }, (_, index) => buffer.readFloatLE(offset + index * 4));
}
