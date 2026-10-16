// Builds an animated GLB for one unit look: a creature display, or a
// character with its gear. The model stays in M2 space (Z up, facing +X) with
// the display's scale on the root node; the renderer places it in the world.

import path from 'node:path';

import { Document, NodeIO, TextureInfo } from '@gltf-transform/core';

import { IDENTITY_ROTATION, M2_BLEND, M2_MATERIAL_FLAG_TWO_SIDED, M2_TEXTURE_FLAG_WRAP_S, M2_TEXTURE_FLAG_WRAP_T } from './m2.mjs';
import { loadSkinnedM2 } from './m2-skinned.mjs';
import {
  CharacterData, creatureWeaponAttachments, loadCharacter, readM2Attachments, readM2Events, SLOT, VISIBLE_SLOTS,
} from './character.mjs';
import { encodeTexture } from './textures.mjs';
import { readDbc } from './dbc.mjs';

const TEXTURE_TYPE_HARDCODED = 0;
const TEXTURE_TYPE_MONSTER_1 = 11;
// Points spell effects are drawn at: every attachment the skeleton has, by
// M2 attachment ID (the renderer picks the client's for each kit slot and
// missile), and the events a spell is released at: $CSL, $CSR, $CST (left
// hand, right hand, a thrown weapon) and $BWR (a bow or gun).
export const RELEASE_EVENTS = ['$CSL', '$CSR', '$CST', '$BWR'];

// The effect points of a skeleton's attachments and release events, the
// first of each ID only.
export function effectPoints(skeletonAttachments, skeletonEvents = []) {
  const attachments = new Map();
  for (const { id, bone, position } of skeletonAttachments) if (!attachments.has(id)) attachments.set(id, { attachment: id, bone, position });
  const events = new Map();
  for (const { name, bone, position } of skeletonEvents) if (!events.has(name)) events.set(name, { event: name, bone, position });
  return [...attachments.values(), ...events.values()];
}

// A model file's effect points.
function modelEffectPoints(buffer) {
  return effectPoints(readM2Attachments(buffer), readM2Events(buffer, RELEASE_EVENTS));
}

// Strictly increasing key times in seconds, dropping repeated times.
export function keyframeTimes(times, values, width) {
  const keptTimes = [];
  const keptValues = [];
  for (let index = 0; index < times.length; index += 1) {
    if (index && times[index] <= times[index - 1]) continue;
    keptTimes.push(times[index] / 1000);
    for (let axis = 0; axis < width; axis += 1) keptValues.push(values[index * width + axis]);
  }
  return { input: Float32Array.from(keptTimes), output: Float32Array.from(keptValues) };
}

// Which channels each bone needs: any a clip animates, so every clip sets
// them and switching clips never leaves a bone where the last one put it.
function animatedChannels(clips, boneCount) {
  const paths = Array.from({ length: boneCount }, () => new Set());
  for (const clip of clips) {
    clip.bones.forEach((channels, bone) => {
      for (const key of Object.keys(channels)) paths[bone].add(key);
    });
  }
  return paths;
}

