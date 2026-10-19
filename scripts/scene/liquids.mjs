// Reads liquids (water, ocean, magma, slime) for 3D scenes: WMO group liquid
// grids (MLIQ), and terrain liquids (MH2O in Wrath tiles, per-chunk MCLQ in
// older ones), and builds their surfaces as the client does: per vertex the
// ripple (or lava) texture's uv and the depth byte that picks a row of the
// shallow-to-deep colour ramp. LiquidType.dbc names each type's animated
// texture ("XTextures\lava\lava.%d.blp", frames 1-30) and its ramp.

import { findChunk, readChunks, readFloats } from './chunks.mjs';

// A liquid tile is an eighth of a terrain chunk.
export const LIQUID_UNIT = 1600 / 3 / 16 / 8;
const MOGP_HEADER_SIZE = 0x44;
const MOGP_GROUP_LIQUID = 0x34;
const MLIQ_HEADER_SIZE = 0x1E;
const MLIQ_MATERIAL = 0x1C;
const MLIQ_VERTEX_SIZE = 8;
// A tile whose low 4 bits are all set has no liquid.
const TILE_NO_LIQUID = 0x0F;
export const WMO_ROOT_FLAG_LIQUID_TYPE_DBC_ID = 0x4;
const WMO_GROUP_FLAG_OCEAN = 0x80000;
// A group with either flag (exterior, or lit by the outdoor light) has
// exterior liquid, as has a type with the WMO ocean flag; the rest is
// interior.
const WMO_GROUP_EXTERIOR_FLAGS = 0x8 | 0x40;
const LIQUID_TYPE_FLAG_WMO_OCEAN = 0x200;
const INTERIOR_WATER = 17;
const GREEN_LAVA = 15;

// LiquidType IDs for the four basic kinds in a WMO: water (ocean when the
// group says so), ocean, magma, slime.
function toWmoLiquid(value, groupFlags) {
  switch (value & 3) {
    case 0: return groupFlags & WMO_GROUP_FLAG_OCEAN ? 14 : 13;
    case 1: return 14;
    case 2: return 19;
    default: return 20;
  }
}

// The LiquidType ID a WMO group's liquid is, from its MOGP groupLiquid,
// the root's flags, and (for old green-lava groups) the first tile's legacy
// type. Its depth bytes read by this type's table; it is drawn as
// drawnWmoLiquidType says.
export function wmoLiquidType(groupLiquid, rootFlags, groupFlags, firstTileType = 0) {
  let type;
  if (rootFlags & WMO_ROOT_FLAG_LIQUID_TYPE_DBC_ID) {
    type = groupLiquid < 21 ? toWmoLiquid(groupLiquid - 1, groupFlags) : groupLiquid;
  } else if (groupLiquid === GREEN_LAVA) {
    // Old tiles name their kind in the same low two bits (4 river water,
    // 6 magma, ...).
    type = toWmoLiquid(firstTileType, groupFlags);
  } else {
    type = groupLiquid < 20 ? toWmoLiquid(groupLiquid, groupFlags) : groupLiquid + 1;
  }
  return type;
}

// Whether a WMO group's liquid is interior: lit by a white light from
// above alone, coloured by its material, and drawn by the WMO ramp's white
// half.
export function isInteriorLiquid(groupFlags, typeFlags = 0) {
  return !(groupFlags & WMO_GROUP_EXTERIOR_FLAGS) && !(typeFlags & LIQUID_TYPE_FLAG_WMO_OCEAN);
}

// The type a WMO group's liquid is drawn as: interior water of the first
// twenty types is interior WMO water.
export function drawnWmoLiquidType(type, interior) {
  return interior && type > 0 && type < 21 && !((type - 1) & 3) ? INTERIOR_WATER : type;
}

