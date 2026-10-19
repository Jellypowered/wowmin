// Builds terrain meshes from a map's ADT tiles, cropped to the area players
// use, with what the renderer needs to blend the ground's texture layers. Each tile is 16 x 16 chunks of 33.33 yards; each chunk is a 9 x 9
// grid of outer vertices with an 8 x 8 grid of centre vertices between them
// (145 in all, stored row by row: 9 outer, 8 inner, 9 outer, ...). Chunk
// positions in the ADT are already server world coordinates: rows run south
// (decreasing X) and columns east (decreasing Y). Heights, normals, holes,
// and texture layers come from @wowserhq/format's MapArea; vertex shading
// (MCCV), which it doesn't read, is read directly.

import { createRequire } from 'node:module';

import { asBytes, readChunks } from './chunks.mjs';

const require = createRequire(import.meta.url);
const { MapArea } = require('@wowserhq/format');

export const CHUNK_SIZE = 1600 / 3 / 16;
const UNIT = CHUNK_SIZE / 8;
export const CHUNK_VERTEX_COUNT = 145;
const MCNK_HEADER_SIZE = 128;
const MCNK_FLAGS = 0x00;
const MCNK_MCSH_OFFSET = 0x2C;
const MCNK_MCCV_OFFSET = 0x74;
const MCNK_FLAG_HAS_SHADOW = 0x1;
// Alpha and shadow maps are 64 x 64 per chunk; a tile's are packed into one
// 1024 x 1024 atlas (16 x 16 chunks), RGB for the alpha of layers 2-4 and A
// for light (255 lit, SHADOW_LIGHT in baked shadow).
export const SPLAT_SIZE = 64;
export const ATLAS_SIZE = SPLAT_SIZE * 16;
const SHADOW_LIGHT = 150;
// MCCV colours are multipliers centred on this value. Scenes store the raw
// bytes (as normalized colours, so 1.0 is 255) and the viewer scales them.
export const MCCV_ONE = 127;
// A vertex's layer index when the layer is unused (scenes store layer
// indices as bytes).
export const NO_LAYER = 255;
// WDT MPHD flag: alpha maps are 8-bit (or compressed), not 4-bit.
export const WDT_FLAG_BIG_ALPHA = 0x4;

// Index of the outer vertex at row r (0-8), column c (0-8), and of the
// centre vertex of quad (r, c) (0-7).
const outer = (r, c) => r * 17 + c;
const inner = (r, c) => r * 17 + 9 + c;

// Server coordinates of a chunk's 145 vertices.
export function chunkPositions(position, heights) {
  const positions = new Float32Array(CHUNK_VERTEX_COUNT * 3);
  for (let row = 0; row < 17; row += 1) {
    const centre = row % 2 === 1;
    const columns = centre ? 8 : 9;
    for (let column = 0; column < columns; column += 1) {
      const index = centre ? inner((row - 1) / 2, column) : outer(row / 2, column);
      positions[index * 3] = position[0] - (row / 2) * UNIT;
      positions[index * 3 + 1] = position[1] - (column + (centre ? 0.5 : 0)) * UNIT;
      positions[index * 3 + 2] = position[2] + (heights?.[index] ?? 0);
    }
  }
  return positions;
}

// Whether quad (r, c) of a chunk is a hole: each of the 16 hole bits covers
// 2 x 2 quads, row by row.
export function isHole(holes, row, column) {
  return Boolean(holes & (1 << ((row >> 1) * 4 + (column >> 1))));
}

// Four triangles per quad, fanned round its centre vertex, wound so they
// face up (+Z) in server coordinates; holes are left out.
export function chunkIndices(holes = 0) {
  const indices = [];
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (isHole(holes, row, column)) continue;
      const centre = inner(row, column);
      const northWest = outer(row, column);
      const northEast = outer(row, column + 1);
      const southWest = outer(row + 1, column);
      const southEast = outer(row + 1, column + 1);
      indices.push(centre, northEast, northWest, centre, southEast, northEast,
        centre, southWest, southEast, centre, northWest, southWest);
    }
  }
  return indices;
}

// Each chunk's baked shadow (MCSH: 64 rows of 64 bits, least significant bit
// first) as a 64 x 64 array of 1 for shadowed, or null where it has none.
export function readShadows(adtBuffer) {
  return readChunks(adtBuffer).filter((chunk) => chunk.id === 'MCNK').map(({ data }) => {
    if (data.length < MCNK_HEADER_SIZE || !(data.readUInt32LE(MCNK_FLAGS) & MCNK_FLAG_HAS_SHADOW)) return null;
    const offset = data.readUInt32LE(MCNK_MCSH_OFFSET);
    const start = offset - 8;
    if (!offset || start + 8 + 512 > data.length || data.toString('ascii', start, start + 4) !== 'HSCM') return null;
    const shadow = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE);
    for (let row = 0; row < SPLAT_SIZE; row += 1) {
      for (let column = 0; column < SPLAT_SIZE; column += 1) {
        shadow[row * SPLAT_SIZE + column] = (data[start + 8 + row * 8 + (column >> 3)] >> (column & 7)) & 1;
      }
    }
    return shadow;
  });
}

