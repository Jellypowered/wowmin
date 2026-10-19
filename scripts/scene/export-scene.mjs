// Builds <mapId>.glb for one instance map: every placed WMO with its groups
// and doodad set, and the doodads placed directly on ADT tiles and the ADT
// terrain within the area players use. Node transforms keep server world coordinates
// under a single Z-up to Y-up root, so the renderer can place telemetry
// directly.

import fs from 'node:fs';
import path from 'node:path';

import { Document, NodeIO, TextureInfo } from '@gltf-transform/core';
import { EXTMeshGPUInstancing, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';

import {
  loadM2, M2_ALPHA_KEY_CUTOFF, M2_BLEND, M2_MATERIAL_FLAG_TWO_SIDED, M2_MATERIAL_FLAGS_DRAWN, M2_TEXTURE_FLAG_WRAP_S, M2_TEXTURE_FLAG_WRAP_T,
} from './m2.mjs';
import { dedupeByUniqueId, readAdtPlacements, readWdt, rotateByQuaternion } from './placement.mjs';
import { PNG } from 'pngjs';

import { ATLAS_SIZE, buildTerrainTile, chunkInArea, playArea, pointInArea, WDT_FLAG_BIG_ALPHA } from './terrain.mjs';
import { readDbc } from './dbc.mjs';
import { adtLiquidSurfaces, liquidTexCoords, liquidTypeInfo, wmoGroupLiquid } from './liquids.mjs';
import { encodeTexture } from './textures.mjs';
import {
  floorFaces,
  loadWmo,
  propFloor,
  selectDoodadIndices,
  WMO_MATERIAL_FLAG_UNLIT,
  WMO_MATERIAL_FLAG_WINDOW,
  WMO_ROOT_FLAG_UNIFIED,
  WMO_GROUP_FLAG_EXTERIOR,
  WMO_GROUP_FLAG_EXTERIOR_LIT,
  WMO_MATERIAL_FLAG_CLAMP_S,
  WMO_MATERIAL_FLAG_CLAMP_T,
  WMO_MATERIAL_FLAG_UNCULLED,
} from './wmo.mjs';

// -90° about X: (x, y, z) Z-up becomes (x, z, -y) Y-up.
const Z_UP_TO_Y_UP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const DUNGEON_MAP_CHUNK_NO_MIN_Z = -9999;
// Ground textures are tileable and small; the renderer resamples them into
// one texture array.
const TERRAIN_TEXTURE_MAX = 256;
const LIQUID_TEXTURE_MAX = 128;

const WMO_BLEND = ['opaque', 'alphaKey', 'alpha', 'add', 'mod', 'mod2x'];

// The box around `boxes` ({ minX, maxX, minY, maxY, minZ, maxZ } each);
// infinite bounds when there are none.
function unionBounds(boxes) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const box of boxes) {
    bounds.minX = Math.min(bounds.minX, box.minX); bounds.maxX = Math.max(bounds.maxX, box.maxX);
    bounds.minY = Math.min(bounds.minY, box.minY); bounds.maxY = Math.max(bounds.maxY, box.maxY);
    bounds.minZ = Math.min(bounds.minZ, box.minZ); bounds.maxZ = Math.max(bounds.maxZ, box.maxZ);
  }
  return bounds;
}

export function transformBoundingBox([minX, minY, minZ, maxX, maxY, maxZ], { position, rotation, scale = 1 }) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        const [rx, ry, rz] = rotateByQuaternion([x * scale, y * scale, z * scale], rotation);
        const world = [rx + position[0], ry + position[1], rz + position[2]];
        bounds.minX = Math.min(bounds.minX, world[0]); bounds.maxX = Math.max(bounds.maxX, world[0]);
        bounds.minY = Math.min(bounds.minY, world[1]); bounds.maxY = Math.max(bounds.maxY, world[1]);
        bounds.minZ = Math.min(bounds.minZ, world[2]); bounds.maxZ = Math.max(bounds.maxZ, world[2]);
      }
    }
  }
  return bounds;
}