// A WMO group's liquid grid, or null if it has none: vertex and tile counts,
// the corner it starts from (group space), each vertex's height, depth byte
// (water) and texture coordinates (magma and slime: s, t), each tile's
// flags, and the material (MOMT index) interior liquid takes its colour
// from.
export function readWmoLiquid(groupBuffer) {
  const mogp = findChunk(readChunks(groupBuffer), 'MOGP');
  if (!mogp || mogp.length < MOGP_HEADER_SIZE) return null;
  const mliq = findChunk(readChunks(mogp, MOGP_HEADER_SIZE), 'MLIQ');
  if (!mliq || mliq.length < MLIQ_HEADER_SIZE) return null;
  const xVerts = mliq.readUInt32LE(0x00);
  const yVerts = mliq.readUInt32LE(0x04);
  const xTiles = mliq.readUInt32LE(0x08);
  const yTiles = mliq.readUInt32LE(0x0C);
  const corner = readFloats(mliq, 0x10, 3);
  const vertexStart = MLIQ_HEADER_SIZE;
  const tileStart = vertexStart + xVerts * yVerts * MLIQ_VERTEX_SIZE;
  if (!xTiles || !yTiles || tileStart + xTiles * yTiles > mliq.length) return null;
  const heights = new Float32Array(xVerts * yVerts);
  const depths = new Uint8Array(xVerts * yVerts);
  const magmaUvs = new Int16Array(xVerts * yVerts * 2);
  for (let index = 0; index < heights.length; index += 1) {
    const at = vertexStart + index * MLIQ_VERTEX_SIZE;
    depths[index] = mliq[at];
    magmaUvs[index * 2] = mliq.readInt16LE(at);
    magmaUvs[index * 2 + 1] = mliq.readInt16LE(at + 2);
    heights[index] = mliq.readFloatLE(at + 4);
  }
  return {
    xVerts, yVerts, xTiles, yTiles, corner, heights, depths, magmaUvs,
    materialId: mliq.readUInt16LE(MLIQ_MATERIAL),
    tiles: Uint8Array.from(mliq.subarray(tileStart, tileStart + xTiles * yTiles)),
    groupLiquid: mogp.readUInt32LE(MOGP_GROUP_LIQUID),
  };
}

// The first tile's legacy liquid type (low 4 bits), for old green-lava groups.
export function firstTileType(liquid) {
  for (const tile of liquid.tiles) if ((tile & 0x0F) !== TILE_NO_LIQUID) return tile & 0x0F;
  return 0;
}

// Collects liquid grids into one surface: two triangles for each wet tile,
// split along the diagonal from its second corner to its third as the
// client's strips are, and per vertex its uv for the ripple (or lava)
// texture and its depth byte.
export class LiquidSurface {
  constructor() {
    this.positions = [];
    this.uvs = [];
    this.depths = [];
    this.indices = [];
  }

  // A grid of xTiles × yTiles tiles: `heights` per vertex ((xTiles + 1) per
  // row), `wet(x, y)` per tile, `place(x, y)` the horizontal position of
  // vertex (x, y), `uv(x, y, position)` its texture coordinates and
  // `depth(x, y)` its depth byte.
  add({ xTiles, yTiles, heights, wet, place, uv, depth = () => 0 }) {
    // Neighbouring wet tiles share their corners.
    const shared = new Map();
    const vertex = (x, y) => {
      const key = y * (xTiles + 1) + x;
      if (shared.has(key)) return shared.get(key);
      const position = place(x, y);
      this.positions.push(position[0], position[1], heights[key]);
      this.uvs.push(...uv(x, y, position));
      this.depths.push(depth(x, y));
      shared.set(key, this.positions.length / 3 - 1);
      return shared.get(key);
    };
    for (let y = 0; y < yTiles; y += 1) {
      for (let x = 0; x < xTiles; x += 1) {
        if (!wet(x, y)) continue;
        const a = vertex(x, y);
        const b = vertex(x + 1, y);
        const c = vertex(x, y + 1);
        const d = vertex(x + 1, y + 1);
        this.indices.push(a, c, b, c, b, d);
      }
    }
    return this;
  }

  // A convex polygon (a tile cut by portals) as a strip: `points` its
  // corners' positions in strip order, `uvs` and `depths` theirs.
  addStrip(points, uvs, depths) {
    const first = this.positions.length / 3;
    points.forEach((point, index) => {
      this.positions.push(...point);
      this.uvs.push(...uvs[index]);
      this.depths.push(depths[index]);
    });
    for (let index = 0; index + 2 < points.length; index += 1) this.indices.push(first + index, first + index + 1, first + index + 2);
    return this;
  }

  // Positions, uvs, depth bytes, and indices; null when no tile held liquid.
  finish() {
    if (!this.indices.length) return null;
    return {
      positions: Float32Array.from(this.positions),
      uvs: Float32Array.from(this.uvs),
      depths: Uint8Array.from(this.depths),
      indices: Uint32Array.from(this.indices),
    };
  }
}

