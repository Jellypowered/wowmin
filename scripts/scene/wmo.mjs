// Loads a WMO (world map object: dungeon buildings and caves) into plain
// arrays. @wowserhq/format parses group geometry and material textures; the
// pieces it does not expose (MOGP header, material blend mode, doodad lists)
// are read directly from the chunks.

import { MapObj, MapObjGroup } from '@wowserhq/format';

import { findChunk, readChunks, readCString, readFloats } from './chunks.mjs';
import { toM2Path } from './placement.mjs';

export const WMO_GROUP_FLAG_VERTEX_COLORS = 0x4;
export const WMO_GROUP_FLAG_EXTERIOR = 0x8;
export const WMO_GROUP_FLAG_INTERIOR = 0x2000;
export const WMO_MATERIAL_FLAG_UNCULLED = 0x4;
export const WMO_MATERIAL_FLAG_CLAMP_S = 0x40;
export const WMO_MATERIAL_FLAG_CLAMP_T = 0x80;
const WMO_ROOT_FLAG_VERTEX_COLORS_FIXED = 0x8;

const MOGP_HEADER_SIZE = 0x44;
const MOMT_ENTRY_SIZE = 64;
const MODS_ENTRY_SIZE = 32;
const MODD_ENTRY_SIZE = 40;

const asBytes = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

export function groupFileName(rootName, index) {
  return rootName.replace(/\.wmo$/i, `_${String(index).padStart(3, '0')}.wmo`);
}

export function readGroupHeader(groupBuffer) {
  const mogp = findChunk(readChunks(groupBuffer), 'MOGP');
  if (!mogp || mogp.length < MOGP_HEADER_SIZE) throw new Error('WMO group is missing its MOGP header.');
  const doodadRefs = findChunk(readChunks(mogp, MOGP_HEADER_SIZE), 'MODR');
  return {
    flags: mogp.readUInt32LE(0x08),
    boundingBox: readFloats(mogp, 0x0C, 6),
    transBatchCount: mogp.readUInt16LE(0x28),
    // WMOAreaTable group ID; the server reports this as the player's wmoGroupId.
    groupId: mogp.readUInt32LE(0x38),
    doodadRefs: doodadRefs
      ? Array.from({ length: doodadRefs.length / 2 }, (_, index) => doodadRefs.readUInt16LE(index * 2))
      : [],
  };
}

export function readDoodadDefinitions(rootChunks) {
  const sets = [];
  const mods = findChunk(rootChunks, 'MODS');
  for (let offset = 0; mods && offset + MODS_ENTRY_SIZE <= mods.length; offset += MODS_ENTRY_SIZE) {
    sets.push({
      name: readCString(mods.subarray(offset, offset + 20), 0),
      start: mods.readUInt32LE(offset + 20),
      count: mods.readUInt32LE(offset + 24),
    });
  }

  const names = findChunk(rootChunks, 'MODN');
  const definitions = [];
  const modd = findChunk(rootChunks, 'MODD');
  for (let offset = 0; modd && names && offset + MODD_ENTRY_SIZE <= modd.length; offset += MODD_ENTRY_SIZE) {
    const [x, y, z, w] = readFloats(modd, offset + 16, 4);
    definitions.push({
      name: toM2Path(readCString(names, modd.readUInt32LE(offset) & 0xFFFFFF)),
      position: readFloats(modd, offset + 4, 3),
      rotation: [x, y, z, w],
      scale: modd.readFloatLE(offset + 32),
    });
  }
  return { sets, definitions };
}

// The client's FixColorVertexAlpha for the interior/exterior batches, as in
// @wowserhq/format but reading the last transparent batch (that library reads
// one past it, which crashes when every batch is transparent).
export function fixVertexColors(bgra, batches, transBatchCount) {
  const colors = Uint8Array.from(bgra);
  const lastTransBatch = transBatchCount > 0 ? batches[Math.min(transBatchCount, batches.length) - 1] : null;
  const firstFixed = lastTransBatch ? lastTransBatch.lastVertex + 1 : 0;
  for (let offset = firstFixed * 4; offset + 3 < colors.length; offset += 4) {
    const alpha = colors[offset + 3];
    for (let channel = 0; channel < 3; channel += 1) {
      const value = colors[offset + channel];
      colors[offset + channel] = Math.min(((value + ((value * alpha / 64) | 0)) / 2) | 0, 255);
    }
    colors[offset + 3] = 255;
  }
  return colors;
}

// Set 0 is the global set every placement shows; the placement may add one more.
export function selectDoodadIndices(sets, placementSet) {
  const indices = new Set();
  for (const setIndex of new Set([0, placementSet])) {
    const set = sets[setIndex];
    if (!set) continue;
    for (let index = set.start; index < set.start + set.count; index += 1) indices.add(index);
  }
  return indices;
}

export function loadWmo(rootName, readFile) {
  const rootBuffer = readFile(rootName);
  if (!rootBuffer) throw new Error(`Missing WMO root ${rootName}`);
  const root = new MapObj().load(asBytes(rootBuffer));
  const rootChunks = readChunks(rootBuffer);
  const momt = findChunk(rootChunks, 'MOMT');

  const materials = root.materials.map((material, index) => ({
    flags: material.flags,
    blendMode: momt.readUInt32LE(index * MOMT_ENTRY_SIZE + 8),
    texture: material.textures[0] ?? null,
  }));

  const groups = root.groupInfo.map((_, index) => {
    const name = groupFileName(rootName, index);
    const buffer = readFile(name);
    if (!buffer) throw new Error(`Missing WMO group ${name}`);
    // Colour fixing is done below; the library's version can crash.
    const group = new MapObjGroup(root.flags | WMO_ROOT_FLAG_VERTEX_COLORS_FIXED).load(asBytes(buffer));
    const header = readGroupHeader(buffer);
    const positions = group.vertices ?? new Float32Array(0);
    const vertexCount = positions.length / 3;
    const batches = group.batches ?? [];
    const rawColors = header.flags & WMO_GROUP_FLAG_VERTEX_COLORS && group.colors?.length === vertexCount * 4
      ? group.colors
      : null;
    return {
      index,
      ...header,
      positions,
      normals: group.normals?.length === vertexCount * 3 ? group.normals : new Float32Array(vertexCount * 3),
      uvs: group.textureCoords?.length >= vertexCount * 2
        ? group.textureCoords.subarray(0, vertexCount * 2)
        : new Float32Array(vertexCount * 2),
      // MOCV is BGRA; only present when the group has baked vertex lighting.
      colors: rawColors && !(root.flags & WMO_ROOT_FLAG_VERTEX_COLORS_FIXED)
        ? fixVertexColors(rawColors, batches, header.transBatchCount)
        : rawColors,
      indices: group.indices ?? new Uint16Array(0),
      batches: vertexCount ? batches.map((batch) => ({
        indexStart: batch.indexStart,
        indexCount: batch.indexCount,
        materialIndex: batch.materialIndex,
      })) : [],
    };
  });

  return { materials, groups, ...readDoodadDefinitions(rootChunks) };
}
