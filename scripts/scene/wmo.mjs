// Loads a WMO (world map object: dungeon buildings and caves) into plain
// arrays. @wowserhq/format parses group geometry and material textures; the
// pieces it does not expose (MOGP header, material blend mode, doodad lists)
// are read directly from the chunks.

import { MapObj, MapObjGroup } from '@wowserhq/format';

import { asBytes, findChunk, readChunks, readCString, readFloats } from './chunks.mjs';
import { readWmoLiquid } from './liquids.mjs';
import { toM2Path } from './placement.mjs';

export const WMO_GROUP_FLAG_VERTEX_COLORS = 0x4;
export const WMO_GROUP_FLAG_EXTERIOR = 0x8;
export const WMO_GROUP_FLAG_INTERIOR = 0x2000;
export const WMO_MATERIAL_FLAG_UNLIT = 0x1;
export const WMO_MATERIAL_FLAG_UNCULLED = 0x4;
export const WMO_MATERIAL_FLAG_WINDOW = 0x20;
export const WMO_MATERIAL_FLAG_CLAMP_S = 0x40;
export const WMO_MATERIAL_FLAG_CLAMP_T = 0x80;
const WMO_ROOT_FLAG_VERTEX_COLORS_FIXED = 0x8;
// The building takes the client's newer ("unified") render path, which adds
// the header's ambient to its interiors' light and to the floor colour it
// lights things by.
export const WMO_ROOT_FLAG_UNIFIED = 0x2;
// A group lit by the outdoor light although it is not exterior.
export const WMO_GROUP_FLAG_EXTERIOR_LIT = 0x40;
// MOHD, a WMO's header: its ambient colour (BGRA) at this offset, its flags
// (u16) at the next.
export const MOHD_AMBIENT = 0x1c;
export const MOHD_FLAGS = 0x3c;
// MOPY flag of a transition face, where a doorway or cave mouth blends
// indoor light into outdoor.
export const MOPY_FLAG_TRANSITION = 0x1;
// The faces the client lights a unit or prop by, its floor: drawn faces
// (0x20) and detail faces (0x04), never collision-only ones (0x08), and none
// it leaves out of its ground rays (0x02).
const MOPY_FLAG_SKIPPED = 0x2;
const MOPY_FLAG_DETAIL = 0x4;
const MOPY_FLAG_RENDER = 0x20;
export const isFloorFace = (flags) => !(flags & MOPY_FLAG_SKIPPED) && Boolean(flags & (MOPY_FLAG_RENDER | MOPY_FLAG_DETAIL));

// A group's floor faces (isFloorFace) among those its collision tree
// holds (all its triangles where it has none), split by whether they are
// transition faces.
export function floorFaces({ bspFaces: faces, polyFlags, indices }) {
  const floor = [];
  const transition = [];
  const count = faces ? faces.length : Math.floor(indices.length / 3);
  for (let item = 0; item < count; item += 1) {
    const triangle = faces ? faces[item] : item;
    const flags = polyFlags ? polyFlags[triangle * 2] : MOPY_FLAG_RENDER;
    if (triangle * 3 + 2 >= indices.length || !isFloorFace(flags)) continue;
    (flags & MOPY_FLAG_TRANSITION ? transition : floor).push(triangle);
  }
  return { floor, transition };
}
// A prop's floor: a ray from this far above its origin down to this far
// below.
const PROP_FLOOR_ABOVE = 1;
const PROP_FLOOR_BELOW = 12;

const MOGP_HEADER_SIZE = 0x44;
// MOBA, a group's render batches (24 bytes): first index at 0x0c, index
// count at 0x10.
const MOBA_SIZE = 24;
const MOMT_ENTRY_SIZE = 64;
const MOMT_DIFFUSE_COLOR = 0x1c;
const MODS_ENTRY_SIZE = 32;
const MODD_ENTRY_SIZE = 40;

export function groupFileName(rootName, index) {
  return rootName.replace(/\.wmo$/i, `_${String(index).padStart(3, '0')}.wmo`);
}

// MOBR's triangle indices (u16 each), once each, in order.
function bspFaces(mobr) {
  if (!mobr) return null;
  const faces = new Set();
  for (let at = 0; at + 1 < mobr.length; at += 2) faces.add(mobr.readUInt16LE(at));
  return Uint32Array.from([...faces].sort((left, right) => left - right));
}