// The client's clipper of a convex polygon by planes: each plane keeps the
// side where side × (n · p + d) >= 0; an edge whose ends lie less than
// FLT_EPSILON apart in distance is left as it is, and a plane that does
// not cross the polygon exactly twice changes no vertices (though edges
// wholly on the far side are dropped). New vertices' data is the ends'
// mixed by `lerp(a, b, t)`, worked out when asked for. The result is in
// the order the client draws it as a strip: from the first edge left,
// alternately back round and forward.
const CLIP_EPSILON = 1.1920929e-7;

export class ConvexClipper {
  constructor() {
    this.verts = [];
    this.edges = [];
    this.stamp = 0;
    this.firstEdge = 0;
  }

  addVertex(position, data) {
    this.verts.push({ position, data, from: null, to: null, t: 0, edges: [0, 0], stamp: -1, dist: 0 });
  }

  begin() {
    const count = this.verts.length;
    this.verts.forEach((vertex, index) => {
      vertex.edges = [index - 1, index];
      vertex.stamp = -1;
      this.edges.push({ verts: [index, (index + 1) % count], clipped: false });
    });
    if (count) this.verts[0].edges[0] = count - 1;
  }

  // Keeps the side of `plane` ([nx, ny, nz, d]) `side` (1 or -1) says.
  clip([nx, ny, nz, d], side) {
    this.stamp += 1;
    const distance = (vertex) => {
      if (vertex.stamp !== this.stamp) {
        const [x, y, z] = vertex.position;
        vertex.dist = (z * nz + y * ny + x * nx + d) * side;
        vertex.stamp = this.stamp;
      }
      return vertex.dist;
    };
    const crossings = [];
    for (let index = 0; index < this.edges.length; index += 1) {
      const edge = this.edges[index];
      if (edge.clipped) continue;
      const a = this.verts[edge.verts[0]];
      const b = this.verts[edge.verts[1]];
      const da = distance(a);
      const db = distance(b);
      if (!(da < 0 || db < 0)) continue;
      if (!(da >= 0 || db >= 0)) {
        edge.clipped = true;
        continue;
      }
      const sum = Math.abs(db) + Math.abs(da);
      if (sum <= CLIP_EPSILON) continue;
      if (crossings.length === 2) {
        crossings.push(null);
        break;
      }
      const t = Math.abs(da) / sum;
      const keep = da >= 0 ? 1 : 0;
      const vertex = {
        position: [0, 1, 2].map((axis) => (b.position[axis] - a.position[axis]) * t + a.position[axis]),
        data: undefined, from: a, to: b, t, edges: [0, 0], stamp: this.stamp, dist: 0,
      };
      vertex.edges[1 - keep] = index;
      vertex.edges[keep] = this.edges.length;
      crossings.push({ edge: index, keep, vertex: this.verts.length });
      this.verts.push(vertex);
    }
    if (crossings.length !== 2) {
      this.verts.length -= crossings.length;
      return crossings.length;
    }
    const added = [0, 0];
    for (const { edge, keep, vertex } of crossings) {
      this.edges[edge].verts[keep] = vertex;
      added[1 - keep] = vertex;
    }
    this.edges.push({ verts: added, clipped: false });
    return 2;
  }

  end() {
    this.firstEdge = this.edges.findIndex((edge) => !edge.clipped);
    if (this.firstEdge < 0) this.firstEdge = this.edges.length;
  }

  // The polygon's corners in strip order, each { position, data }.
  results(lerp) {
    const dataOf = (vertex) => {
      if (vertex.data === undefined) vertex.data = lerp(dataOf(vertex.from), dataOf(vertex.to), vertex.t);
      return vertex.data;
    };
    if (this.firstEdge >= this.edges.length) return [];
    let [front, back] = this.edges[this.firstEdge].verts;
    const out = [];
    for (let step = 0; ; step += 1) {
      const vertex = this.verts[step & 1 ? back : front];
      out.push({ position: vertex.position, data: dataOf(vertex) });
      if (back === front || out.length > this.verts.length) break;
      if (step & 1) back = this.edges[this.verts[back].edges[1]].verts[1];
      else front = this.edges[this.verts[front].edges[0]].verts[0];
    }
    return out;
  }
}

