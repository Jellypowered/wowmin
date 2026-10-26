// Loads an M2 model (props, doors, game objects) in its static bind pose from
// the model file and its first .skin profile.

import { M2Model, M2SkinProfile } from '@wowserhq/format';

import { asBytes } from './chunks.mjs';

export const M2_MATERIAL_FLAG_TWO_SIDED = 0x4;
export const M2_TEXTURE_FLAG_WRAP_S = 0x1;
export const M2_TEXTURE_FLAG_WRAP_T = 0x2;

export const M2_VERTEX_SIZE = 48;
// How an M2 batch blends, by its material's blend mode.
export const M2_BLEND = ['opaque', 'alphaKey', 'alpha', 'add', 'add', 'mod', 'mod2x'];
export const IDENTITY_ROTATION = [0, 0, 0, 1];
const M2_TEXTURE_COMPONENT_HARDCODED = 0;
const M2_NO_INDEX = 0xFFFF;
const M2_FIXED16_ONE = 0x7FFF;
// The header's events (sounds, footsteps, a spell's release), each 36 bytes:
// four-letter ID, data, bone, unused, position, then its track:
// interpolation, global sequence, and per sequence the times it fires.
const M2_EVENTS_OFFSET = 256;
const M2_EVENT_SIZE = 36;
export const M2_EVENT_BONE = 8;
export const M2_EVENT_POSITION = 12;
export const M2_EVENT_TRACK = 24;
// The events a spell's missile is released at: $CSL, $CSR, $CST (left hand,
// right hand, a thrown weapon) and $BWR (a bow or gun).
export const RELEASE_EVENTS = ['$CSL', '$CSR', '$CST', '$BWR'];

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

// Where the model's events with these IDs sit in the file: { name, base },
// in header order; none if the event array runs past the file. Not exposed
// by @wowserhq/format, so read from the header directly.
export function findM2Events(bytes, names) {
  if (!bytes || bytes.length < M2_EVENTS_OFFSET + 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(M2_EVENTS_OFFSET, true);
  const offset = view.getUint32(M2_EVENTS_OFFSET + 4, true);
  if (offset + count * M2_EVENT_SIZE > bytes.length) return [];
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const base = offset + index * M2_EVENT_SIZE;
    const name = String.fromCharCode(...bytes.subarray(base, base + 4));
    if (names.includes(name)) events.push({ name, base });
  }
  return events;
}

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
        textureType: texture?.component ?? M2_TEXTURE_COMPONENT_HARDCODED,
        textureFlags: texture?.flags ?? 0,
      };
    }),
  };
}
