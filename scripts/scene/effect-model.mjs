// Builds a GLB for one spell effect model (SpellVisualEffectName): its
// geometry with animated bones, billboards, colours, opacity, and texture
// scrolling, plus its particle emitters and ribbons, which the renderer
// simulates. Everything stays in M2 model space (Z up, facing +X).
//
// Tracks go into glTF extras in one compact form: { g, s, k }, where g is the
// global sequence (loop) index or -1, s is true for stepped keys, and k maps a
// clip name ('Stand', 'Hold', 'Decay', or 'global' for a looping track) to
// [times in ms, flat values].

import path from 'node:path';

import { Document } from '@gltf-transform/core';
import { M2Model, M2SkinProfile } from '@wowserhq/format';

import { asBytes } from './chunks.mjs';
import { IDENTITY_ROTATION, M2_BLEND, M2_MATERIAL_FLAGS_DRAWN, skinFileName } from './m2.mjs';
import { boneChannelsFrom, expandSkinnedVertices, selectSequences } from './m2-skinned.mjs';
import { parseParticleEmitters, parseRibbons } from './m2-effects.mjs';
import { encodeTexture } from './textures.mjs';
import { keyframeTimes, writeGlb } from './unit-model.mjs';

// AnimationData.dbc IDs an effect plays: Stand once (its start); for effects
// that last, then Hold looping (158, the idle) and Decay (159) as they end.
// Without a Hold, a lasting effect loops Stand. A missile loops Fly (144)
// in flight and plays Impact (191) as it lands, where its model has them; a
// lasting area's model plays Birth (127) first, where it has one.
export const EFFECT_SEQUENCES = { Stand: 0, Hold: 158, Decay: 159, Fly: 144, Impact: 191, Birth: 127 };
const M2_NO_LOOP = 0xFFFF;
const M2_NO_INDEX = 0xFFFF;
const M2_TRACK_INTERPOLATION_NONE = 0;
const FIXED16_ONE = 32767;
// Bone flags: spherical billboard, and cylindrical about X, Y, or Z.
const BONE_BILLBOARD_FLAGS = 0x8 | 0x10 | 0x20 | 0x40;
const EFFECT_TEXTURE_MAX = 256;

// A library track ({ trackType, loopIndex, sequenceTimes, sequenceKeys }) in
// the shape m2-effects.mjs reads its own tracks.
export function fromLibraryTrack(track, map = (value) => value) {
  if (!track) return null;
  return {
    interpolation: track.trackType,
    globalSequence: track.loopIndex === M2_NO_LOOP ? -1 : track.loopIndex,
    sequences: track.sequenceTimes.map((times, index) => ({
      times: Array.from(times),
      values: Array.from(track.sequenceKeys[index] ?? [], map),
    })),
  };
}

// The compact export form for a track, keeping only the clips exported (or
// the loop's keys for a global track); null when it has no keys at all. A
// clip past the track's last sequence takes the first sequence's keys, as
// the client reads them; a sequence with no keys stays the default.
export function exportTrack(track, clips) {
  if (!track) return null;
  const keys = {};
  if (track.globalSequence >= 0) {
    const sequence = track.sequences[0];
    if (sequence?.times.length && sequence.values.length) keys.global = [sequence.times, sequence.values];
  } else {
    for (const clip of clips) {
      const sequence = track.sequences[clip.index < track.sequences.length ? clip.index : 0];
      if (sequence?.times.length && sequence.values.length) keys[clip.name] = [sequence.times, sequence.values];
    }
  }
  if (!Object.keys(keys).length) return null;
  return { g: track.globalSequence, s: track.interpolation === M2_TRACK_INTERPOLATION_NONE, k: keys };
}

const fblock = ({ times, values }) => ({ t: times, v: values });