// WMO water's ripple texture repeats every 1 / 0.24 yards of the group's
// space from its liquid's corner; magma and slime carry their own
// coordinates, in 256ths.
const WMO_WATER_UV_SCALE = 0.24;
const WMO_MAGMA_UV_SCALE = 1 / 256;
// Tiles with this flag lie across a portal: the client clips them by the
// group's portals rather than drawing them whole.
const TILE_PORTAL_CLIPPED = 0x80;

// A clipped corner's data mixed as the client mixes it: the depth byte,
// and the texture coordinates as unsigned 16-bit values, each cut to a
// whole number.
function lerpLiquidData(a, b, t) {
  return {
    depth: Math.trunc(a.depth + (b.depth - a.depth) * t) & 0xff,
    s: Math.trunc(a.s + (b.s - a.s) * t) & 0xffff,
    t: Math.trunc(a.t + (b.t - a.t) * t) & 0xffff,
  };
}

const toInt16 = (value) => (value >= 0x8000 ? value - 0x10000 : value);

// Whether another group's liquid reaches over a tile (from `min` to `max`
// corner), as the client tests it.
function overlapsTile(other, min, max) {
  return other.corner[0] < max[0] && other.corner[1] < max[1]
    && other.xTiles * LIQUID_UNIT + other.corner[0] > min[0] && LIQUID_UNIT * other.yTiles + other.corner[1] > min[1];
}

// A WMO group's liquid surface in the group's own space (vertex (x, y) at
// corner + (x, y) × LIQUID_UNIT), with magma's or water's uvs. Tiles
// across a portal are clipped by the group's portals whose other group has
// liquid over the tile (`portals`: the building's planes, the group's
// references, and `liquidOf(groupIndex)`); without them, drawn whole. Null
// when no tile has any.
export function liquidSurface({ xVerts, xTiles, yTiles, corner, heights, depths, magmaUvs, tiles }, { magma = false, portals = null } = {}) {
  // Vertex rows can be wider than the tiles need.
  const index = (x, y) => y * xVerts + x;
  const rowHeights = Float32Array.from({ length: (xTiles + 1) * (yTiles + 1) },
    (_, at) => heights[index(at % (xTiles + 1), Math.floor(at / (xTiles + 1)))]);
  const waterUv = ([px, py]) => [(px - corner[0]) * WMO_WATER_UV_SCALE, (py - corner[1]) * WMO_WATER_UV_SCALE];
  const magmaUv = (s, t) => [s * WMO_MAGMA_UV_SCALE, t * WMO_MAGMA_UV_SCALE];
  const wet = (x, y) => (tiles[y * xTiles + x] & 0x0F) !== TILE_NO_LIQUID;
  const clipped = (x, y) => Boolean(portals) && Boolean(tiles[y * xTiles + x] & TILE_PORTAL_CLIPPED);
  const surface = new LiquidSurface().add({
    xTiles, yTiles, heights: rowHeights,
    wet: (x, y) => wet(x, y) && !clipped(x, y),
    place: (x, y) => [corner[0] + x * LIQUID_UNIT, corner[1] + y * LIQUID_UNIT],
    uv: magma
      ? (x, y) => magmaUv(magmaUvs[index(x, y) * 2], magmaUvs[index(x, y) * 2 + 1])
      : (x, y, position) => waterUv(position),
    depth: (x, y) => depths?.[index(x, y)] ?? 0,
  });
  for (let y = 0; portals && y < yTiles; y += 1) {
    for (let x = 0; x < xTiles; x += 1) {
      if (!wet(x, y) || !clipped(x, y)) continue;
      const clipper = new ConvexClipper();
      const points = [[0, 0], [0, 1], [1, 1], [1, 0]].map(([dx, dy]) => {
        const vertex = index(x + dx, y + dy);
        const position = [(x + dx) * LIQUID_UNIT + corner[0], LIQUID_UNIT * (y + dy) + corner[1], heights[vertex]];
        clipper.addVertex(position, {
          depth: depths?.[vertex] ?? 0, s: magmaUvs[vertex * 2] & 0xffff, t: magmaUvs[vertex * 2 + 1] & 0xffff,
        });
        return position;
      });
      clipper.begin();
      for (const ref of portals.refs) {
        const other = portals.liquidOf(ref.groupIndex);
        const plane = portals.planes[ref.portalIndex];
        if (other && plane && overlapsTile(other, points[0], points[2])) clipper.clip(plane, ref.side);
      }
      clipper.end();
      const corners = clipper.results(lerpLiquidData);
      surface.addStrip(
        corners.map(({ position }) => position),
        corners.map(({ position, data }) => (magma ? magmaUv(toInt16(data.s), toInt16(data.t)) : waterUv(position))),
        corners.map(({ data }) => data.depth),
      );
    }
  }
  return surface.finish();
}

