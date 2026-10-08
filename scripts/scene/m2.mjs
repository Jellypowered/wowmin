// Loads an M2 model (props, doors, game objects) in its static bind pose from
// the model file and its first .skin profile.

import { M2Model, M2SkinProfile } from '@wowserhq/format';

export const M2_MATERIAL_FLAG_TWO_SIDED = 0x4;
export const M2_TEXTURE_FLAG_WRAP_S = 0x1;
export const M2_TEXTURE_FLAG_WRAP_T = 0x2;

const M2_VERTEX_SIZE = 48;
const M2_TEXTURE_COMPONENT_HARDCODED = 0;
const M2_NO_INDEX = 0xFFFF;
const M2_FIXED16_ONE = 0x7FFF;

// Static pose: the first keyframe of the first animation that has one.
export function firstTrackValue(track) {
  const keys = track?.sequenceKeys?.find((sequence) => sequence?.length);
  return keys ?? null;
}

// Light cards, glows, and fades get their transparency from colour and
// texture-weight tracks rather than the texture, so fold those in.
export function staticBatchColor(model, colorIndex, textureWeightIndex) {
  const color = colorIndex === M2_NO_INDEX ? null : model.colors[colorIndex];
  const rgb = firstTrackValue(color?.colorTrack);
  const alpha = firstTrackValue(color?.alphaTrack);
  const weight = textureWeightIndex === undefined || textureWeightIndex === M2_NO_INDEX
    ? null
    : firstTrackValue(model.textureWeights[textureWeightIndex]?.weightTrack);
  const opacity = (alpha ? alpha[0] / M2_FIXED16_ONE : 1) * (weight ? weight[0] / M2_FIXED16_ONE : 1);
  return {
    tint: rgb ? [rgb[0], rgb[1], rgb[2]] : [1, 1, 1],
    opacity: Math.min(1, Math.max(0, opacity)),
  };
}

const asBytes = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

export function skinFileName(modelName) {
  return modelName.replace(/\.m2$/i, '00.skin');
}

// Expands the skin's vertex lookup into standalone vertex arrays so triangle
// indices address the output directly.
export function expandSkinVertices(modelVertices, skinVertexLookup) {
  const view = new DataView(modelVertices);
  const count = skinVertexLookup.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    const base = skinVertexLookup[index] * M2_VERTEX_SIZE;
    for (let axis = 0; axis < 3; axis += 1) {
      positions[index * 3 + axis] = view.getFloat32(base + axis * 4, true);
      normals[index * 3 + axis] = view.getFloat32(base + 20 + axis * 4, true);
    }
    uvs[index * 2] = view.getFloat32(base + 32, true);
    uvs[index * 2 + 1] = view.getFloat32(base + 36, true);
  }
  return { positions, normals, uvs };
}

export function loadM2(modelName, readFile) {
  const modelBuffer = readFile(modelName);
  const skinBuffer = modelBuffer ? readFile(skinFileName(modelName)) : null;
  if (!modelBuffer || !skinBuffer) return null;

  const model = new M2Model().load(asBytes(modelBuffer));
  const skin = new M2SkinProfile(model).load(asBytes(skinBuffer));
  if (!skin.indices.length) return null;

  return {
    ...expandSkinVertices(model.vertices, skin.vertices),
    indices: skin.indices,
    batches: skin.batches.map((batch) => {
      const texture = batch.textures[0];
      return {
        ...staticBatchColor(model, batch.colorIndex, batch.textureWeightIndex),
        // WotLK stores index starts above 65535 in the section's level field.
        indexStart: batch.skinSection.indexStart + (batch.skinSection.level << 16),
        indexCount: batch.skinSection.indexCount,
        blend: batch.material.blend,
        materialFlags: batch.material.flags,
        texture: texture?.component === M2_TEXTURE_COMPONENT_HARDCODED && texture.filename ? texture.filename : null,
        textureFlags: texture?.flags ?? 0,
      };
    }),
  };
}