// A particle emitter for the renderer: scalars as read, tracks exported.
export function exportEmitter(emitter, clips) {
  const tracks = ['emissionSpeed', 'speedVariation', 'verticalRange', 'horizontalRange', 'gravity', 'lifespan',
    'emissionRate', 'emissionAreaWidth', 'emissionAreaLength', 'zSource', 'enabled'];
  const exported = { ...emitter };
  for (const name of tracks) exported[name] = exportTrack(emitter[name], clips);
  for (const name of ['color', 'alpha', 'scale', 'headCell', 'tailCell']) exported[name] = fblock(emitter[name]);
  return exported;
}

export function exportRibbon(ribbon, clips) {
  const exported = { ...ribbon };
  for (const name of ['color', 'alpha', 'heightAbove', 'heightBelow', 'textureSlot', 'visibility']) {
    exported[name] = exportTrack(ribbon[name], clips);
  }
  return exported;
}

// A clip's keys for a bone track, falling back to the first sequence's as
// exportTrack does. A track on a loop of no length never leaves its first
// key, so every clip holds that key (Fan of Knives' knife bones are turned
// on their side this way).
const sequenceKeys = (clipIndex, loops) => (track) => {
  if (track.loopIndex !== M2_NO_LOOP) {
    const [times, values] = [track.sequenceTimes[0], track.sequenceKeys[0]];
    return !loops[track.loopIndex] && times?.length && values?.length
      ? { times: Uint32Array.of(0), values: values.slice(0, values.length / times.length), step: true }
      : null;
  }
  const index = clipIndex < track.sequenceTimes.length ? clipIndex : 0;
  return track.sequenceTimes[index]
    ? { times: track.sequenceTimes[index], values: track.sequenceKeys[index], step: track.trackType === M2_TRACK_INTERPOLATION_NONE }
    : null;
};
const loopKeys = (loop) => (track) => (track.loopIndex === loop && track.sequenceTimes[0]
  ? { times: track.sequenceTimes[0], values: track.sequenceKeys[0], step: track.trackType === M2_TRACK_INTERPOLATION_NONE }
  : null);

// Loads an effect model: geometry (if any), bones with their clips and
// loops, batches with their animated material tracks, emitters, and ribbons.
export function loadEffectM2(modelName, readFile) {
  const buffer = readFile(modelName);
  if (!buffer) return null;
  const model = new M2Model().load(asBytes(buffer));
  const skinBuffer = readFile(skinFileName(modelName));
  const skin = skinBuffer ? new M2SkinProfile(model).load(asBytes(skinBuffer)) : null;
  const clips = selectSequences(model.sequences, EFFECT_SEQUENCES);
  const loops = Array.from(model.loops ?? []);
  const usedLoops = new Set();
  for (const bone of model.bones) {
    for (const track of [bone.translationTrack, bone.rotationTrack, bone.scaleTrack]) {
      if (track.loopIndex !== M2_NO_LOOP && loops[track.loopIndex]) usedLoops.add(track.loopIndex);
    }
  }
  const geometry = skin?.indices.length ? expandSkinnedVertices(model.vertices, skin.vertices) : null;
  return {
    name: path.win32.basename(modelName, '.m2'),
    loops,
    clips: clips.map((clip) => ({
      name: clip.name,
      index: clip.index,
      duration: clip.duration,
      bones: model.bones.map((bone) => boneChannelsFrom(bone, model.bones[bone.parentIndex]?.pivot, sequenceKeys(clip.index, loops))),
    })),
    globalClips: [...usedLoops].map((loop) => ({
      name: `global${loop}`,
      loop,
      duration: loops[loop],
      bones: model.bones.map((bone) => boneChannelsFrom(bone, model.bones[bone.parentIndex]?.pivot, loopKeys(loop))),
    })),
    bones: model.bones.map((bone) => ({ parentIndex: bone.parentIndex, pivot: Array.from(bone.pivot), flags: bone.flags })),
    textures: model.textures.map((texture) => ({ type: texture.component, filename: texture.filename, flags: texture.flags })),
    materials: model.materials.map((material) => ({ flags: material.flags, blend: material.blend })),
    geometry: geometry && { ...geometry, indices: skin.indices },
    batches: geometry ? skin.batches.map((batch) => {
      const color = batch.colorIndex === M2_NO_INDEX ? null : model.colors[batch.colorIndex];
      const weight = batch.textureWeightIndex === undefined || batch.textureWeightIndex === M2_NO_INDEX
        ? null : model.textureWeights[batch.textureWeightIndex];
      const transform = batch.textureTransformIndices?.length ? model.textureTransforms[batch.textureTransformIndices[0]] : null;
      return {
        indexStart: batch.skinSection.indexStart + (batch.skinSection.level << 16),
        indexCount: batch.skinSection.indexCount,
        blend: batch.material.blend,
        materialFlags: batch.material.flags,
        textureIndex: model.textures.indexOf(batch.textures[0]),
        color: fromLibraryTrack(color?.colorTrack),
        alpha: fromLibraryTrack(color?.alphaTrack, (value) => value / FIXED16_ONE),
        weight: fromLibraryTrack(weight?.weightTrack, (value) => value / FIXED16_ONE),
        uvTranslation: fromLibraryTrack(transform?.translationTrack),
        uvRotation: fromLibraryTrack(transform?.rotationTrack),
        uvScaling: fromLibraryTrack(transform?.scalingTrack),
      };
    }) : [],
    emitters: parseParticleEmitters(buffer),
    ribbons: parseRibbons(buffer),
  };
}