// LiquidType.dbc: flags, kind (0 water, 1 ocean, 2 magma, 3 slime),
// LiquidMaterial, six textures (the animated sheet, then the depth ramp's
// name), 18 floats and 4 ints whose meaning depends on the material.
// LiquidMaterial.dbc: the vertex format (0 heights and depth bytes, 1
// heights and texture coordinates).
const LIQUID_KINDS = ['water', 'ocean', 'magma', 'slime'];
const LIQUID_TYPE_FLAGS = 2;
const LIQUID_TYPE_KIND = 3;
const LIQUID_TYPE_MATERIAL = 14;
const LIQUID_TYPE_TEXTURE = 15;
const LIQUID_TYPE_RAMP_TEXTURE = 16;
const LIQUID_TYPE_FLOATS = 23;
const LIQUID_TYPE_INTS = 41;
const LIQUID_MATERIAL_VERTEX_FORMAT = 1;
const MAX_LIQUID_FRAMES = 30;
// Materials: water, magma (and slime), procedural water (drawn as ocean).
export const LIQUID_MATERIAL_WATER = 1;
export const LIQUID_MATERIAL_MAGMA = 2;
export const LIQUID_MATERIAL_PROCEDURAL = 3;
// Every animated sheet runs through its frames in this long (ms) unless a
// water type says otherwise.
const LIQUID_FRAME_PERIOD = 1250;
// The rotation float is turned into degrees and then used as radians, as
// the client does.
const DEGREES_PER_RADIAN = 57.29578;

// The depth ramp a water type draws by, from its ramp texture's name.
function rampOf(material, name) {
  if (material === LIQUID_MATERIAL_PROCEDURAL) return 'ocean';
  if (/ocean/i.test(name)) return 'ocean';
  if (/wmo/i.test(name)) return 'wmo';
  return 'river';
}

// A liquid type's kind, material and vertex format, flags, and animation
// frame files; water's ripple scale and rotation, depth table and depth
// scale, and ramp; magma's scroll (texture widths a second, u and v). Null
// if unknown.
export function liquidTypeInfo(liquidTypes, typeId, readFile, liquidMaterials = new Map()) {
  const record = liquidTypes.get(typeId);
  if (!record) return null;
  const pattern = record.string(LIQUID_TYPE_TEXTURE);
  const frames = [];
  for (let frame = 1; pattern && frame <= MAX_LIQUID_FRAMES; frame += 1) {
    const name = pattern.replace('%d', String(frame));
    if (!readFile(name)) break;
    frames.push(name);
  }
  const material = record.uint(LIQUID_TYPE_MATERIAL);
  const float = (index) => record.float(LIQUID_TYPE_FLOATS + index);
  const int = (index) => record.int(LIQUID_TYPE_INTS + index);
  const water = material !== LIQUID_MATERIAL_MAGMA;
  return {
    id: typeId,
    kind: LIQUID_KINDS[record.uint(LIQUID_TYPE_KIND)] ?? 'water',
    material,
    vertexFormat: liquidMaterials.get(material)?.uint(LIQUID_MATERIAL_VERTEX_FORMAT) ?? (water ? 0 : 1),
    flags: record.uint(LIQUID_TYPE_FLAGS),
    frames,
    ...(water ? {
      ramp: rampOf(material, record.string(LIQUID_TYPE_RAMP_TEXTURE)),
      rippleScale: float(0),
      rippleRotation: float(1),
      depthScale: float(2),
      depthTable: int(0),
      period: int(1) || LIQUID_FRAME_PERIOD,
    } : {
      scroll: [float(0), float(1)],
      period: LIQUID_FRAME_PERIOD,
    }),
  };
}

// How a water type turns its ripple uvs: rotated by its rotation float (as
// the client reads it) and scaled by its scale float. Identity for magma.
export function rippleTransform(info) {
  if (info?.rippleScale === undefined) return ([u, v]) => [u, v];
  const angle = info.rippleRotation * DEGREES_PER_RADIAN;
  const cos = Math.cos(angle) * info.rippleScale;
  const sin = Math.sin(angle) * info.rippleScale;
  return ([u, v]) => [u * cos - v * sin, u * sin + v * cos];
}