// `alpha` (0 to 1) is how opaque the display draws the model (a
// Shadowfiend is half see-through); it goes on the root for the renderer.
export function buildUnitDocument(model, { name, textureFor, scale = 1, alpha = 1, textureMax = 256, attachments = [], points = [] }) {
  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (type, array, normalized = false) =>
    document.createAccessor().setType(type).setArray(array).setNormalized(normalized).setBuffer(buffer);
  const root = document.createNode(name).setScale([scale, scale, scale]);
  document.createScene(name).addChild(root);

  // Skeleton: one node per bone, translated from its parent's pivot.
  const joints = model.bones.map((bone, index) => {
    const parent = model.bones[bone.parentIndex];
    return document.createNode(`bone${index}`)
      .setTranslation(bone.pivot.map((value, axis) => value - (parent?.pivot[axis] ?? 0)));
  });
  model.bones.forEach((bone, index) => (joints[bone.parentIndex] ?? root).addChild(joints[index]));
  const inverseBind = new Float32Array(model.bones.length * 16);
  model.bones.forEach((bone, index) => {
    inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.pivot[0], -bone.pivot[1], -bone.pivot[2], 1], index * 16);
  });
  const skin = document.createSkin(name).setInverseBindMatrices(accessor('MAT4', inverseBind));
  const topJoint = joints.find((_, index) => !model.bones[model.bones[index].parentIndex]);
  if (topJoint) skin.setSkeleton(topJoint);
  for (const joint of joints) skin.addJoint(joint);

  const textures = new Map();
  const texture = (textureIndex) => {
    if (textures.has(textureIndex)) return textures.get(textureIndex);
    let image = null;
    const source = textureFor(textureIndex);
    if (source) {
      try {
        const encoded = source.encoded ?? encodeTexture(source.blp, textureMax);
        image = document.createTexture(source.name).setImage(encoded.data).setMimeType(encoded.mimeType);
      } catch (error) {
        console.warn(`Could not decode ${source.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    textures.set(textureIndex, image);
    return image;
  };

  const mesh = document.createMesh(name);
  const position = accessor('VEC3', model.positions);
  const normal = accessor('VEC3', model.normals);
  const uv = accessor('VEC2', model.uvs);
  const jointsAttribute = accessor('VEC4', model.joints);
  const weights = accessor('VEC4', model.weights);
  const materials = new Map();
  for (const batch of model.batches) {
    if (batch.opacity <= 0) continue;
    const textureFlags = model.textures[batch.textureIndex]?.flags ?? 0;
    const key = [batch.textureIndex, batch.blend, batch.materialFlags, ...batch.tint, batch.opacity].join('|');
    if (!materials.has(key)) {
      const blend = M2_BLEND[batch.blend] ?? 'opaque';
      const material = document.createMaterial(`${name}#${materials.size}`)
        .setMetallicFactor(0)
        .setRoughnessFactor(1)
        .setBaseColorFactor([...batch.tint, batch.opacity])
        .setDoubleSided(Boolean(batch.materialFlags & M2_MATERIAL_FLAG_TWO_SIDED))
        .setExtras({ wowBlend: blend });
      if (blend === 'alphaKey') material.setAlphaMode('MASK').setAlphaCutoff(0.5);
      else if (blend !== 'opaque' || batch.opacity < 1) material.setAlphaMode('BLEND');
      const image = texture(batch.textureIndex);
      if (image) {
        material.setBaseColorTexture(image);
        material.getBaseColorTextureInfo()
          .setWrapS(textureFlags & M2_TEXTURE_FLAG_WRAP_S ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE)
          .setWrapT(textureFlags & M2_TEXTURE_FLAG_WRAP_T ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE);
      }
      materials.set(key, material);
    }
    const slice = model.indices.subarray(batch.indexStart, batch.indexStart + batch.indexCount);
    mesh.addPrimitive(document.createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('NORMAL', normal)
      .setAttribute('TEXCOORD_0', uv)
      .setAttribute('JOINTS_0', jointsAttribute)
      .setAttribute('WEIGHTS_0', weights)
      .setIndices(accessor('SCALAR', Uint16Array.from(slice)))
      .setMaterial(materials.get(key)));
  }
  root.addChild(document.createNode(`${name}-mesh`).setMesh(mesh).setSkin(skin));

  // Items (helm, shoulders, weapons) ride on their bone, at the attachment
  // point. Named and tagged so the renderer can swap drawn and sheathed.
  const itemTextures = new Map();
  attachments.forEach((attachment, index) => {
    const joint = joints[attachment.bone];
    if (!joint) return;
    const pivot = model.bones[attachment.bone].pivot;
    const itemMesh = document.createMesh(`${name}-item${index}`);
    const itemPosition = accessor('VEC3', attachment.mesh.positions);
    const itemNormal = accessor('VEC3', attachment.mesh.normals);
    const itemUv = accessor('VEC2', attachment.mesh.uvs);
    for (const batch of attachment.mesh.batches) {
      if (batch.opacity <= 0) continue;
      const blend = M2_BLEND[batch.blend] ?? 'opaque';
      const material = document.createMaterial(`${name}-item${index}#${itemMesh.listPrimitives().length}`)
        .setMetallicFactor(0)
        .setRoughnessFactor(1)
        .setBaseColorFactor([...batch.tint, batch.opacity])
        .setDoubleSided(Boolean(batch.materialFlags & M2_MATERIAL_FLAG_TWO_SIDED))
        .setExtras({ wowBlend: blend });
      if (blend === 'alphaKey') material.setAlphaMode('MASK').setAlphaCutoff(0.5);
      else if (blend !== 'opaque' || batch.opacity < 1) material.setAlphaMode('BLEND');
      const source = attachment.textureFor(batch);
      if (source) {
        const key = source.name.toLowerCase();
        if (!itemTextures.has(key)) {
          let image = null;
          try {
            const encoded = encodeTexture(source.blp, textureMax);
            image = document.createTexture(source.name).setImage(encoded.data).setMimeType(encoded.mimeType);
          } catch (error) {
            console.warn(`Could not decode ${source.name}: ${error instanceof Error ? error.message : error}`);
          }
          itemTextures.set(key, image);
        }
        const image = itemTextures.get(key);
        if (image) {
          material.setBaseColorTexture(image);
          material.getBaseColorTextureInfo()
            .setWrapS(batch.textureFlags & M2_TEXTURE_FLAG_WRAP_S ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE)
            .setWrapT(batch.textureFlags & M2_TEXTURE_FLAG_WRAP_T ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE);
        }
      }
      const slice = attachment.mesh.indices.subarray(batch.indexStart, batch.indexStart + batch.indexCount);
      itemMesh.addPrimitive(document.createPrimitive()
        .setAttribute('POSITION', itemPosition)
        .setAttribute('NORMAL', itemNormal)
        .setAttribute('TEXCOORD_0', itemUv)
        .setIndices(accessor('SCALAR', Uint16Array.from(slice)))
        .setMaterial(material));
    }
    joint.addChild(document.createNode(`${name}-${attachment.role}-${attachment.sheath ?? 'worn'}`)
      .setTranslation(attachment.position.map((value, axis) => value - pivot[axis]))
      .setMesh(itemMesh)
      .setExtras({ wowItem: attachment.role, wowSheath: attachment.sheath ?? null }));
  });

  // Empty nodes where spell effects go, moving with their bone.
  for (const point of points) {
    const joint = joints[point.bone];
    if (!joint) continue;
    const pivot = model.bones[point.bone].pivot;
    const attached = point.attachment !== undefined;
    joint.addChild(document.createNode(attached ? `${name}-attachment${point.attachment}` : `${name}-event${point.event}`)
      .setTranslation(point.position.map((value, axis) => value - pivot[axis]))
      .setExtras(attached ? { wowAttachment: point.attachment } : { wowEvent: point.event }));
  }

  const channels = animatedChannels(model.clips, model.bones.length);
  const durations = {};
  const speeds = {};
  for (const clip of model.clips) {
    const animation = document.createAnimation(clip.name);
    durations[clip.name] = clip.duration / 1000;
    if (clip.moveSpeed > 0) speeds[clip.name] = clip.moveSpeed;
    channels.forEach((paths, boneIndex) => {
      const bone = model.bones[boneIndex];
      const parent = model.bones[bone.parentIndex];
      const rest = {
        translation: bone.pivot.map((value, axis) => value - (parent?.pivot[axis] ?? 0)),
        rotation: IDENTITY_ROTATION,
        scale: [1, 1, 1],
      };
      for (const targetPath of paths) {
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
  }
  // Durations restore each clip's full length (the last key can come early);
  // speeds are the yards per second a movement clip was made for.
  root.setExtras({ wowClipDurations: durations, wowClipSpeeds: speeds, ...(alpha < 1 ? { wowModelAlpha: alpha } : {}) });
  return document;
}

export async function writeGlb(document) {
  return new NodeIO().writeBinary(document);
}

// Client database tables used to resolve a unit's look, loaded on first use.
export class UnitData {
  constructor(readFile) {
    this.readFile = readFile;
    this.tables = new Map();
  }

  table(name) {
    if (!this.tables.has(name)) {
      const buffer = this.readFile(`DBFilesClient\\${name}.dbc`);
      this.tables.set(name, buffer ? readDbc(buffer).byId() : new Map());
    }
    return this.tables.get(name);
  }

  // CreatureDisplayInfo → model, texture variations, scale, and opacity
  // (CreatureModelAlpha, 0 to 255). Humanoid displays (with extra display
  // info) are characters, resolved separately.
  creatureDisplay(displayId) {
    const display = this.table('CreatureDisplayInfo').get(displayId);
    if (!display) return null;
    const modelData = this.table('CreatureModelData').get(display.uint(1));
    if (!modelData) return null;
    const modelName = modelData.string(2).replace(/\.md[xl]$/i, '.m2');
    const directory = path.win32.dirname(modelName);
    return {
      displayId,
      modelName,
      extraId: display.uint(3),
      scale: display.float(4) || 1,
      alpha: (display.int(5) || 255) / 255,
      variations: [6, 7, 8].map((field) => display.string(field)).map((variation) => (variation ? `${directory}\\${variation}.blp` : null)),
    };
  }
}

// Builds the GLB for a non-humanoid creature display, or null if the display
// or its model is missing.
async function buildCreatureGlb(unitData, displayId, { weapons = {} } = {}) {
  const display = unitData.creatureDisplay(displayId);
  if (!display) return null;
  if (display.extraId) return buildHumanoidCreatureGlb(unitData, display, weapons);
  const model = loadSkinnedM2(display.modelName, unitData.readFile);
  if (!model) return null;
  const textureFor = (textureIndex) => {
    const texture = model.textures[textureIndex];
    if (!texture) return null;
    let name = null;
    if (texture.type === TEXTURE_TYPE_HARDCODED) name = texture.filename;
    else if (texture.type >= TEXTURE_TYPE_MONSTER_1 && texture.type < TEXTURE_TYPE_MONSTER_1 + 3) {
      name = display.variations[texture.type - TEXTURE_TYPE_MONSTER_1];
    }
    const blp = name ? unitData.readFile(name) : null;
    return blp ? { name: path.win32.basename(name), blp } : null;
  };
  unitData.characters ??= new CharacterData(unitData);
  const attachments = creatureWeaponAttachments(unitData.characters, display.modelName, weapons);
  const points = modelEffectPoints(unitData.readFile(display.modelName));
  const document = buildUnitDocument(model, {
    name: `creature-${displayId}`, textureFor, scale: display.scale, alpha: display.alpha, attachments, points,
  });
  return writeGlb(document);
}

// Builds the GLB for a unit look by kind ('creature': { displayId }), or
// null when there is no model for it.
export async function buildUnitGlb(unitData, kind, params) {
  if (kind === 'creature') return buildCreatureGlb(unitData, Number(params.displayId), { weapons: params.weapons ?? {} });
  if (kind === 'character') return buildCharacterGlb(unitData, parseCharacterKey(String(params.key)));
  throw new Error(`Unknown unit model kind: ${kind}`);
}

// A character look as a cache key: race, gender, skin, face, hair style,
// hair colour, facial hair, flags (1 helm hidden, 2 cloak hidden), then the
// item display IDs of the visible slots, dot-separated.
export function characterKey(look) {
  const flags = (look.helmHidden ? 1 : 0) | (look.cloakHidden ? 2 : 0);
  const items = VISIBLE_SLOTS.map((slot) => look.items?.[slot] ?? 0).join('.');
  return [look.race, look.gender, look.skin, look.face, look.hairStyle, look.hairColor, look.facialStyle, flags, items].join('-');
}

export function parseCharacterKey(key) {
  const parts = key.split('-');
  if (parts.length !== 9) throw new Error('Malformed character key.');
  const [race, gender, skin, face, hairStyle, hairColor, facialStyle, flags] = parts.slice(0, 8).map(Number);
  const itemIds = parts[8].split('.').map(Number);
  if (itemIds.length !== VISIBLE_SLOTS.length || [race, gender, skin, face, hairStyle, hairColor, facialStyle, flags, ...itemIds]
    .some((value) => !Number.isInteger(value) || value < 0)) throw new Error('Malformed character key.');
  const items = {};
  VISIBLE_SLOTS.forEach((slot, index) => { if (itemIds[index]) items[slot] = itemIds[index]; });
  return { race, gender, skin, face, hairStyle, hairColor, facialStyle, helmHidden: Boolean(flags & 1), cloakHidden: Boolean(flags & 2), items };
}

async function buildCharacterGlb(unitData, look) {
  unitData.characters ??= new CharacterData(unitData);
  const character = loadCharacter(unitData.characters, look);
  if (!character) return null;
  const document = buildUnitDocument(character.model, {
    name: 'character', textureFor: character.textureFor, textureMax: 256, attachments: character.attachments,
    points: modelEffectPoints(unitData.characters.readFile(character.modelName)),
  });
  return writeGlb(document);
}

// A humanoid NPC display: the race model in the client's baked texture, with
// the display's hair, facial hair, and item geosets and models.
async function buildHumanoidCreatureGlb(unitData, display, weapons) {
  const extra = unitData.table('CreatureDisplayInfoExtra').get(display.extraId);
  if (!extra) return null;
  // NPCItemDisplay: head, shoulder, shirt, chest, belt, legs, boots, wrist, gloves, tabard, cape.
  const npcSlots = [SLOT.head, SLOT.shoulders, SLOT.shirt, SLOT.chest, SLOT.waist, SLOT.legs, SLOT.feet, SLOT.wrists, SLOT.hands, SLOT.tabard, SLOT.back];
  const items = {};
  npcSlots.forEach((slot, index) => { if (extra.uint(8 + index)) items[slot] = extra.uint(8 + index); });
  Object.assign(items, weapons);
  const bakeName = extra.string(20);
  return buildCharacterGlb(unitData, {
    race: extra.uint(1),
    gender: extra.uint(2),
    skin: extra.uint(3),
    face: extra.uint(4),
    hairStyle: extra.uint(5),
    hairColor: extra.uint(6),
    facialStyle: extra.uint(7),
    items,
    bakedTexture: bakeName ? `Textures\\BakedNpcTextures\\${bakeName}` : null,
  }, { name: `creature-${display.displayId}`, scale: display.scale });
}