// A chunk's shadow (readShadows) as the client keeps it, MCSH's own bytes:
// 64 rows of 64 bits, least significant bit first, in base64, for units and
// props to be shaded by where they stand.
export function encodeShadow(shadow) {
  const bytes = Buffer.alloc((SPLAT_SIZE * SPLAT_SIZE) / 8);
  shadow.forEach((shaded, texel) => { if (shaded) bytes[texel >> 3] |= 1 << (texel & 7); });
  return bytes.toString('base64');
}

// Writes one chunk's layer alphas and shadow into the tile's atlas at chunk
// cell (row, column): RGB the alpha of layers 2-4, A the light.
export function packChunkSplats(atlas, row, column, layers, shadow) {
  for (let y = 0; y < SPLAT_SIZE; y += 1) {
    for (let x = 0; x < SPLAT_SIZE; x += 1) {
      const pixel = ((row * SPLAT_SIZE + y) * ATLAS_SIZE + column * SPLAT_SIZE + x) * 4;
      for (let layer = 1; layer < 4; layer += 1) atlas[pixel + layer - 1] = layers[layer]?.splat?.[y * SPLAT_SIZE + x] ?? 0;
      atlas[pixel + 3] = shadow?.[y * SPLAT_SIZE + x] ? SHADOW_LIGHT : 255;
    }
  }
}

// MCNR normals are signed bytes in the order (x, y, z) of the chunk's own
// axes, which match the server's.
export function chunkNormals(raw) {
  const normals = new Float32Array(CHUNK_VERTEX_COUNT * 3);
  for (let index = 0; index < CHUNK_VERTEX_COUNT; index += 1) {
    const x = (raw?.[index * 3] ?? 0) / 127;
    const y = (raw?.[index * 3 + 1] ?? 0) / 127;
    const z = (raw?.[index * 3 + 2] ?? 127) / 127;
    const length = Math.hypot(x, y, z) || 1;
    normals.set([x / length, y / length, z / length], index * 3);
  }
  return normals;
}

// Each chunk's MCCV vertex shading as RGB bytes (MCCV_ONE = unchanged), or
// null where the chunk has none. `adtBuffer` is the whole ADT file.
export function readVertexShading(adtBuffer) {
  return readChunks(adtBuffer).filter((chunk) => chunk.id === 'MCNK').map(({ data }) => {
    if (data.length < MCNK_HEADER_SIZE) return null;
    const offset = data.readUInt32LE(MCNK_MCCV_OFFSET);
    // The offset counts from the MCNK chunk's own header (8 bytes before data).
    const start = offset - 8;
    if (!offset || start + 8 + CHUNK_VERTEX_COUNT * 4 > data.length) return null;
    if (data.toString('ascii', start, start + 4) !== 'VCCM') return null;
    const colors = new Uint8Array(CHUNK_VERTEX_COUNT * 3);
    for (let index = 0; index < CHUNK_VERTEX_COUNT; index += 1) {
      const base = start + 8 + index * 4;
      // BGRA bytes.
      colors[index * 3] = data[base + 2];
      colors[index * 3 + 1] = data[base + 1];
      colors[index * 3 + 2] = data[base];
    }
    return colors;
  });
}

export function loadMapArea(adtBuffer, bigAlpha) {
  return new MapArea(bigAlpha ? 8 : 4).load(asBytes(adtBuffer));
}

// A flat, untextured stand-in tile (Azjol-Nerub, Gundrak): every chunk at one
// height with no layers.
export function isPlaceholderArea(area) {
  let height = null;
  for (const chunk of area.chunks) {
    if (chunk.layers.length) return false;
    for (const value of chunk.vertexHeights ?? []) {
      const z = chunk.position[2] + value;
      if (height === null) height = z;
      else if (Math.abs(z - height) > 0.01) return false;
    }
  }
  return true;
}

// A flat, untextured stand-in chunk at height 0 inside an otherwise real
// tile (The Culling of Stratholme has stretches of them under its city).
export function isPlaceholderChunk(chunk) {
  if (chunk.layers.length || chunk.position[2] !== 0) return false;
  return (chunk.vertexHeights ?? []).every((height) => height === 0);
}

// Whether a chunk at `position` (its north-west corner) overlaps `area`: a
// box ({ minX, maxX, minY, maxY }) or a list of them. A null area keeps
// everything.
export function chunkInArea(position, area) {
  if (!area) return true;
  const [north, west] = position;
  const boxes = Array.isArray(area) ? area : [area];
  return boxes.some((box) => north >= box.minX && north - CHUNK_SIZE <= box.maxX && west >= box.minY && west - CHUNK_SIZE <= box.maxY);
}