// Channels any sequence clip animates, minus those a loop drives, so the two
// never fight over a bone.
function sequenceChannels(effect) {
  const owned = effect.bones.map(() => new Set());
  for (const clip of effect.globalClips) clip.bones.forEach((channels, bone) => Object.keys(channels).forEach((key) => owned[bone].add(key)));
  const paths = effect.bones.map(() => new Set());
  for (const clip of effect.clips) {
    clip.bones.forEach((channels, bone) => {
      for (const key of Object.keys(channels)) if (!owned[bone].has(key)) paths[bone].add(key);
    });
  }
  return paths;
}

// The GLB's document for an effect, with the models its particles are drawn
// as (each emitter's particleModel, an index into `particleModels`): each
// such model a root of its own beside the effect's, its node, texture, and
// clip names prefixed `p<index>:`.
export function buildEffectDocument(effect, { name, textureFor, textureMax = EFFECT_TEXTURE_MAX, particleModels = [] }) {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene(name);
  scene.addChild(addEffectTree(document, buffer, effect, { name, textureFor, textureMax, prefix: '' }));
  particleModels.forEach((model, index) => {
    const root = addEffectTree(document, buffer, model.effect, { name: model.effect.name, textureFor: model.textureFor, textureMax, prefix: `p${index}:` });
    root.setExtras({ ...root.getExtras(), wowParticleModel: index });
    scene.addChild(root);
  });
  return document;
}