// Doodads by parent node (the map root, or a building) and then by model.
// Copies of one model under one parent become a single node drawn with GPU
// instancing (EXT_mesh_gpu_instancing): the viewer draws each model once per
// building, and once for all the map's loose props, instead of once per copy.
// A building prop's floor light (propFloor in wmo.mjs) as the scene stores
// it: [r, g, b, share]; r is -1 for a prop lit by the outdoor light, -2 for
// one with no floor found.
const PROP_FLOOR_OUTDOOR = [-1, 0, 0, 0];
const PROP_FLOOR_NONE = [-2, 0, 0, 0];
export const encodePropFloor = (floor) =>
  floor === 'outdoor' ? PROP_FLOOR_OUTDOOR : floor ? floor.map((value) => Math.round(value * 1000) / 1000) : PROP_FLOOR_NONE;

export class DoodadBatches {
  constructor(builder) {
    this.builder = builder;
    this.parents = new Map();
  }

  // `floor` (a building's props only): see propFloor.
  add(parent, mesh, { position, rotation, scale }, floor) {
    let byMesh = this.parents.get(parent);
    if (!byMesh) this.parents.set(parent, byMesh = new Map());
    let copies = byMesh.get(mesh);
    if (!copies) byMesh.set(mesh, copies = []);
    copies.push({ position, rotation, scale, ...(floor === undefined ? {} : { floor: encodePropFloor(floor) }) });
  }

  // Adds the nodes; returns how many are instanced.
  write() {
    const { builder } = this;
    const { document } = builder;
    let instancing = null;
    let batches = 0;
    for (const [parent, byMesh] of this.parents) {
      for (const [mesh, copies] of byMesh) {
        if (copies.length === 1) {
          const [{ position, rotation, scale, floor }] = copies;
          parent.addChild(document.createNode(`doodad-${mesh.getName()}`).setMesh(mesh)
            .setTranslation(position).setRotation(rotation).setScale([scale, scale, scale])
            .setExtras({ kind: 'doodad', ...(floor ? { wowFloor: floor } : {}) }));
          continue;
        }
        instancing ??= document.createExtension(EXTMeshGPUInstancing).setRequired(true);
        const translations = new Float32Array(copies.length * 3);
        const rotations = new Float32Array(copies.length * 4);
        const scales = new Float32Array(copies.length * 3);
        copies.forEach(({ position, rotation, scale }, index) => {
          translations.set(position, index * 3);
          rotations.set(rotation, index * 4);
          scales.set([scale, scale, scale], index * 3);
        });
        const batch = instancing.createInstancedMesh()
          .setAttribute('TRANSLATION', builder.accessor('VEC3', translations))
          .setAttribute('ROTATION', builder.accessor('VEC4', rotations))
          .setAttribute('SCALE', builder.accessor('VEC3', scales));
        if (copies.some((copy) => copy.floor)) {
          const floors = new Float32Array(copies.length * 4);
          copies.forEach(({ floor }, index) => floors.set(floor ?? PROP_FLOOR_NONE, index * 4));
          batch.setAttribute('_WOWFLOOR', builder.accessor('VEC4', floors));
        }
        parent.addChild(document.createNode(`doodads-${mesh.getName()}`).setMesh(mesh)
          .setExtension('EXT_mesh_gpu_instancing', batch)
          .setExtras({ kind: 'doodads', count: copies.length }));
        batches += 1;
      }
    }
    return batches;
  }
}

// The scene as GLB with its geometry meshopt-compressed (EXT_meshopt_compression,
// which three.js decodes). Filter mode: lossless, except normals are stored
// as 8-bit octahedral vectors. Textures are already compressed images.
async function writeCompressed(document) {
  await MeshoptEncoder.ready;
  // The encoder takes whole triangles only; a few client meshes end in a
  // partial one (Ruins of Ahn'Qiraj), which draws nothing anyway.
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const count = indices?.getCount() ?? 0;
      if (indices && count % 3) indices.setArray(indices.getArray().slice(0, count - (count % 3)));
    }
  }
  document.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  return new NodeIO().registerExtensions([EXTMeshoptCompression, EXTMeshGPUInstancing])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
    .writeBinary(document);
}

// The box players can reach: the buildings in the play area (`area`, a list
// of boxes; empty for all of them), the map's graveyards and start points
// (`points`, [x, y, z]), and any building within SAFE_POINT_REACH yards of
// one (a battleground's start platforms, outside its world map). Players
// don't get beyond the outermost buildings, above the tallest roof, or below
// the lowest foundation, so the viewer leaves out what lies beyond (the
// mountains around a battleground and the flat ground past them). Null when
// there is nothing to go by.
const SAFE_POINT_REACH = 100;