// The depth tables: a depth byte to the ramp's v (0 shallow, 1 deep).
// River water reaches the deep colour at 42; ocean and WMO water at 255.
const RIVER_DEPTH_FULL = 42;
export function depthCoord(table, depth) {
  return table === 0 ? Math.min(depth / RIVER_DEPTH_FULL, 1) : depth / 255;
}

// A surface's texture coordinates as the client's shaders take them: the
// ripple (or lava) uvs through the type's transform, and for water the
// depth ramp's (u, v): u 1 for interior WMO water (the ramp's white half),
// else 0; v the depth byte through `depthInfo`'s table (the type the
// liquid is, which can differ from the one it is drawn as), times the
// drawn type's depth scale. No ramp coordinates for magma and slime.
export function liquidTexCoords(surface, info, { depthInfo = info, interior = false } = {}) {
  const transform = rippleTransform(info);
  const count = surface.uvs.length / 2;
  const ripple = new Float32Array(count * 2);
  for (let vertex = 0; vertex < count; vertex += 1) {
    ripple.set(transform([surface.uvs[vertex * 2], surface.uvs[vertex * 2 + 1]]), vertex * 2);
  }
  if (info.material === LIQUID_MATERIAL_MAGMA) return { ripple, ramp: null };
  const ramp = new Float32Array(count * 2);
  const tabled = depthInfo && depthInfo.depthTable !== undefined && depthInfo.vertexFormat !== 1;
  for (let vertex = 0; vertex < count; vertex += 1) {
    ramp[vertex * 2] = interior ? 1 : 0;
    ramp[vertex * 2 + 1] = (tabled ? depthCoord(depthInfo.depthTable, surface.depths[vertex]) : 0) * info.depthScale;
  }
  return { ripple, ramp };
}

// Terrain liquids. A chunk's liquid is an 8 × 8 grid of tiles, columns
// running east (server −Y) and rows south (server −X) from the chunk's
// corner, like its ground.
const MCNK_HEADER_SIZE = 128;
const MCNK_FLAGS = 0x00;
const MCNK_MCVT_OFFSET = 0x14;
const MCNK_MCLQ_OFFSET = 0x60;
const MCNK_MCLQ_SIZE = 0x64;
const MCNK_POSITION = 0x68;
const CHUNK_TILES = 8;
// MCLQ: one layer per kind the chunk's flags name (river, ocean, magma,
// slime), each heights and tile flags for 9 × 9 vertices and 8 × 8 tiles,
// then flow data. As LiquidType IDs; Outland's magma is green lava.
const MCLQ_KINDS = [[0x04, 1], [0x08, 2], [0x10, 3], [0x20, 4]];
const MCLQ_MAGMA = 3;
const OUTLAND = 530;
const MCLQ_VERTEX_SIZE = 8;
const MCLQ_LAYER_SIZE = 8 + 81 * MCLQ_VERTEX_SIZE + 64 + 4 + 80;
// MH2O: per chunk (offset, layer count, attributes), each layer 24 bytes.
const MH2O_CHUNK_SIZE = 12;
const MH2O_LAYER_SIZE = 24;
// Vertex formats: 0 heights then depth bytes, 1 heights then texture
// coordinates (u16 pairs), 2 depth bytes alone; the last two lie at height
// 0, and a layer of format 2 without data is deep everywhere.
const FORMAT_DEPTH = 0;
const FORMAT_TEXCOORDS = 1;
const FORMAT_DEPTH_ONLY = 2;
const NO_DEPTH_DATA = 255;
// The ground's liquid textures repeat every 1 / 0.06 yards of the world;
// stored coordinates are in 256ths of a third.
const TERRAIN_UV_SCALE = 0.06;
const TERRAIN_STORED_UV_SCALE = 3 / 256;