function addEffectTree(document, buffer, effect, { name, textureFor, textureMax, prefix }) {
  const accessor = (type, array) => document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const root = document.createNode(`${prefix}${name}`);

  const joints = effect.bones.map((bone, index) => {
    const parent = effect.bones[bone.parentIndex];
    const joint = document.createNode(`${prefix}bone${index}`)
      .setTranslation(bone.pivot.map((value, axis) => value - (parent?.pivot[axis] ?? 0)));
    if (bone.flags & BONE_BILLBOARD_FLAGS) joint.setExtras({ wowBillboard: bone.flags & BONE_BILLBOARD_FLAGS });
    return joint;
  });
  effect.bones.forEach((bone, index) => (joints[bone.parentIndex] ?? root).addChild(joints[index]));

  // Every texture once, as a material named after its index, so emitters and
  // ribbons (which name textures by index) can find it.
  const images = new Map();
  const textureMaterials = effect.textures.map((texture, index) => {
    const source = textureFor(index);
    if (!source) return null;
    let image = images.get(source.name.toLowerCase());
    if (image === undefined) {
      try {
        const encoded = encodeTexture(source.blp, textureMax);
        image = document.createTexture(source.name).setImage(encoded.data).setMimeType(encoded.mimeType);
      } catch (error) {
        console.warn(`Could not decode ${source.name}: ${error instanceof Error ? error.message : error}`);
        image = null;
      }
      images.set(source.name.toLowerCase(), image);
    }
    if (!image) return null;
    const material = document.createMaterial(`${prefix}texture${index}`).setBaseColorTexture(image).setAlphaMode('BLEND');
    return material.getName();
  });

  if (effect.geometry && effect.batches.length) {
    const { positions, normals, uvs, joints: jointIndices, weights, indices } = effect.geometry;
    const inverseBind = new Float32Array(effect.bones.length * 16);
    effect.bones.forEach((bone, index) => {
      inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.pivot[0], -bone.pivot[1], -bone.pivot[2], 1], index * 16);
    });
    const skin = document.createSkin(name).setInverseBindMatrices(accessor('MAT4', inverseBind));
    for (const joint of joints) skin.addJoint(joint);
    const position = accessor('VEC3', positions);
    const normal = accessor('VEC3', normals);
    const uv = accessor('VEC2', uvs);
    const jointsAttribute = accessor('VEC4', jointIndices);
    const weightsAttribute = accessor('VEC4', weights);
    const mesh = document.createMesh(`${name}-mesh`);
    effect.batches.forEach((batch, index) => {
      const material = document.createMaterial(`${prefix}${name}#${index}`)
        .setMetallicFactor(0)
        .setRoughnessFactor(1)
        .setDoubleSided(true)
        .setExtras({
          wowBlend: M2_BLEND[batch.blend] ?? 'opaque',
          // The M2 material's blend number, read by the client's table, and
          // the flags that change how it is drawn.
          wowBlendMode: batch.blend,
          wowMaterialFlags: batch.materialFlags & M2_MATERIAL_FLAGS_DRAWN,
          wowTexture: textureMaterials[batch.textureIndex] ?? null,
          wowColor: exportTrack(batch.color, effect.clips),
          wowAlpha: exportTrack(batch.alpha, effect.clips),
          wowWeight: exportTrack(batch.weight, effect.clips),
          wowUvTranslation: exportTrack(batch.uvTranslation, effect.clips),
          wowUvRotation: exportTrack(batch.uvRotation, effect.clips),
          wowUvScaling: exportTrack(batch.uvScaling, effect.clips),
        });
      const slice = indices.subarray(batch.indexStart, batch.indexStart + batch.indexCount);
      mesh.addPrimitive(document.createPrimitive()
        .setAttribute('POSITION', position)
        .setAttribute('NORMAL', normal)
        .setAttribute('TEXCOORD_0', uv)
        .setAttribute('JOINTS_0', jointsAttribute)
        .setAttribute('WEIGHTS_0', weightsAttribute)
        .setIndices(accessor('SCALAR', Uint16Array.from(slice)))
        .setMaterial(material));
    });
    root.addChild(document.createNode(`${prefix}${name}-mesh`).setMesh(mesh).setSkin(skin));
  }

  const channels = sequenceChannels(effect);
  const writeClip = (clip, paths) => {
    const animation = document.createAnimation(`${prefix}${clip.name}`);
    paths.forEach((targets, boneIndex) => {
      const bone = effect.bones[boneIndex];
      const parent = effect.bones[bone.parentIndex];
      const rest = {
        translation: bone.pivot.map((value, axis) => value - (parent?.pivot[axis] ?? 0)),
        rotation: IDENTITY_ROTATION,
        scale: [1, 1, 1],
      };
      for (const targetPath of targets) {
        const keys = clip.bones[boneIndex][targetPath];
        const width = targetPath === 'rotation' ? 4 : 3;
        const { input, output } = keys
          ? keyframeTimes(keys.times, keys.values, width)
          : { input: Float32Array.of(0), output: Float32Array.from(rest[targetPath]) };
        const sampler = document.createAnimationSampler()
          .setInput(accessor('SCALAR', input))
          .setOutput(accessor(width === 4 ? 'VEC4' : 'VEC3', output))
          .setInterpolation(keys?.step ? 'STEP' : 'LINEAR');
        animation.addSampler(sampler).addChannel(document.createAnimationChannel()
          .setTargetNode(joints[boneIndex]).setTargetPath(targetPath).setSampler(sampler));
      }
    });
    if (!animation.listChannels().length) animation.dispose();
  };
  for (const clip of effect.clips) writeClip(clip, channels);
  for (const clip of effect.globalClips) writeClip(clip, clip.bones.map((bone) => new Set(Object.keys(bone))));

  const textureOf = (index) => textureMaterials[index] ?? null;
  root.setExtras({
    wowEffect: {
      loops: effect.loops,
      clips: Object.fromEntries(effect.clips.map((clip) => [clip.name, clip.duration])),
      globalClips: Object.fromEntries(effect.globalClips.map((clip) => [clip.name, clip.duration])),
      emitters: effect.emitters.map((emitter) => ({
        ...exportEmitter(emitter, effect.clips),
        textureMaterial: textureOf(emitter.texture),
        bonePivot: effect.bones[emitter.bone]?.pivot ?? [0, 0, 0],
      })),
      ribbons: effect.ribbons.map((ribbon) => ({
        ...exportRibbon(ribbon, effect.clips),
        textureMaterial: textureOf(ribbon.textures[0]),
        blend: effect.materials[ribbon.materials[0]]?.blend ?? 0,
        // Each texture with its material is a pass of its own.
        passes: ribbon.textures.map((texture, index) => ({
          textureMaterial: textureOf(texture),
          blend: effect.materials[ribbon.materials[index] ?? ribbon.materials[0]]?.blend ?? 0,
        })),
        bonePivot: effect.bones[ribbon.bone]?.pivot ?? [0, 0, 0],
      })),
    },
  });
  return root;
}