export function buildingReach(groups, area, points = []) {
  const inArea = (group) => !area.length || area.some((box) =>
    group.minX <= box.maxX && group.maxX >= box.minX && group.minY <= box.maxY && group.maxY >= box.minY);
  const nearPoint = (group) => points.some(([x, y]) => Math.hypot(
    Math.max(group.minX - x, 0, x - group.maxX), Math.max(group.minY - y, 0, y - group.maxY)) <= SAFE_POINT_REACH);
  const boxes = [
    ...groups.filter((group) => inArea(group) || nearPoint(group)),
    ...points.map(([x, y, z]) => ({ minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z })),
  ];
  return boxes.length ? unionBounds(boxes) : null;
}

// The map's graveyards and start points (WorldSafeLocs.dbc: map, x, y, z),
// places players are sure to reach.
export function safePoints(readFile, mapId) {
  const buffer = readFile('DBFilesClient\\WorldSafeLocs.dbc');
  if (!buffer) return [];
  const points = [];
  for (const record of readDbc(buffer).records()) {
    if (record.uint(1) === mapId) points.push([record.float(2), record.float(3), record.float(4)]);
  }
  return points;
}

// A floor's height range is the union of its WMO groups' ranges. Groups shared
// between floors (DungeonMapChunk rows with a real minZ) split at that height.
export function computeFloorHeights(floors, groups) {
  const groupRange = (wmoGroupId) => {
    const matches = groups.filter((group) => group.wmoGroupId === wmoGroupId);
    return matches.length
      ? { minZ: Math.min(...matches.map((group) => group.minZ)), maxZ: Math.max(...matches.map((group) => group.maxZ)) }
      : null;
  };
  const splits = (wmoGroupId) => floors.flatMap((floor) => floor.chunks)
    .filter((chunk) => chunk.wmoGroupId === wmoGroupId && chunk.minZ > DUNGEON_MAP_CHUNK_NO_MIN_Z)
    .map((chunk) => chunk.minZ);

  return floors.map((floor) => {
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const chunk of floor.chunks) {
      const range = groupRange(chunk.wmoGroupId);
      if (!range) continue;
      const lower = chunk.minZ > DUNGEON_MAP_CHUNK_NO_MIN_Z ? Math.max(chunk.minZ, range.minZ) : range.minZ;
      const upper = Math.min(range.maxZ, ...splits(chunk.wmoGroupId).filter((split) => split > lower));
      minZ = Math.min(minZ, lower);
      maxZ = Math.max(maxZ, upper);
    }
    return Number.isFinite(minZ) ? { id: floor.id, minZ, maxZ } : null;
  }).filter(Boolean);
}

// Vertex colours as RGBA, keeping their alpha: on transition batches it is
// how far the client leans them to the outdoor light.
function bgraToRgba(colors) {
  const rgba = new Uint8Array(colors.length);
  for (let index = 0; index < colors.length; index += 4) {
    rgba[index] = colors[index + 2];
    rgba[index + 1] = colors[index + 1];
    rgba[index + 2] = colors[index];
    rgba[index + 3] = colors[index + 3];
  }
  return rgba;
}

// A BGRA colour (a WMO header's) as 0xRRGGBB.
const bgraToRgb = (bgra) => bgra & 0xffffff;

class SceneBuilder {
  constructor({ readFile, textureMax }) {
    this.readFile = readFile;
    this.textureMax = textureMax;
    this.document = new Document();
    this.buffer = this.document.createBuffer();
    this.textures = new Map();
    this.models = new Map();
    this.missing = new Set();
  }

  // A liquid type's settings (liquidTypeInfo), or null if unknown.
  liquidType(typeId) {
    this.liquidTypes ??= new Map();
    if (this.liquidTypes.has(typeId)) return this.liquidTypes.get(typeId);
    this.liquidTables ??= (() => {
      const table = (name) => {
        const buffer = this.readFile(`DBFilesClient\\${name}.dbc`);
        return buffer ? readDbc(buffer).byId() : new Map();
      };
      return { types: table('LiquidType'), materials: table('LiquidMaterial') };
    })();
    const info = liquidTypeInfo(this.liquidTables.types, typeId, this.readFile, this.liquidTables.materials);
    this.liquidTypes.set(typeId, info);
    return info;
  }

