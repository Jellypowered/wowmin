// Reads WDBC client database files (DBFilesClient/*.dbc): fixed-size records
// of (mostly) 32-bit fields followed by a string block.

export function readDbc(buffer) {
  if (!buffer || buffer.length < 20 || buffer.toString('latin1', 0, 4) !== 'WDBC') {
    throw new Error('Not a WDBC file.');
  }
  const recordCount = buffer.readUInt32LE(4);
  const fieldCount = buffer.readUInt32LE(8);
  const recordSize = buffer.readUInt32LE(12);
  const stringBlockSize = buffer.readUInt32LE(16);
  const stringBlockOffset = 20 + recordCount * recordSize;
  if (stringBlockOffset + stringBlockSize > buffer.length) throw new Error('Truncated WDBC file.');

  const stringAt = (offset) => {
    if (!offset) return '';
    const start = stringBlockOffset + offset;
    const end = buffer.indexOf(0, start);
    return buffer.toString('utf8', start, end < 0 ? stringBlockOffset + stringBlockSize : end);
  };

  const record = (index) => {
    const base = 20 + index * recordSize;
    return {
      uint: (field) => buffer.readUInt32LE(base + field * 4),
      int: (field) => buffer.readInt32LE(base + field * 4),
      float: (field) => buffer.readFloatLE(base + field * 4),
      string: (field) => stringAt(buffer.readUInt32LE(base + field * 4)),
      // By byte offset, for tables with byte-sized fields (SpellChainEffects's
      // colour), which put the fields after them off the 4-byte grid.
      byteAt: (offset) => buffer.readUInt8(base + offset),
      intAt: (offset) => buffer.readInt32LE(base + offset),
      floatAt: (offset) => buffer.readFloatLE(base + offset),
      stringAt: (offset) => stringAt(buffer.readUInt32LE(base + offset)),
      // A string's raw bytes, for strings that pack binary (a chain's combo).
      bytesAt: (offset) => {
        const start = buffer.readUInt32LE(base + offset);
        if (!start) return Buffer.alloc(0);
        const end = buffer.indexOf(0, stringBlockOffset + start);
        return buffer.subarray(stringBlockOffset + start, end < 0 ? stringBlockOffset + stringBlockSize : end);
      },
    };
  };

  return {
    recordCount,
    fieldCount,
    record,
    *records() {
      for (let index = 0; index < recordCount; index += 1) yield record(index);
    },
    // Records by their first field (the ID), built on first use.
    byId() {
      const map = new Map();
      for (let index = 0; index < recordCount; index += 1) map.set(buffer.readUInt32LE(20 + index * recordSize), record(index));
      return map;
    },
  };
}