// Whether a point ([north, west, ...]) lies in `area`, a list of boxes.
export function pointInArea([north, west], area) {
  return area.some((box) => north >= box.minX && north <= box.maxX && west >= box.minY && west <= box.maxY);
}

// One tile's terrain, cropped to `area`: merged positions, normals, colours,
// and triangle indices of its kept chunks, with their bounds; per vertex its
// chunk's four layer textures (`textureIndex(name)`, -1 for none) and its
// chunk's cell in the tile; and the tile's alpha and shadow atlas. Null when
// the tile is a placeholder or nothing in it is kept.
export function buildTerrainTile(adtBuffer, { bigAlpha, area = null, textureIndex = () => -1 }) {
  const mapArea = loadMapArea(adtBuffer, bigAlpha);
  if (isPlaceholderArea(mapArea)) return null;
  const shading = readVertexShading(adtBuffer);
  const shadows = readShadows(adtBuffer);
  const atlas = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  // Each built chunk's shadow (encodeShadow), by chunk (row x 16 + column),
  // null where it has none.
  const chunkShadows = new Array(256).fill(null);
  const positions = [];
  const normals = [];
  const colors = [];
  const layerIndices = [];
  const cells = [];
  const indices = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  let vertexCount = 0;
  let chunkCount = 0;
  mapArea.chunks.forEach((chunk, chunkIndex) => {
    if (!chunk.vertexHeights || !chunkInArea(chunk.position, area) || isPlaceholderChunk(chunk)) return;
    const chunkPositionsArray = chunkPositions(chunk.position, chunk.vertexHeights);
    for (let index = 0; index < chunkPositionsArray.length; index += 3) {
      const [x, y, z] = [chunkPositionsArray[index], chunkPositionsArray[index + 1], chunkPositionsArray[index + 2]];
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
      bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
    }
    positions.push(chunkPositionsArray);
    normals.push(chunkNormals(chunk.vertexNormals));
    colors.push(shading[chunkIndex] ?? new Uint8Array(CHUNK_VERTEX_COUNT * 3).fill(MCCV_ONE));
    const row = Math.floor(chunkIndex / 16);
    const column = chunkIndex % 16;
    const layers = [0, 1, 2, 3].map((layer) => {
      const index = chunk.layers[layer] ? textureIndex(chunk.layers[layer].texture) : -1;
      return index >= 0 && index < NO_LAYER ? index : NO_LAYER;
    });
    layerIndices.push(new Uint8Array(CHUNK_VERTEX_COUNT * 4).map((_, index) => layers[index % 4]));
    cells.push(new Uint8Array(CHUNK_VERTEX_COUNT * 2).map((_, index) => (index % 2 ? column : row)));
    packChunkSplats(atlas, row, column, chunk.layers, shadows[chunkIndex]);
    if (shadows[chunkIndex]?.includes(1)) chunkShadows[chunkIndex] = encodeShadow(shadows[chunkIndex]);
    for (const index of chunkIndices(chunk.holes)) indices.push(index + vertexCount);
    vertexCount += CHUNK_VERTEX_COUNT;
    chunkCount += 1;
  });
  if (!chunkCount || !indices.length) return null;
  const concat = (parts) => {
    const out = new parts[0].constructor(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  return {
    positions: concat(positions),
    normals: concat(normals),
    colors: concat(colors),
    layers: concat(layerIndices),
    cells: concat(cells),
    atlas,
    shadows: chunkShadows,
    // The tile's north-west corner: chunk 0's position.
    origin: [mapArea.chunks[0].position[0], mapArea.chunks[0].position[1]],
    indices: vertexCount > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices),
    bounds,
    chunkCount,
  };
}

// The area to keep terrain for, as a list of boxes: each dungeon map floor,
// or the map's world map bounds, or failing both the area the map's
// buildings cover (`buildings`, boxes in world coordinates), widened by
// `margin` yards. Floors are kept apart, since a map's floors can be far
// from each other (Icecrown Citadel's spire). An empty list when there is
// nothing to go by.
export function playArea(floors, worldMapBounds, margin = 100, buildings = []) {
  let boxes = (floors ?? []).map((floor) => floor.bounds).filter(Boolean);
  if (!boxes.length && worldMapBounds) boxes = [worldMapBounds];
  if (!boxes.length && buildings.length) {
    boxes = [{
      minX: Math.min(...buildings.map((box) => box.minX)), maxX: Math.max(...buildings.map((box) => box.maxX)),
      minY: Math.min(...buildings.map((box) => box.minY)), maxY: Math.max(...buildings.map((box) => box.maxY)),
    }];
  }
  return boxes.map((box) => ({ minX: box.minX - margin, maxX: box.maxX + margin, minY: box.minY - margin, maxY: box.maxY + margin }));
}