  // A liquid type's material, named liquid-<id>, with its animation frames
  // as materials liquid-frame-<n>, shared by types with the same texture.
  // Its extras say how the client draws it: its material (water, magma),
  // water's depth ramp, magma's scroll, and the frames' period (ms). Null
  // if unknown.
  liquidMaterial(typeId) {
    this.liquidMaterials ??= new Map();
    if (this.liquidMaterials.has(typeId)) return this.liquidMaterials.get(typeId);
    const info = this.liquidType(typeId);
    let material = null;
    if (info?.frames.length) {
      this.liquidFrames ??= new Map();
      const frames = info.frames.flatMap((name) => {
        const key = name.toLowerCase();
        if (!this.liquidFrames.has(key)) {
          let frameName = null;
          try {
            const encoded = encodeTexture(this.readFile(name), LIQUID_TEXTURE_MAX);
            const image = this.document.createTexture(path.win32.basename(name)).setImage(encoded.data).setMimeType(encoded.mimeType);
            frameName = `liquid-frame-${this.liquidFrames.size}`;
            this.document.createMaterial(frameName).setBaseColorTexture(image);
          } catch {
            // An unreadable frame is skipped.
          }
          this.liquidFrames.set(key, frameName);
        }
        const frameName = this.liquidFrames.get(key);
        return frameName ? [frameName] : [];
      });
      if (frames.length) {
        material = this.document.createMaterial(`liquid-${typeId}`).setDoubleSided(true)
          .setExtras({
            wowLiquid: {
              id: typeId, material: info.material, frames, period: info.period,
              ...(info.ramp ? { ramp: info.ramp } : {}),
              ...(info.scroll ? { scroll: info.scroll } : {}),
            },
          });
      }
    }
    this.liquidMaterials.set(typeId, material);
    return material;
  }

  // A liquid surface (positions, indices) as a one-primitive mesh, with its
  // texture coordinates (liquidTexCoords): TEXCOORD_0 the ripple (or lava)
  // texture's, TEXCOORD_1 water's depth ramp's.
  liquidMesh(name, surface, material, { ripple, ramp }) {
    const primitive = this.document.createPrimitive()
      .setAttribute('POSITION', this.accessor('VEC3', surface.positions))
      .setAttribute('TEXCOORD_0', this.accessor('VEC2', ripple))
      .setIndices(this.accessor('SCALAR', surface.indices))
      .setMaterial(material);
    if (ramp) primitive.setAttribute('TEXCOORD_1', this.accessor('VEC2', ramp));
    return this.document.createMesh(name).addPrimitive(primitive);
  }

  accessor(type, array, normalized = false) {
    return this.document.createAccessor().setType(type).setArray(array).setNormalized(normalized).setBuffer(this.buffer);
  }

  indexAccessor(source, start, count) {
    const slice = source.subarray(start, start + count);
    const max = slice.reduce((highest, value) => Math.max(highest, value), 0);
    return this.accessor('SCALAR', max > 0xFFFF ? Uint32Array.from(slice) : Uint16Array.from(slice));
  }

  texture(name) {
    if (!name) return null;
    const key = name.toLowerCase();
    if (this.textures.has(key)) return this.textures.get(key);
    let texture = null;
    const blp = this.readFile(name);
    if (blp) {
      try {
        const encoded = encodeTexture(blp, this.textureMax);
        texture = this.document.createTexture(path.basename(name)).setImage(encoded.data).setMimeType(encoded.mimeType);
      } catch (error) {
        console.warn(`  ! Could not decode ${name}: ${error instanceof Error ? error.message : error}`);
      }
    } else {
      this.missing.add(name);
    }
    this.textures.set(key, texture);
    return texture;
  }

  // `mapObjFlags`: a building material's MOMT flags (0x1 unlit, 0x20
  // window), which choose the light the client draws it with; `m2Flags` a
  // prop's material flags (M2_MATERIAL_FLAGS_DRAWN), which say whether it is
  // lit and how it takes depth. A prop's alpha key is the client's.
  material(name, { texture, blend, doubleSided, wrapS, wrapT, tint = [1, 1, 1], opacity = 1, mapObjFlags, m2Flags }) {
    const material = this.document.createMaterial(name)
      .setMetallicFactor(0)
      .setRoughnessFactor(1)
      .setBaseColorFactor([...tint, opacity])
      .setDoubleSided(doubleSided)
      .setExtras({
        wowBlend: blend,
        ...(mapObjFlags ? { wowMapObjFlags: mapObjFlags } : {}),
        ...(m2Flags === undefined ? {} : { wowMaterialFlags: m2Flags }),
      });
    if (blend === 'alphaKey') material.setAlphaMode('MASK').setAlphaCutoff(m2Flags === undefined ? 0.5 : M2_ALPHA_KEY_CUTOFF);
    else if (blend !== 'opaque' || opacity < 1) material.setAlphaMode('BLEND');
    const image = this.texture(texture);
    if (image) {
      material.setBaseColorTexture(image);
      material.getBaseColorTextureInfo()
        .setWrapS(wrapS ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE)
        .setWrapT(wrapT ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE);
    }
    return material;
  }

