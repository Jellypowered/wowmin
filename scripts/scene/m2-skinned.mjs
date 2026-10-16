// Loads an M2 model with its skeleton and the animations wowmin plays (stand,
// move, fight, cast, die), for players and creatures in the instance view.
// Everything stays in M2 model space: Z up, facing +X, as server orientation 0.

import { M2Model, M2SkinProfile } from '@wowserhq/format';

import { asBytes } from './chunks.mjs';
import { expandSkinVertices, M2_VERTEX_SIZE, skinFileName, staticBatchColor } from './m2.mjs';

const M2_NO_LOOP = 0xFFFF;
// Set on sequences whose keyframes are inside the .m2 rather than a .anim file.
const M2_SEQUENCE_FLAG_INLINE = 0x20;
// Set on sequences that only point at another (aliasNext) for their keys.
const M2_SEQUENCE_FLAG_ALIAS = 0x40;
// Where a bone's tracks sit in the .m2, for reading a .anim file's keys: the
// bone array's M2Array in the header, each bone's size, and each track's
// offset in it. A track's times and keys are M2Arrays of per-sequence
// M2Arrays (count, offset); an external sequence's offsets point into its
// .anim file.
const M2_BONES_OFFSET = 0x2c;
const M2_BONE_SIZE = 88;
const M2_BONE_TRACKS = { translationTrack: 16, rotationTrack: 36, scaleTrack: 56 };
const M2_TRACK_TIMES = 4;
const M2_TRACK_KEYS = 12;
const M2_TRACK_INTERPOLATION_NONE = 0;
// The header's events, each 36 bytes: four-letter ID, data, bone, unused,
// position, then its track: interpolation, global sequence, and per
// sequence the times it fires.
const M2_EVENTS_OFFSET = 256;
const M2_EVENT_SIZE = 36;
const M2_EVENT_TRACK = 24;
// The events a spell's missile is released at: left hand, right hand, a
// thrown weapon, a bow or gun.
const RELEASE_EVENTS = new Set(['$CSL', '$CSR', '$CST', '$BWR']);

// When in a sequence (ms) the model first releases a spell's missile, or
// null if it never does. An external sequence's times are in its .anim
// file (`animBytes`).
export function releaseTimeMs(modelBytes, animBytes, sequenceIndex) {
  const model = new DataView(modelBytes.buffer, modelBytes.byteOffset, modelBytes.byteLength);
  if (model.byteLength < M2_EVENTS_OFFSET + 8) return null;
  const count = model.getUint32(M2_EVENTS_OFFSET, true);
  const offset = model.getUint32(M2_EVENTS_OFFSET + 4, true);
  if (offset + count * M2_EVENT_SIZE > model.byteLength) return null;
  const source = animBytes ? new DataView(animBytes.buffer, animBytes.byteOffset, animBytes.byteLength) : model;
  let first = null;
  for (let index = 0; index < count; index += 1) {
    const base = offset + index * M2_EVENT_SIZE;
    const name = String.fromCharCode(...modelBytes.subarray(base, base + 4));
    if (!RELEASE_EVENTS.has(name)) continue;
    const track = base + M2_EVENT_TRACK;
    if (model.getInt16(track + 2, true) !== -1) continue;
    const sequences = model.getUint32(track + 4, true);
    if (sequenceIndex >= sequences) continue;
    const entry = model.getUint32(track + 8, true) + sequenceIndex * 8;
    if (entry + 8 > model.byteLength) continue;
    const times = model.getUint32(entry, true);
    const at = model.getUint32(entry + 4, true);
    if (!times || at + 4 > source.byteLength) continue;
    const time = source.getUint32(at, true);
    if (first === null || time < first) first = time;
  }
  return first;
}

// AnimationData.dbc IDs of the animations exported, by the name the renderer
// asks for.
export const UNIT_ANIMATIONS = {
  Stand: 0,
  Death: 1,
  Walk: 4,
  Run: 5,
  Dead: 6,
  AttackUnarmed: 16,
  Attack1H: 17,
  Attack2H: 18,
  Attack2HL: 19,
  ReadyUnarmed: 25,
  Ready1H: 26,
  Ready2H: 27,
  Ready2HL: 28,
  ReadyBow: 29,
  AttackBow: 46,
  ReadyRifle: 48,
  AttackRifle: 49,
  ReadySpellDirected: 51,
  ReadySpellOmni: 52,
  SpellCastDirected: 53,
  SpellCastOmni: 54,
  // Named by spell visual kits: hit reactions, channelling, and other casts.
  CombatWound: 9,
  CombatCritical: 10,
  Stun: 14,
  SpellCast: 32,
  BattleRoar: 55,
  Special1H: 57,
  AttackThrown: 107,
  ReadyThrown: 108,
  SpecialUnarmed: 118,
  UseStandingLoop: 123,
  ChannelCastDirected: 124,
  ChannelCastOmni: 125,
  // A rider's seated pose.
  Mount: 91,
  // A flying mount in the air: moving, and staying in place.
  Fly: 135,
  Hover: 193,
  // Sitting on the ground (eating, drinking, resting): sitting down, seated,
  // and getting up.
  SitGroundDown: 96,
  SitGround: 97,
  SitGroundUp: 98,
};