export function readGroupHeader(groupBuffer) {
  const mogp = findChunk(readChunks(groupBuffer), 'MOGP');
  if (!mogp || mogp.length < MOGP_HEADER_SIZE) throw new Error('WMO group is missing its MOGP header.');
  const chunks = readChunks(mogp, MOGP_HEADER_SIZE);
  const doodadRefs = findChunk(chunks, 'MODR');
  const moba = findChunk(chunks, 'MOBA');
  return {
    flags: mogp.readUInt32LE(0x08),
    // MOPY: a flags byte and a material per triangle.
    polyFlags: findChunk(chunks, 'MOPY'),
    // MOBR: the triangles of the group's collision tree (BSP), which the
    // client finds floors in, or null; detail faces are left out of it.
    bspFaces: bspFaces(findChunk(chunks, 'MOBR')),
    // Each render batch's first index and index count.
    renderBatches: moba
      ? Array.from({ length: Math.floor(moba.length / MOBA_SIZE) }, (_, index) => ({
        first: moba.readUInt32LE(index * MOBA_SIZE + 0x0c), count: moba.readUInt16LE(index * MOBA_SIZE + 0x10),
      }))
      : [],
    boundingBox: readFloats(mogp, 0x0C, 6),
    transBatchCount: mogp.readUInt16LE(0x28),
    intBatchCount: mogp.readUInt16LE(0x2a),
    extBatchCount: mogp.readUInt16LE(0x2c),
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

// The client's FixColorVertexAlpha, as in
// @wowserhq/format but reading the last transition batch (that library reads
// one past it, which crashes when every batch is one): the transition
// batches' vertices (doorways, cave mouths) are halved and keep their alpha,
// which the client blends indoor light into outdoor by; the rest are
// brightened by their alpha, halved, and made opaque.
export function fixVertexColors(bgra, batches, transBatchCount) {
  const colors = Uint8Array.from(bgra);
  const lastTransBatch = transBatchCount > 0 ? batches[Math.min(transBatchCount, batches.length) - 1] : null;
  const firstFixed = lastTransBatch ? lastTransBatch.lastVertex + 1 : 0;
  for (let offset = 0; offset < Math.min(firstFixed * 4, colors.length); offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) colors[offset + channel] >>= 1;
  }
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
    // BGRA; interior liquid's colour.
    diffuseColor: momt.readUInt32LE(index * MOMT_ENTRY_SIZE + MOMT_DIFFUSE_COLOR),
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
      liquid: readWmoLiquid(buffer),
      batches: vertexCount ? batches.map((batch) => ({
        indexStart: batch.indexStart,
        indexCount: batch.indexCount,
        materialIndex: batch.materialIndex,
      })) : [],
    };
  });

  const mohd = findChunk(rootChunks, 'MOHD');
  return {
    materials,
    groups,
    rootFlags: root.flags,
    // BGRA, as the vertex colours.
    ambient: mohd ? mohd.readUInt32LE(MOHD_AMBIENT) : 0,
    ...readDoodadDefinitions(rootChunks),
  };
}

// The light a building's prop is lit by, as the client finds it: from the
// first group that lists the prop, the floor under the prop's origin (its
// vertex colour as the client keeps it, doubled, plus the building's
// ambient if it adds one), and how far a transition face there leans it to
// the outdoor light (its alpha). The floor is the highest of the group's
// floor faces (floorFaces) the ray meets. [r, g, b, share], 0 to 1;
// 'outdoor' for a prop in an exterior or outdoor-lit group; null if no
// group lists it or the ray misses.
const propGroups = new WeakMap();
const floorFacesOf = new WeakMap();

export function propFloor(wmo, doodadIndex, [x, y, z]) {
  let groups = propGroups.get(wmo);
  if (!groups) {
    groups = new Map();
    for (const candidate of wmo.groups) for (const ref of candidate.doodadRefs) if (!groups.has(ref)) groups.set(ref, candidate);
    propGroups.set(wmo, groups);
  }
  const group = groups.get(doodadIndex);
  if (!group) return null;
  if (group.flags & (WMO_GROUP_FLAG_EXTERIOR | WMO_GROUP_FLAG_EXTERIOR_LIT)) return 'outdoor';
  const { positions, indices, colors, polyFlags } = group;
  if (!colors) return null;
  const top = z + PROP_FLOOR_ABOVE;
  const bottom = z - PROP_FLOOR_BELOW;
  let best = null;
  let faces = floorFacesOf.get(group);
  if (!faces) {
    const { floor, transition } = floorFaces(group);
    floorFacesOf.set(group, faces = [...floor, ...transition]);
  }
  for (const triangle of faces) {
    const a = indices[triangle * 3];
    const b = indices[triangle * 3 + 1];
    const c = indices[triangle * 3 + 2];
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const cx = positions[c * 3];
    const cy = positions[c * 3 + 1];
    // Most triangles are nowhere near the prop.
    if ((x < ax && x < bx && x < cx) || (x > ax && x > bx && x > cx)
      || (y < ay && y < by && y < cy) || (y > ay && y > by && y > cy)) continue;
    const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(area) < 1e-9) continue;
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area;
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area;
    const wc = 1 - wa - wb;
    if (wa < 0 || wb < 0 || wc < 0) continue;
    const height = wa * positions[a * 3 + 2] + wb * positions[b * 3 + 2] + wc * positions[c * 3 + 2];
    if (height > top || height < bottom || (best && height <= best.height)) continue;
    best = { height, triangle, weights: [[a, wa], [b, wb], [c, wc]] };
  }
  if (!best) return null;
  // BGRA bytes, blended by the hit's weights.
  const channel = (offset) => best.weights.reduce((sum, [vertex, weight]) => sum + colors[vertex * 4 + offset] * weight, 0);
  const ambient = wmo.rootFlags & WMO_ROOT_FLAG_UNIFIED ? wmo.ambient : 0;
  const lit = (offset) => Math.min(255, channel(offset) * 2 + ((ambient >> (offset * 8)) & 0xff)) / 255;
  const transition = polyFlags && polyFlags[best.triangle * 2] & MOPY_FLAG_TRANSITION;
  return [lit(2), lit(1), lit(0), transition ? channel(3) / 255 : 0];
}