  wmoMeshes(wmo, rootName) {
    const materials = wmo.materials.map((material, index) => this.material(`${path.basename(rootName)}#${index}`, {
      texture: material.texture,
      blend: WMO_BLEND[material.blendMode] ?? 'opaque',
      doubleSided: Boolean(material.flags & WMO_MATERIAL_FLAG_UNCULLED),
      wrapS: !(material.flags & WMO_MATERIAL_FLAG_CLAMP_S),
      wrapT: !(material.flags & WMO_MATERIAL_FLAG_CLAMP_T),
      mapObjFlags: material.flags & (WMO_MATERIAL_FLAG_UNLIT | WMO_MATERIAL_FLAG_WINDOW),
    }));
    return wmo.groups.map((group) => {
      if (!group.batches.length) return null;
      const mesh = this.document.createMesh(`${path.basename(rootName)}_${group.index}`);
      const position = this.accessor('VEC3', group.positions);
      const normal = this.accessor('VEC3', group.normals);
      const uv = this.accessor('VEC2', group.uvs);
      const color = group.colors ? this.accessor('VEC4', bgraToRgba(group.colors), true) : null;
      const floors = color && !(group.flags & (WMO_GROUP_FLAG_EXTERIOR | WMO_GROUP_FLAG_EXTERIOR_LIT))
        ? this.wmoFloorMeshes(`${path.basename(rootName)}_${group.index}`, group, position, color) : [];
      for (const batch of group.batches) {
        const primitive = this.document.createPrimitive()
          .setAttribute('POSITION', position)
          .setAttribute('NORMAL', normal)
          .setAttribute('TEXCOORD_0', uv)
          .setIndices(this.indexAccessor(group.indices, batch.indexStart, batch.indexCount))
          .setMaterial(materials[batch.materialIndex] ?? null);
        if (color) primitive.setAttribute('COLOR_0', color);
        mesh.addPrimitive(primitive);
      }
      return { mesh, floors };
    });
  }

  // An interior group's floor, which units are lit by: its floor faces
  // (floorFaces in wmo.mjs) as a mesh of their own, the transition faces as
  // a second one, sharing the group's positions and vertex colours. Never
  // drawn.
  wmoFloorMeshes(name, group, position, color) {
    const { floor, transition } = floorFaces(group);
    return [[floor, false], [transition, true]].filter(([faces]) => faces.length).map(([faces, isTransition]) => {
      const indices = new Uint32Array(faces.length * 3);
      faces.forEach((triangle, index) => indices.set(group.indices.subarray(triangle * 3, triangle * 3 + 3), index * 3));
      const mesh = this.document.createMesh(`${name}-floor${isTransition ? '-transition' : ''}`).addPrimitive(this.document.createPrimitive()
        .setAttribute('POSITION', position)
        .setAttribute('COLOR_0', color)
        .setIndices(this.indexAccessor(indices, 0, indices.length)));
      return { mesh, transition: isTransition };
    });
  }