// M2 stores rotations as signed 16-bit quaternion components.
export function decompressQuaternionComponent(value) {
  return (value < 0 ? value + 32768 : value - 32767) / 32767;
}

export function decompressQuaternions(values) {
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 4) {
    let length = 0;
    for (let axis = 0; axis < 4; axis += 1) {
      result[index + axis] = decompressQuaternionComponent(values[index + axis]);
      length += result[index + axis] ** 2;
    }
    length = Math.sqrt(length) || 1;
    for (let axis = 0; axis < 4; axis += 1) result[index + axis] /= length;
  }
  return result;
}

// Positions, normals, UVs, and up to four bone influences per vertex, with
// weights normalised to sum to 1.
export function expandSkinnedVertices(modelVertices, skinVertexLookup) {
  const { positions, normals, uvs } = expandSkinVertices(modelVertices, skinVertexLookup);
  const view = new DataView(modelVertices);
  const count = skinVertexLookup.length;
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let index = 0; index < count; index += 1) {
    const base = skinVertexLookup[index] * M2_VERTEX_SIZE;
    let total = 0;
    for (let influence = 0; influence < 4; influence += 1) total += view.getUint8(base + 12 + influence);
    for (let influence = 0; influence < 4; influence += 1) {
      const weight = view.getUint8(base + 12 + influence);
      joints[index * 4 + influence] = weight ? view.getUint8(base + 16 + influence) : 0;
      weights[index * 4 + influence] = total ? weight / total : influence === 0 ? 1 : 0;
    }
  }
  return { positions, normals, uvs, joints, weights };
}

// The sequence index for each wanted animation: variation 0, keyframes inline.
// The first variation of each wanted animation. Sequences kept in .anim
// files are left out unless `external` (their entries are then marked).
export function selectSequences(sequences, wanted = UNIT_ANIMATIONS, { external = false } = {}) {
  const selected = [];
  for (const [name, id] of Object.entries(wanted)) {
    const index = sequences.findIndex((sequence) => sequence.id === id && sequence.variationIndex === 0);
    if (index < 0 || sequences[index].flags & M2_SEQUENCE_FLAG_ALIAS) continue;
    const inline = Boolean(sequences[index].flags & M2_SEQUENCE_FLAG_INLINE);
    if (!inline && !external) continue;
    selected.push({
      name, id, index, duration: sequences[index].duration, moveSpeed: sequences[index].moveSpeed, ...(inline ? {} : { external: true }),
    });
  }
  return selected;
}

// The file an external sequence's keys are in: <model><id>-<variation>.anim.
export function animFileName(modelName, sequence) {
  return `${modelName.replace(/\.m2$/i, '')}${String(sequence.id).padStart(4, '0')}-${String(sequence.variationIndex).padStart(2, '0')}.anim`;
}

// One bone track's keys for a sequence kept in a .anim file, read through
// the track's header in the .m2. Global-sequence tracks keep their keys in
// the .m2, as for any sequence.
export function externalTrackKeys(modelBytes, animBytes, boneIndex, trackName, track, sequenceIndex) {
  if (track.loopIndex !== M2_NO_LOOP) return trackKeys(track, sequenceIndex);
  const model = new DataView(modelBytes.buffer, modelBytes.byteOffset, modelBytes.byteLength);
  const anim = new DataView(animBytes.buffer, animBytes.byteOffset, animBytes.byteLength);
  const header = model.getUint32(M2_BONES_OFFSET + 4, true) + boneIndex * M2_BONE_SIZE + M2_BONE_TRACKS[trackName];
  const entry = (field) => {
    if (sequenceIndex >= model.getUint32(header + field, true)) return null;
    const at = model.getUint32(header + field + 4, true) + sequenceIndex * 8;
    return { count: model.getUint32(at, true), offset: model.getUint32(at + 4, true) };
  };
  const times = entry(M2_TRACK_TIMES);
  const keys = entry(M2_TRACK_KEYS);
  if (!times?.count || !keys?.count) return null;
  const rotation = trackName === 'rotationTrack';
  const width = rotation ? 4 : 3;
  const keyBytes = rotation ? 2 : 4;
  if (times.offset + times.count * 4 > anim.byteLength || keys.offset + keys.count * width * keyBytes > anim.byteLength) return null;
  const timeValues = new Uint32Array(times.count);
  for (let index = 0; index < times.count; index += 1) timeValues[index] = anim.getUint32(times.offset + index * 4, true);
  const values = rotation ? new Int16Array(keys.count * width) : new Float32Array(keys.count * width);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = rotation ? anim.getInt16(keys.offset + index * 2, true) : anim.getFloat32(keys.offset + index * 4, true);
  }
  return { times: timeValues, values, step: track.trackType === M2_TRACK_INTERPOLATION_NONE };
}