// A chunk's lowest ground height under each of its tiles (8 × 8), from its
// heights (MCVT: 9 × 9 outer and 8 × 8 centre, relative to its corner).
function tileGround(mcnk) {
  const ground = new Float32Array(64).fill(-Infinity);
  const offset = mcnk.readUInt32LE(MCNK_MCVT_OFFSET);
  if (!offset || offset + 145 * 4 > mcnk.length) return ground;
  const base = mcnk.readFloatLE(MCNK_POSITION + 8);
  const height = (index) => base + mcnk.readFloatLE(offset + index * 4);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      ground[row * 8 + column] = Math.min(
        height(row * 17 + column), height(row * 17 + column + 1),
        height((row + 1) * 17 + column), height((row + 1) * 17 + column + 1),
        height(row * 17 + 9 + column),
      );
    }
  }
  return ground;
}

// A chunk's MCLQ layers as grids over the whole chunk. A tile is the
// layer's when its kind (the low bits of its flags) is the layer's.
// `vertexFormat(typeId)` is the layer's (its material's): water's vertices
// start with a depth byte, magma's with texture coordinates.
function readMclq(mcnk, { mapId, vertexFormat }) {
  const flags = mcnk.readUInt32LE(MCNK_FLAGS);
  const offset = mcnk.readUInt32LE(MCNK_MCLQ_OFFSET);
  if (mcnk.readUInt32LE(MCNK_MCLQ_SIZE) <= 8 || !offset) return [];
  const layers = [];
  let start = offset;
  for (const [flag, kind] of MCLQ_KINDS) {
    if (!(flags & flag)) continue;
    if (start + MCLQ_LAYER_SIZE > mcnk.length) break;
    const typeId = mapId === OUTLAND && kind === MCLQ_MAGMA ? GREEN_LAVA : kind;
    const format = vertexFormat(typeId);
    const vertex = (index) => start + 8 + index * MCLQ_VERTEX_SIZE;
    const heights = Float32Array.from({ length: 81 }, (_, index) => (format > FORMAT_TEXCOORDS ? 0 : mcnk.readFloatLE(vertex(index) + 4)));
    const depths = Uint8Array.from({ length: 81 }, (_, index) => (format === FORMAT_DEPTH || format === FORMAT_DEPTH_ONLY ? mcnk[vertex(index)] : 0));
    const stored = format === FORMAT_TEXCOORDS
      ? Uint16Array.from({ length: 162 }, (_, index) => mcnk.readUInt16LE(vertex(index >> 1) + (index & 1) * 2))
      : null;
    const tiles = Uint8Array.from(mcnk.subarray(start + 8 + 81 * MCLQ_VERTEX_SIZE, start + 8 + 81 * MCLQ_VERTEX_SIZE + 64));
    layers.push({
      typeId, x0: 0, y0: 0, xTiles: 8, yTiles: 8, heights, depths, stored,
      wet: (x, y) => {
        const nibble = tiles[y * 8 + x] & 0x0F;
        return nibble !== TILE_NO_LIQUID && ((nibble ^ (kind - 1)) & 3) === 0;
      },
    });
    start += MCLQ_LAYER_SIZE;
  }
  return layers;
}

// Chunk `index`'s MH2O layers as grids over their part of the chunk.
function readMh2o(mh2o, index) {
  const header = index * MH2O_CHUNK_SIZE;
  if (header + MH2O_CHUNK_SIZE > mh2o.length) return [];
  const offset = mh2o.readUInt32LE(header);
  const count = mh2o.readUInt32LE(header + 4);
  const layers = [];
  for (let layer = 0; layer < count && offset; layer += 1) {
    const base = offset + layer * MH2O_LAYER_SIZE;
    if (base + MH2O_LAYER_SIZE > mh2o.length) break;
    const typeId = mh2o.readUInt16LE(base);
    const format = mh2o.readUInt16LE(base + 2);
    const minHeight = mh2o.readFloatLE(base + 4);
    const [x0, y0, xTiles, yTiles] = [mh2o[base + 12], mh2o[base + 13], mh2o[base + 14], mh2o[base + 15]];
    const maskOffset = mh2o.readUInt32LE(base + 16);
    const vertexOffset = mh2o.readUInt32LE(base + 20);
    if (!xTiles || !yTiles || x0 + xTiles > CHUNK_TILES || y0 + yTiles > CHUNK_TILES) continue;
    const vertexCount = (xTiles + 1) * (yTiles + 1);
    const fits = (bytes) => vertexOffset && vertexOffset + bytes <= mh2o.length;
    const withHeights = format === FORMAT_DEPTH || format === FORMAT_TEXCOORDS;
    const heights = Float32Array.from({ length: vertexCount }, (_, vertex) => {
      if (!withHeights) return 0;
      return fits(vertexCount * 4) ? mh2o.readFloatLE(vertexOffset + vertex * 4) : minHeight;
    });
    const depthStart = format === FORMAT_DEPTH ? vertexOffset + vertexCount * 4 : vertexOffset;
    const depths = Uint8Array.from({ length: vertexCount }, (_, vertex) => {
      if (format === FORMAT_DEPTH_ONLY && !vertexOffset) return NO_DEPTH_DATA;
      if (format !== FORMAT_DEPTH && format !== FORMAT_DEPTH_ONLY) return 0;
      return fits(depthStart - vertexOffset + vertexCount) ? mh2o[depthStart + vertex] : 0;
    });
    const stored = format === FORMAT_TEXCOORDS && fits(vertexCount * 8)
      ? Uint16Array.from({ length: vertexCount * 2 }, (_, at) => mh2o.readUInt16LE(vertexOffset + vertexCount * 4 + at * 2))
      : null;
    // One bit per tile, row by row, low bit first; no mask means all.
    const wet = maskOffset
      ? (x, y) => {
        const bit = y * xTiles + x;
        const byte = maskOffset + (bit >> 3);
        return byte < mh2o.length && Boolean(mh2o[byte] & (1 << (bit & 7)));
      }
      : () => true;
    layers.push({ typeId, x0, y0, xTiles, yTiles, heights, depths, stored, wet });
  }
  return layers;
}