  m2Mesh(modelName) {
    const key = modelName.toLowerCase();
    if (this.models.has(key)) return this.models.get(key);
    let mesh = null;
    const model = loadM2(modelName, this.readFile);
    if (model) {
      mesh = this.document.createMesh(path.basename(modelName));
      const position = this.accessor('VEC3', model.positions);
      const normal = this.accessor('VEC3', model.normals);
      const uv = this.accessor('VEC2', model.uvs);
      const materials = new Map();
      for (const batch of model.batches) {
        if (batch.opacity <= 0) continue;
        const materialKey = [batch.texture, batch.blend, batch.materialFlags, batch.textureFlags, ...batch.tint, batch.opacity].join('|');
        if (!materials.has(materialKey)) {
          materials.set(materialKey, this.material(`${path.basename(modelName)}#${materials.size}`, {
            texture: batch.texture,
            blend: M2_BLEND[batch.blend] ?? 'opaque',
            doubleSided: Boolean(batch.materialFlags & M2_MATERIAL_FLAG_TWO_SIDED),
            wrapS: Boolean(batch.textureFlags & M2_TEXTURE_FLAG_WRAP_S),
            wrapT: Boolean(batch.textureFlags & M2_TEXTURE_FLAG_WRAP_T),
            tint: batch.tint,
            opacity: batch.opacity,
            m2Flags: batch.materialFlags & M2_MATERIAL_FLAGS_DRAWN,
          }));
        }
        mesh.addPrimitive(this.document.createPrimitive()
          .setAttribute('POSITION', position)
          .setAttribute('NORMAL', normal)
          .setAttribute('TEXCOORD_0', uv)
          .setIndices(this.indexAccessor(model.indices, batch.indexStart, batch.indexCount))
          .setMaterial(materials.get(materialKey)));
      }
    } else {
      this.missing.add(modelName);
    }
    this.models.set(key, mesh);
    return mesh;
  }
}