const texturesOf = (effect, readFile) => (index) => {
  const texture = effect.textures[index];
  const blp = texture?.filename ? readFile(texture.filename) : null;
  return blp ? { name: path.win32.basename(texture.filename), blp } : null;
};

// The GLB for an effect model file, or null if the file is missing. Emitters
// whose particles are models, or that have child emitters (a model whose
// emitters let particles go from each of theirs), get those models
// alongside (one level deep, as the client has them), and their index as
// particleModel or childEmitters.
export async function buildEffectGlb(readFile, modelName) {
  const effect = loadEffectM2(modelName, readFile);
  if (!effect) return null;
  const particleModels = [];
  const indexOf = new Map();
  const modelIndex = (filename) => {
    const file = filename.replace(/\.md[xl]$/i, '.m2');
    const key = file.toLowerCase();
    if (!indexOf.has(key)) {
      const model = loadEffectM2(file, readFile);
      indexOf.set(key, model ? particleModels.push({ effect: model, textureFor: texturesOf(model, readFile) }) - 1 : null);
    }
    return indexOf.get(key);
  };
  for (const emitter of effect.emitters) {
    const model = emitter.modelFilename ? modelIndex(emitter.modelFilename) : null;
    if (model !== null) emitter.particleModel = model;
    const children = emitter.childEmittersFilename ? modelIndex(emitter.childEmittersFilename) : null;
    if (children !== null) emitter.childEmitters = children;
  }
  return writeGlb(buildEffectDocument(effect, { name: effect.name, textureFor: texturesOf(effect, readFile), particleModels }));
}