function trackKeys(track, sequenceIndex) {
  // Tracks on a global sequence loop independently of the animation; they
  // are held at their first key instead.
  const index = track.loopIndex === M2_NO_LOOP ? sequenceIndex : 0;
  const times = track.sequenceTimes[index];
  const values = track.sequenceKeys[index];
  if (!times?.length || !values?.length) return null;
  if (track.loopIndex !== M2_NO_LOOP) {
    const width = values.length / times.length;
    return { times: Uint32Array.of(0), values: values.slice(0, width), step: true };
  }
  return { times, values, step: track.trackType === M2_TRACK_INTERPOLATION_NONE };
}

// Keyframes for one bone in one sequence, as glTF node channels: translation
// is offset from the parent's pivot so the bone turns about its own pivot.
export function boneChannels(bone, parentPivot, sequenceIndex) {
  return boneChannelsFrom(bone, parentPivot, (track) => trackKeys(track, sequenceIndex));
}

// The same, with `pick(track)` choosing each track's keys ({ times, values,
// step }, or null for none).
export function boneChannelsFrom(bone, parentPivot, pick) {
  const offset = [0, 1, 2].map((axis) => bone.pivot[axis] - (parentPivot?.[axis] ?? 0));
  const channels = {};
  const keys = (track) => {
    const picked = pick(track);
    return picked?.times.length && picked.values.length ? picked : null;
  };
  const translation = keys(bone.translationTrack);
  if (translation) {
    const values = new Float32Array(translation.values.length);
    for (let index = 0; index < values.length; index += 1) values[index] = translation.values[index] + offset[index % 3];
    channels.translation = { times: translation.times, values, step: translation.step };
  }
  const rotation = keys(bone.rotationTrack);
  if (rotation) channels.rotation = { times: rotation.times, values: decompressQuaternions(rotation.values), step: rotation.step };
  const scale = keys(bone.scaleTrack);
  if (scale) channels.scale = { times: scale.times, values: Float32Array.from(scale.values), step: scale.step };
  return channels;
}

// Loads the model, its first skin profile, the bones, and the wanted
// animations. `showSection(id)` picks geosets (all when omitted).
const clipInfo = ({ name, duration, moveSpeed }) => ({ name, duration, moveSpeed });

export function loadSkinnedM2(modelName, readFile, { showSection = () => true, animations = UNIT_ANIMATIONS } = {}) {
  const modelBuffer = readFile(modelName);
  const skinBuffer = modelBuffer ? readFile(skinFileName(modelName)) : null;
  if (!modelBuffer || !skinBuffer) return null;
  const model = new M2Model().load(asBytes(modelBuffer));
  const skin = new M2SkinProfile(model).load(asBytes(skinBuffer));
  if (!skin.indices.length) return null;

  const bones = model.bones.map((bone) => ({
    parentIndex: bone.parentIndex,
    pivot: Array.from(bone.pivot),
  }));
  const modelBytes = asBytes(modelBuffer);
  // Most of a character's animations (sitting among them) are in .anim
  // files; a sequence whose file is missing is left out.
  const clips = selectSequences(model.sequences, animations, { external: true }).flatMap((sequence) => {
    const parentPivot = (bone) => model.bones[bone.parentIndex]?.pivot;
    if (!sequence.external) {
      return [{
        ...clipInfo(sequence), releaseMs: releaseTimeMs(modelBytes, null, sequence.index),
        bones: model.bones.map((bone) => boneChannels(bone, parentPivot(bone), sequence.index)),
      }];
    }
    const animBuffer = readFile(animFileName(modelName, model.sequences[sequence.index]));
    if (!animBuffer) return [];
    const animBytes = asBytes(animBuffer);
    return [{
      ...clipInfo(sequence),
      releaseMs: releaseTimeMs(modelBytes, animBytes, sequence.index),
      bones: model.bones.map((bone, boneIndex) => boneChannelsFrom(bone, parentPivot(bone), (track) => {
        const trackName = Object.keys(M2_BONE_TRACKS).find((name) => bone[name] === track);
        return externalTrackKeys(modelBytes, animBytes, boneIndex, trackName, track, sequence.index);
      })),
    }];
  });

  return {
    ...expandSkinnedVertices(model.vertices, skin.vertices),
    indices: skin.indices,
    bones,
    clips,
    textures: model.textures.map((texture) => ({ type: texture.component, filename: texture.filename, flags: texture.flags })),
    batches: skin.batches.flatMap((batch) => {
      if (!showSection(batch.skinSection.id)) return [];
      const textureIndex = model.textures.indexOf(batch.textures[0]);
      return [{
        ...staticBatchColor(model, batch.colorIndex, batch.textureWeightIndex),
        section: batch.skinSection.id,
        indexStart: batch.skinSection.indexStart + (batch.skinSection.level << 16),
        indexCount: batch.skinSection.indexCount,
        blend: batch.material.blend,
        materialFlags: batch.material.flags,
        textureIndex,
      }];
    }),
    sectionIds: [...new Set(skin.batches.map((batch) => batch.skinSection.id))],
  };
}