export async function exportMapScene({
  mapId, internalName, readFile, outputDir, textureMax = 512, floors = [], worldMapBounds = null,
}) {
  const mapPath = `World\\maps\\${internalName}\\${internalName}`;
  const wdtBuffer = readFile(`${mapPath}.wdt`);
  if (!wdtBuffer) throw new Error(`Missing ${mapPath}.wdt`);
  const wdt = readWdt(wdtBuffer);

  let wmoPlacements = wdt.wmo ? [wdt.wmo] : [];
  let doodadPlacements = [];
  if (!wdt.wmoOnly) {
    const tiles = wdt.tiles.map(({ x, y }) => readFile(`${mapPath}_${x}_${y}.adt`)).filter(Boolean).map(readAdtPlacements);
    wmoPlacements = dedupeByUniqueId(tiles.flatMap((tile) => tile.wmos));
    doodadPlacements = dedupeByUniqueId(tiles.flatMap((tile) => tile.doodads));
  }
  if (!wmoPlacements.length && !doodadPlacements.length) throw new Error(`${internalName} places no buildings or doodads.`);

  const builder = new SceneBuilder({ readFile, textureMax });
  const { document } = builder;
  const root = document.createNode('wow-world').setRotation(Z_UP_TO_Y_UP);
  document.createScene(`map-${mapId}`).addChild(root);

  const groups = [];
  const doodads = new DoodadBatches(builder);
  const skippedWmos = [];
  let doodadCount = 0;
  let liquidCount = 0;
  let liquidTriangles = 0;
  for (const placement of wmoPlacements) {
    let wmo;
    try {
      wmo = loadWmo(placement.name, readFile);
    } catch (error) {
      skippedWmos.push(`${placement.name} (${error instanceof Error ? error.message : error})`);
      continue;
    }
    const wmoNode = document.createNode(path.basename(placement.name))
      .setTranslation(placement.position)
      .setRotation(placement.rotation)
      .setScale([placement.scale, placement.scale, placement.scale]);
    root.addChild(wmoNode);

    const meshes = builder.wmoMeshes(wmo, placement.name);
    wmo.groups.forEach((group, index) => {
      const bounds = transformBoundingBox(group.boundingBox, placement);
      const exterior = Boolean(group.flags & WMO_GROUP_FLAG_EXTERIOR);
      if (!meshes[index]) return;
      for (const floor of meshes[index].floors) {
        wmoNode.addChild(document.createNode(`floor-${group.index}${floor.transition ? '-transition' : ''}`).setMesh(floor.mesh)
          .setExtras({ kind: 'wmoFloor', wmoGroupId: group.groupId, ...(floor.transition ? { transition: true } : {}) }));
      }
      groups.push({ wmoGroupId: group.groupId, exterior, ...bounds });
      // How the client lights the group's batches (buildingBatchLight in the
      // renderer): its transition, interior, and exterior batch counts
      // (its primitives are its batches, in that order); whether the
      // building takes the newer render path, which adds its ambient
      // (0xRRGGBB) to its interiors' light; and the group flags.
      const unified = Boolean(wmo.rootFlags & WMO_ROOT_FLAG_UNIFIED);
      wmoNode.addChild(document.createNode(`group-${group.index}`)
        .setMesh(meshes[index].mesh)
        .setExtras({
          kind: 'wmoGroup', wmoGroupId: group.groupId, exterior, minZ: bounds.minZ, maxZ: bounds.maxZ,
          wmoBatches: [group.transBatchCount, group.intBatchCount, group.extBatchCount],
          wmoFlags: group.flags,
          ...(unified ? { wmoUnified: true, wmoAmbient: bgraToRgb(wmo.ambient) } : {}),
        }));
    });

    // Each group's liquid, in the group's space under the building
    // (wmoGroupLiquid).
    wmo.groups.forEach((group) => {
      if (!group.liquid) return;
      const liquid = wmoGroupLiquid(wmo, group, (typeId) => builder.liquidType(typeId));
      const material = liquid && builder.liquidMaterial(liquid.typeId);
      if (!material) return;
      const { surface, texCoords, interior, color } = liquid;
      wmoNode.addChild(document.createNode(`liquid-${group.index}`)
        .setMesh(builder.liquidMesh(`liquid-${group.groupId}`, surface, material, texCoords))
        .setExtras({ kind: 'liquid', wmoGroupId: group.groupId, interior, ...(color ? { color } : {}) }));
      liquidCount += 1;
      liquidTriangles += surface.indices.length / 3;
    });

    for (const doodadIndex of selectDoodadIndices(wmo.sets, placement.doodadSet)) {
      const definition = wmo.definitions[doodadIndex];
      const mesh = definition && builder.m2Mesh(definition.name);
      if (!mesh) continue;
      doodads.add(wmoNode, mesh, definition, propFloor(wmo, doodadIndex, definition.position));
      doodadCount += 1;
    }
  }

  // The area players use: each dungeon map floor, the world map bounds, or
  // the buildings' area (see playArea). Loose props and the ground are
  // cropped to it; with nothing to go by, props are all kept.
  const area = wdt.wmoOnly ? [] : playArea(floors, worldMapBounds, undefined, groups);
  const looseDoodads = area.length
    ? doodadPlacements.filter((placement) => pointInArea(placement.position, area))
    : doodadPlacements;
  for (const placement of looseDoodads) {
    const mesh = builder.m2Mesh(placement.name);
    if (!mesh) continue;
    doodads.add(root, mesh, placement);
    doodadCount += 1;
  }
  const doodadBatches = doodads.write();

  // Terrain, cropped to the area players use (placeholder tiles are skipped).
  // A map with no floors, world map bounds, or buildings to go by gets none.
  const terrain = { tiles: 0, chunks: 0, bounds: null };
  if (area.length) {
    const bigAlpha = Boolean(wdt.flags & WDT_FLAG_BIG_ALPHA);
    const accessor = (type, array, normalized) => builder.accessor(type, array, normalized);
    const tileBounds = [];
    // Each ground texture once, as a material named for its layer index.
    const layerNames = [];
    const layerIndex = new Map();
    const textureIndex = (name) => {
      const key = name.toLowerCase();
      if (layerIndex.has(key)) return layerIndex.get(key);
      const blp = readFile(name);
      let index = -1;
      if (blp) {
        try {
          const encoded = encodeTexture(blp, TERRAIN_TEXTURE_MAX);
          const image = document.createTexture(path.win32.basename(name)).setImage(encoded.data).setMimeType(encoded.mimeType);
          index = layerNames.length;
          layerNames.push(`terrain-layer-${index}`);
          document.createMaterial(`terrain-layer-${index}`).setBaseColorTexture(image);
        } catch (error) {
          console.warn(`  ! Ground texture ${name} unreadable: ${error instanceof Error ? error.message : error}`);
        }
      }
      layerIndex.set(key, index);
      return index;
    };
    for (const { x, y } of wdt.tiles) {
      const adt = readFile(`${mapPath}_${x}_${y}.adt`);
      if (!adt) continue;
      // The tile's liquids, one mesh per liquid type.
      try {
        const liquids = adtLiquidSurfaces(adt, {
          inArea: (position) => chunkInArea(position, area), mapId, vertexFormat: (typeId) => builder.liquidType(typeId)?.vertexFormat,
        });
        for (const [typeId, surface] of liquids) {
          const liquidMaterial = builder.liquidMaterial(typeId);
          if (!liquidMaterial) continue;
          const texCoords = liquidTexCoords(surface, builder.liquidType(typeId));
          const liquidMesh = builder.liquidMesh(`liquid-${x}-${y}-${typeId}`, surface, liquidMaterial, texCoords);
          root.addChild(document.createNode(`liquid-${x}-${y}-${typeId}`).setMesh(liquidMesh).setExtras({ kind: 'liquid', tile: [x, y] }));
          liquidCount += 1;
          liquidTriangles += surface.indices.length / 3;
        }
      } catch (error) {
        console.warn(`  ! Liquids in tile ${x},${y} unreadable: ${error instanceof Error ? error.message : error}`);
      }
      let tile;
      try {
        tile = buildTerrainTile(adt, { bigAlpha, area, textureIndex });
      } catch (error) {
        console.warn(`  ! Terrain tile ${x},${y} unreadable: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      if (!tile) continue;
      // The tile's layer alphas and shadow, lossless.
      const atlas = document.createTexture(`terrain-alpha-${x}-${y}`).setMimeType('image/png')
        .setImage(PNG.sync.write({ width: ATLAS_SIZE, height: ATLAS_SIZE, data: Buffer.from(tile.atlas.buffer) }));
      document.createMaterial(`terrain-alpha-${x}-${y}`).setBaseColorTexture(atlas);
      const material = document.createMaterial(`terrain-${x}-${y}`).setMetallicFactor(0).setRoughnessFactor(1)
        .setExtras({ wowTerrain: true, alpha: `terrain-alpha-${x}-${y}`, origin: tile.origin });
      const mesh = document.createMesh(`terrain-${x}-${y}`).addPrimitive(document.createPrimitive()
        .setAttribute('POSITION', accessor('VEC3', tile.positions))
        .setAttribute('NORMAL', accessor('VEC3', tile.normals))
        .setAttribute('COLOR_0', accessor('VEC3', tile.colors, true))
        .setAttribute('_LAYERS', accessor('VEC4', tile.layers))
        .setAttribute('_CELL', accessor('VEC2', tile.cells))
        .setIndices(accessor('SCALAR', tile.indices))
        .setMaterial(material));
      // The tile's baked shadow by chunk, which the client shades units and
      // props by (the atlas carries the same for the ground's look).
      root.addChild(document.createNode(`terrain-${x}-${y}`).setMesh(mesh)
        .setExtras({ kind: 'terrain', tile: [x, y], minZ: tile.bounds.minZ, maxZ: tile.bounds.maxZ, wowShadows: tile.shadows }));
      terrain.tiles += 1;
      terrain.chunks += tile.chunkCount;
      tileBounds.push(tile.bounds);
    }
    if (terrain.tiles) {
      terrain.bounds = unionBounds(tileBounds);
      root.setExtras({ ...root.getExtras(), wowTerrainLayers: layerNames });
    }
  }

  if (!groups.length && !doodadCount && !terrain.tiles) throw new Error(`${internalName} produced no drawable geometry.`);

  const file = `${mapId}.glb`;
  const glb = await writeCompressed(document);
  fs.writeFileSync(path.join(outputDir, file), glb);

  // Scenes with only loose doodads have no group bounds; pad their positions.
  const boundsSources = groups.length ? groups : looseDoodads.map(({ position: [x, y, z] }) => ({
    minX: x - 50, maxX: x + 50, minY: y - 50, maxY: y + 50, minZ: z - 50, maxZ: z + 50,
  }));
  const bounds = unionBounds(boundsSources);
  const heights = new Map(computeFloorHeights(floors, groups).map((floor) => [floor.id, floor]));

  return {
    scene: {
      file,
      bounds,
      groups: groups.map(({ wmoGroupId, exterior, minZ, maxZ }) => ({ wmoGroupId, exterior, minZ, maxZ })),
      // Every floor, so the 3D view can tell which one a player is on; the
      // height range only where its WMO groups give one.
      floors: floors.map((floor) => ({ ...floor, ...heights.get(floor.id) })),
      buildingReach: buildingReach(groups, area, safePoints(readFile, mapId)),
      ...(terrain.tiles ? { terrain: { tiles: terrain.tiles, chunks: terrain.chunks, bounds: terrain.bounds } } : {}),
    },
    stats: {
      liquidCount,
      liquidTriangles,
      terrainTiles: terrain.tiles,
      terrainChunks: terrain.chunks,
      bytes: glb.byteLength,
      wmoCount: wmoPlacements.length,
      groupCount: groups.length,
      doodadCount,
      doodadBatches,
      modelCount: [...builder.models.values()].filter(Boolean).length,
      textureCount: [...builder.textures.values()].filter(Boolean).length,
      missing: [...builder.missing],
      skippedWmos,
    },
  };
}