// The vertex format MCLQ layers take when their material is not given:
// magma and slime carry texture coordinates, water depth bytes.
const defaultVertexFormat = (typeId) => ([3, 4, GREEN_LAVA].includes(typeId) ? FORMAT_TEXCOORDS : FORMAT_DEPTH);

// One ADT tile's liquid surfaces by LiquidType ID, for chunks overlapping
// `area` (see terrain.mjs's chunkInArea), in server coordinates; `mapId`
// for Outland's green lava, `vertexFormat(typeId)` the type's material's
// format. Tiles lying wholly under the ground are left out (Utgarde Keep has
// a sea far below its mountain).
export function adtLiquidSurfaces(adtBuffer, { inArea = () => true, mapId = 0, vertexFormat = defaultVertexFormat } = {}) {
  const chunks = readChunks(adtBuffer);
  const mh2o = findChunk(chunks, 'MH2O');
  const surfaces = new Map();
  chunks.filter((chunk) => chunk.id === 'MCNK').forEach(({ data: mcnk }, index) => {
    if (mcnk.length < MCNK_HEADER_SIZE) return;
    const position = readFloats(mcnk, MCNK_POSITION, 3);
    if (!inArea(position)) return;
    const layers = mh2o?.length
      ? readMh2o(mh2o, index)
      : readMclq(mcnk, { mapId, vertexFormat: (typeId) => vertexFormat(typeId) ?? defaultVertexFormat(typeId) });
    if (!layers.length) return;
    const ground = tileGround(mcnk);
    for (const layer of layers) {
      const { x0, y0, xTiles, heights, depths, stored } = layer;
      const at = (x, y) => y * (xTiles + 1) + x;
      const top = (x, y) => Math.max(heights[at(x, y)], heights[at(x + 1, y)], heights[at(x, y + 1)], heights[at(x + 1, y + 1)]);
      if (!surfaces.has(layer.typeId)) surfaces.set(layer.typeId, new LiquidSurface());
      surfaces.get(layer.typeId).add({
        ...layer,
        wet: (x, y) => layer.wet(x, y) && top(x, y) >= ground[(y0 + y) * 8 + x0 + x],
        place: (x, y) => [position[0] - (y0 + y) * LIQUID_UNIT, position[1] - (x0 + x) * LIQUID_UNIT],
        uv: stored
          ? (x, y) => [stored[at(x, y) * 2] * TERRAIN_STORED_UV_SCALE, stored[at(x, y) * 2 + 1] * TERRAIN_STORED_UV_SCALE]
          : (x, y, [px, py]) => [px * TERRAIN_UV_SCALE, py * TERRAIN_UV_SCALE],
        depth: (x, y) => depths[at(x, y)],
      });
    }
  });
  const finished = new Map();
  for (const [typeId, surface] of surfaces) {
    const result = surface.finish();
    if (result) finished.set(typeId, result);
  }
  return finished;
}
