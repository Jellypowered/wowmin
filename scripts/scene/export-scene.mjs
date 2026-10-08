// Builds <mapId>.glb for one instance map: every placed WMO with its groups
// and doodad set, plus doodads placed directly on ADT tiles. Terrain geometry
// is not exported yet. Node transforms keep server world coordinates under a
// single Z-up to Y-up root, so the renderer can place telemetry directly.

import fs from 'node:fs';
import path from 'node:path';

import { Document, NodeIO, TextureInfo } from '@gltf-transform/core';

import { loadM2, M2_MATERIAL_FLAG_TWO_SIDED, M2_TEXTURE_FLAG_WRAP_S, M2_TEXTURE_FLAG_WRAP_T } from './m2.mjs';
import { dedupeByUniqueId, readAdtPlacements, readWdt } from './placement.mjs';
import { encodeTexture } from './textures.mjs';
import {
  loadWmo,
  selectDoodadIndices,
  WMO_GROUP_FLAG_EXTERIOR,
  WMO_MATERIAL_FLAG_CLAMP_S,
  WMO_MATERIAL_FLAG_CLAMP_T,
  WMO_MATERIAL_FLAG_UNCULLED,
} from './wmo.mjs';

// -90° about X: (x, y, z) Z-up becomes (x, z, -y) Y-up.
const Z_UP_TO_Y_UP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const DUNGEON_MAP_CHUNK_NO_MIN_Z = -9999;

const WMO_BLEND = ['opaque', 'alphaKey', 'alpha', 'add', 'mod', 'mod2x'];
const M2_BLEND = ['opaque', 'alphaKey', 'alpha', 'add', 'add', 'mod', 'mod2x'];

export function rotateByQuaternion([x, y, z], [qx, qy, qz, qw]) {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
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

function bgraToRgba(colors) {
  const rgba = new Uint8Array(colors.length);
  for (let index = 0; index < colors.length; index += 4) {
    rgba[index] = colors[index + 2];
    rgba[index + 1] = colors[index + 1];
    rgba[index + 2] = colors[index];
    rgba[index + 3] = 255;
  }
  return rgba;
}

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

  material(name, { texture, blend, doubleSided, wrapS, wrapT, tint = [1, 1, 1], opacity = 1 }) {
    const material = this.document.createMaterial(name)
      .setMetallicFactor(0)
      .setRoughnessFactor(1)
      .setBaseColorFactor([...tint, opacity])
      .setDoubleSided(doubleSided)
      .setExtras({ wowBlend: blend });
    if (blend === 'alphaKey') material.setAlphaMode('MASK').setAlphaCutoff(0.5);
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
    }));
    return wmo.groups.map((group) => {
      if (!group.batches.length) return null;
      const mesh = this.document.createMesh(`${path.basename(rootName)}_${group.index}`);
      const position = this.accessor('VEC3', group.positions);
      const normal = this.accessor('VEC3', group.normals);
      const uv = this.accessor('VEC2', group.uvs);
      const color = group.colors ? this.accessor('VEC4', bgraToRgba(group.colors), true) : null;
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
      return mesh;
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

export async function exportMapScene({ mapId, internalName, readFile, outputDir, textureMax = 512, floors = [] }) {
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
  const skippedWmos = [];
  let doodadCount = 0;
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
    const doodadGroups = new Map();
    wmo.groups.forEach((group, index) => {
      const bounds = transformBoundingBox(group.boundingBox, placement);
      const exterior = Boolean(group.flags & WMO_GROUP_FLAG_EXTERIOR);
      for (const doodadIndex of group.doodadRefs) doodadGroups.set(doodadIndex, group.groupId);
      if (!meshes[index]) return;
      groups.push({ wmoGroupId: group.groupId, exterior, ...bounds });
      wmoNode.addChild(document.createNode(`group-${group.index}`)
        .setMesh(meshes[index])
        .setExtras({ kind: 'wmoGroup', wmoGroupId: group.groupId, exterior, minZ: bounds.minZ, maxZ: bounds.maxZ }));
    });

    for (const doodadIndex of selectDoodadIndices(wmo.sets, placement.doodadSet)) {
      const definition = wmo.definitions[doodadIndex];
      const mesh = definition && builder.m2Mesh(definition.name);
      if (!mesh) continue;
      wmoNode.addChild(document.createNode(`doodad-${doodadIndex}`)
        .setMesh(mesh)
        .setTranslation(definition.position)
        .setRotation(definition.rotation)
        .setScale([definition.scale, definition.scale, definition.scale])
        .setExtras({ kind: 'doodad', wmoGroupId: doodadGroups.get(doodadIndex) ?? null }));
      doodadCount += 1;
    }
  }

  for (const placement of doodadPlacements) {
    const mesh = builder.m2Mesh(placement.name);
    if (!mesh) continue;
    root.addChild(document.createNode(`doodad-${placement.uniqueId}`)
      .setMesh(mesh)
      .setTranslation(placement.position)
      .setRotation(placement.rotation)
      .setScale([placement.scale, placement.scale, placement.scale])
      .setExtras({ kind: 'doodad', wmoGroupId: null }));
    doodadCount += 1;
  }

  if (!groups.length && !doodadCount) throw new Error(`${internalName} produced no drawable geometry.`);

  const file = `${mapId}.glb`;
  const glb = await new NodeIO().writeBinary(document);
  fs.writeFileSync(path.join(outputDir, file), glb);

  // Scenes with only loose doodads have no group bounds; pad their positions.
  const boundsSources = groups.length ? groups : doodadPlacements.map(({ position: [x, y, z] }) => ({
    minX: x - 50, maxX: x + 50, minY: y - 50, maxY: y + 50, minZ: z - 50, maxZ: z + 50,
  }));
  const bounds = boundsSources.reduce((total, group) => ({
    minX: Math.min(total.minX, group.minX), maxX: Math.max(total.maxX, group.maxX),
    minY: Math.min(total.minY, group.minY), maxY: Math.max(total.maxY, group.maxY),
    minZ: Math.min(total.minZ, group.minZ), maxZ: Math.max(total.maxZ, group.maxZ),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });

  return {
    scene: {
      file,
      bounds,
      groups: groups.map(({ wmoGroupId, exterior, minZ, maxZ }) => ({ wmoGroupId, exterior, minZ, maxZ })),
      floors: computeFloorHeights(floors, groups),
    },
    stats: {
      bytes: glb.byteLength,
      wmoCount: wmoPlacements.length,
      groupCount: groups.length,
      doodadCount,
      modelCount: [...builder.models.values()].filter(Boolean).length,
      textureCount: [...builder.textures.values()].filter(Boolean).length,
      missing: [...builder.missing],
      skippedWmos,
    },
  };
}
