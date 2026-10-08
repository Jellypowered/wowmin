// Reads building (WMO) and doodad (M2) placements from a map's WDT and ADT
// tiles, converting them from the client's placement space to server world
// coordinates (X north, Y west, Z up) so telemetry positions need no mapping.

import { Map as WowMap } from '@wowserhq/format';

import { findChunk, readChunks, readCString, readFloats } from './chunks.mjs';

const WDT_FLAG_WMO_ONLY = 0x1;
const MODF_ENTRY_SIZE = 64;
const MDDF_ENTRY_SIZE = 36;

export function toM2Path(name) {
  return name.replace(/\.(mdx|mdl)$/i, '.m2');
}

export function placementToWorld(position, rotation, scale = 1) {
  return {
    position: WowMap.getNormalizedDefPosition(position),
    rotation: WowMap.getNormalizedDefRotation(rotation),
    scale,
  };
}

function readModfEntry(data, offset, nameForId) {
  return {
    name: nameForId(data.readUInt32LE(offset)),
    uniqueId: data.readUInt32LE(offset + 4),
    ...placementToWorld(readFloats(data, offset + 8, 3), readFloats(data, offset + 20, 3)),
    doodadSet: data.readUInt16LE(offset + 58),
  };
}

export function readWdt(buffer) {
  const chunks = readChunks(buffer);
  const header = findChunk(chunks, 'MPHD');
  const main = findChunk(chunks, 'MAIN');
  if (!header || !main) throw new Error('WDT is missing MPHD or MAIN.');

  const tiles = [];
  for (let index = 0; index < 64 * 64; index += 1) {
    if (main.readUInt32LE(index * 8) & 1) tiles.push({ x: index % 64, y: Math.floor(index / 64) });
  }

  let wmo = null;
  const names = findChunk(chunks, 'MWMO');
  const placements = findChunk(chunks, 'MODF');
  if (header.readUInt32LE(0) & WDT_FLAG_WMO_ONLY && names && placements?.length >= MODF_ENTRY_SIZE) {
    wmo = readModfEntry(placements, 0, () => readCString(names, 0));
  }
  return { wmoOnly: Boolean(wmo), tiles, wmo };
}

export function readAdtPlacements(buffer) {
  const chunks = readChunks(buffer);
  const nameTable = (blockId, indexId) => {
    const block = findChunk(chunks, blockId);
    const offsets = findChunk(chunks, indexId);
    return (id) => readCString(block, offsets.readUInt32LE(id * 4));
  };

  const wmos = [];
  const modf = findChunk(chunks, 'MODF');
  if (modf?.length) {
    const wmoName = nameTable('MWMO', 'MWID');
    for (let offset = 0; offset + MODF_ENTRY_SIZE <= modf.length; offset += MODF_ENTRY_SIZE) {
      wmos.push(readModfEntry(modf, offset, wmoName));
    }
  }

  const doodads = [];
  const mddf = findChunk(chunks, 'MDDF');
  if (mddf?.length) {
    const doodadName = nameTable('MMDX', 'MMID');
    for (let offset = 0; offset + MDDF_ENTRY_SIZE <= mddf.length; offset += MDDF_ENTRY_SIZE) {
      doodads.push({
        name: toM2Path(doodadName(mddf.readUInt32LE(offset))),
        uniqueId: mddf.readUInt32LE(offset + 4),
        ...placementToWorld(readFloats(mddf, offset + 8, 3), readFloats(mddf, offset + 20, 3),
          mddf.readUInt16LE(offset + 32) / 1024),
      });
    }
  }
  return { wmos, doodads };
}

// The same building or doodad is listed in every ADT tile it overlaps.
export function dedupeByUniqueId(placements) {
  const seen = new Map();
  for (const placement of placements) {
    if (!seen.has(placement.uniqueId)) seen.set(placement.uniqueId, placement);
  }
  return [...seen.values()];
}
