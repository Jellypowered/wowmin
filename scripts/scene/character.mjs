// Dresses a character model the way the 3.3.5 client does: race model, skin,
// face, hair, and facial hair composited into one body texture with each
// armour piece's texture painted into its region; geosets for gloves, boots,
// sleeves, robes, belts, tabards, and capes; helmets hiding hair; and helm,
// shoulder, weapon, and shield models on the skeleton's attachment points.
// Humanoid NPCs (CreatureDisplayInfoExtra) use the same path with the
// client's baked NPC texture instead of a composited one.

import path from 'node:path';

import { readDbc } from './dbc.mjs';
import { loadM2 } from './m2.mjs';
import { loadSkinnedM2 } from './m2-skinned.mjs';
import { decodeBlp, drawImage, encodeRgba } from './textures.mjs';

// Equipment slots.
export const SLOT = {
  head: 0, shoulders: 2, shirt: 3, chest: 4, waist: 5, legs: 6, feet: 7, wrists: 8, hands: 9,
  back: 14, mainHand: 15, offHand: 16, ranged: 17, tabard: 18,
};
// Slots that change how a character looks.
export const VISIBLE_SLOTS = Object.values(SLOT);

// M2 texture types.
const TEXTURE_HARDCODED = 0;
const TEXTURE_BODY = 1;
const TEXTURE_ITEM = 2;
const TEXTURE_HAIR = 6;
const TEXTURE_SKIN_EXTRA = 8;

// CharSections base sections.
const SECTION_SKIN = 0;
const SECTION_FACE = 1;
const SECTION_FACIAL_HAIR = 2;
const SECTION_HAIR = 3;
const SECTION_UNDERWEAR = 4;
const CHAR_SECTION_PLAYABLE = 0x1;

// Body texture regions on the classic 256x256 layout, scaled to the skin.
export const REGIONS = {
  armUpper: [0, 0, 128, 64],
  armLower: [0, 64, 128, 64],
  hand: [0, 128, 128, 32],
  faceUpper: [0, 160, 128, 32],
  faceLower: [0, 192, 128, 64],
  torsoUpper: [128, 0, 128, 64],
  torsoLower: [128, 64, 128, 32],
  legUpper: [128, 96, 128, 64],
  legLower: [128, 160, 128, 64],
  foot: [128, 224, 128, 32],
};
// ItemDisplayInfo texture fields 15-22, by region, with their folders.
const ITEM_REGIONS = [
  ['armUpper', 'ArmUpperTexture'], ['armLower', 'ArmLowerTexture'], ['hand', 'HandTexture'],
  ['torsoUpper', 'TorsoUpperTexture'], ['torsoLower', 'TorsoLowerTexture'],
  ['legUpper', 'LegUpperTexture'], ['legLower', 'LegLowerTexture'], ['foot', 'FootTexture'],
];
// Armour is painted in this order, so outer pieces cover inner ones.
const TEXTURE_LAYER_ORDER = [SLOT.shirt, SLOT.legs, SLOT.feet, SLOT.chest, SLOT.wrists, SLOT.hands, SLOT.waist, SLOT.tabard];

// Attachment point IDs on character skeletons.
export const ATTACH = {
  shield: 0, handRight: 1, handLeft: 2, shoulderRight: 5, shoulderLeft: 6, helm: 11,
  sheathMainHand: 26, sheathOffHand: 27, sheathShield: 28,
};

const RACE_HELM_SUFFIX = { 1: 'Hu', 2: 'Or', 3: 'Dw', 4: 'Ni', 5: 'Sc', 6: 'Ta', 7: 'Gn', 8: 'Tr', 9: 'Go', 10: 'Be', 11: 'Dr' };

// HelmetGeosetVisData fields, each a race bitmask of what the helmet hides.
const HELMET_HIDES = ['hair', 'facial1', 'facial2', 'facial3', 'ears'];

const M2_ATTACHMENTS_OFFSET = 240;
const M2_ATTACHMENT_SIZE = 40;
// The header's events (sounds, footsteps, a spell's release): four-letter
// ID, data, bone, unused, position, then when it fires.
const M2_EVENTS_OFFSET = 256;
const M2_EVENT_SIZE = 36;

// The skeleton's attachment points: { id, bone, position }. Not exposed by
// @wowserhq/format, so read from the header directly.
export function readM2Attachments(buffer) {
  if (!buffer || buffer.length < M2_ATTACHMENTS_OFFSET + 8) return [];
  const count = buffer.readUInt32LE(M2_ATTACHMENTS_OFFSET);
  const offset = buffer.readUInt32LE(M2_ATTACHMENTS_OFFSET + 4);
  if (offset + count * M2_ATTACHMENT_SIZE > buffer.length) return [];
  const attachments = [];
  for (let index = 0; index < count; index += 1) {
    const base = offset + index * M2_ATTACHMENT_SIZE;
    attachments.push({
      id: buffer.readUInt32LE(base),
      bone: buffer.readUInt16LE(base + 4),
      position: [buffer.readFloatLE(base + 8), buffer.readFloatLE(base + 12), buffer.readFloatLE(base + 16)],
    });
  }
  return attachments;
}

// The skeleton's events with these IDs ('$CSL'): { name, bone, position },
// read from the header like the attachments.
export function readM2Events(buffer, names) {
  if (!buffer || buffer.length < M2_EVENTS_OFFSET + 8) return [];
  const count = buffer.readUInt32LE(M2_EVENTS_OFFSET);
  const offset = buffer.readUInt32LE(M2_EVENTS_OFFSET + 4);
  if (offset + count * M2_EVENT_SIZE > buffer.length) return [];
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const base = offset + index * M2_EVENT_SIZE;
    const name = buffer.toString('latin1', base, base + 4);
    if (!names.includes(name)) continue;
    events.push({
      name,
      bone: buffer.readUInt16LE(base + 8),
      position: [buffer.readFloatLE(base + 12), buffer.readFloatLE(base + 16), buffer.readFloatLE(base + 20)],
    });
  }
  return events;
}

// Geoset group values (section ID = group * 100 + value; group 0 is hair,
// shown by ID), starting from a bare character.
export function defaultGeosets() {
  const groups = new Array(22).fill(1);
  groups[7] = 2; // ears
  return { hair: 0, groups };
}

export function geosetVisible({ hair, groups }, sectionId) {
  if (sectionId === 0) return true;
  if (sectionId < 100) return sectionId === hair;
  const group = Math.floor(sectionId / 100);
  return sectionId % 100 === (groups[group] ?? 1);
}

// How worn items change geosets, from each item's GeosetGroup fields.
export function applyItemGeosets(geosets, items) {
  const { groups } = geosets;
  const geoset = (slot, index) => items[slot]?.geosetGroups[index] ?? 0;
  if (items[SLOT.shirt]) groups[8] = 1 + geoset(SLOT.shirt, 0);
  if (items[SLOT.chest]) {
    groups[8] = 1 + geoset(SLOT.chest, 0);
    if (geoset(SLOT.chest, 2)) groups[13] = 1 + geoset(SLOT.chest, 2);
  }
  if (items[SLOT.legs]) {
    if (geoset(SLOT.legs, 1)) groups[9] = 1 + geoset(SLOT.legs, 1);
    if (geoset(SLOT.legs, 2) && groups[13] === 1) groups[13] = 1 + geoset(SLOT.legs, 2);
  }
  if (items[SLOT.feet] && groups[13] === 1) groups[5] = 1 + geoset(SLOT.feet, 0);
  if (items[SLOT.hands]) {
    groups[4] = 1 + geoset(SLOT.hands, 0);
    // Gloves with a cuff hide sleeve ends.
    if (groups[4] > 1) groups[8] = 1;
  }
  if (items[SLOT.waist]) groups[18] = 1 + geoset(SLOT.waist, 0);
  if (items[SLOT.tabard]) groups[12] = 2;
  if (items[SLOT.back]) groups[15] = 1 + geoset(SLOT.back, 0);
  return geosets;
}

// What a helmet hides for this race and gender.
export function helmetHides(helmetVis, race) {
  if (!helmetVis) return new Set();
  const bit = 1 << race;
  return new Set(HELMET_HIDES.filter((_, index) => (helmetVis[index] >>> 0) & bit));
}

function itemTexturePath(folder, name, gender) {
  return [`Item\\TextureComponents\\${folder}\\${name}_${gender ? 'F' : 'M'}.blp`, `Item\\TextureComponents\\${folder}\\${name}_U.blp`];
}

export class CharacterData {
  constructor(unitData) {
    this.unitData = unitData;
    this.readFile = unitData.readFile;
    this.sections = null;
  }

  // CharSections rows by "race-gender-section-variation-color", playable first.
  section(race, gender, base, variation, color) {
    if (!this.sections) {
      this.sections = new Map();
      const rows = [...this.unitData.table('CharSections').values()];
      // Playable rows win over NPC-only rows for the same key.
      rows.sort((left, right) => (right.uint(7) & CHAR_SECTION_PLAYABLE) - (left.uint(7) & CHAR_SECTION_PLAYABLE));
      for (const row of rows) {
        const key = [row.uint(1), row.uint(2), row.uint(3), row.uint(8), row.uint(9)].join('-');
        if (!this.sections.has(key)) this.sections.set(key, [row.string(4), row.string(5), row.string(6)]);
      }
    }
    return this.sections.get([race, gender, base, variation, color].join('-')) ?? null;
  }

  raceFolder(race) {
    return this.unitData.table('ChrRaces').get(race)?.string(11) ?? null;
  }

  hairGeoset(race, gender, hairStyle) {
    for (const row of this.unitData.table('CharHairGeosets').values()) {
      if (row.uint(1) === race && row.uint(2) === gender && row.uint(3) === hairStyle) return row.uint(4);
    }
    return 0;
  }

  facialGeosets(race, gender, facialStyle) {
    if (!this.facial) {
      this.facial = new Map();
      // Keyed by race, gender, variation; no ID column.
      const buffer = this.readFile('DBFilesClient\\CharacterFacialHairStyles.dbc');
      if (buffer) {
        for (const row of readDbc(buffer).records()) {
          this.facial.set(`${row.uint(0)}-${row.uint(1)}-${row.uint(2)}`, [row.uint(3), row.uint(4), row.uint(5)]);
        }
      }
    }
    return this.facial.get(`${race}-${gender}-${facialStyle}`) ?? [1, 1, 1];
  }

  item(displayId) {
    const row = displayId ? this.unitData.table('ItemDisplayInfo').get(displayId) : null;
    if (!row) return null;
    return {
      displayId,
      models: [row.string(1), row.string(2)],
      modelTextures: [row.string(3), row.string(4)],
      geosetGroups: [row.uint(7), row.uint(8), row.uint(9)],
      helmetVis: [row.uint(13), row.uint(14)],
      textures: ITEM_REGIONS.map((_, index) => row.string(15 + index)),
    };
  }

  helmetVis(id) {
    const row = id ? this.unitData.table('HelmetGeosetVisData').get(id) : null;
    return row ? HELMET_HIDES.map((_, index) => row.int(1 + index)) : null;
  }

  readImage(name, maxSize) {
    const buffer = name ? this.readFile(name) : null;
    if (!buffer) return null;
    try {
      return decodeBlp(buffer, maxSize);
    } catch {
      return null;
    }
  }
}

// Composites the body texture: skin, face, facial hair, scalp, underwear,
// then armour by layer.
export function compositeBody(characterData, look, items, { maxSize = 512 } = {}) {
  const { race, gender } = look;
  const skin = characterData.section(race, gender, SECTION_SKIN, 0, look.skin)
    ?? characterData.section(race, gender, SECTION_SKIN, 0, 0);
  const base = characterData.readImage(skin?.[0], maxSize);
  if (!base) return null;
  const body = { width: base.width, height: base.height, rgba: base.rgba };
  const scale = body.width / 256;
  const paintImage = (region, image) => {
    if (!image) return;
    const [x, y, width, height] = REGIONS[region];
    drawImage(body, image, Math.round(x * scale), Math.round(y * scale), Math.round(width * scale), Math.round(height * scale));
  };
  const paint = (region, name) => paintImage(region, characterData.readImage(name, maxSize));
  const face = characterData.section(race, gender, SECTION_FACE, look.face, look.skin);
  if (face) {
    paint('faceLower', face[0]);
    paint('faceUpper', face[1]);
  }
  const facial = characterData.section(race, gender, SECTION_FACIAL_HAIR, look.facialStyle, look.hairColor);
  if (facial) {
    paint('faceLower', facial[0]);
    paint('faceUpper', facial[1]);
  }
  const hair = characterData.section(race, gender, SECTION_HAIR, look.hairStyle, look.hairColor);
  if (hair && !look.hairHidden) {
    paint('faceLower', hair[1]);
    paint('faceUpper', hair[2]);
  }
  const underwear = characterData.section(race, gender, SECTION_UNDERWEAR, 0, look.skin);
  if (underwear) {
    paint('legUpper', underwear[0]);
    paint('torsoUpper', underwear[1]);
  }
  for (const slot of TEXTURE_LAYER_ORDER) {
    const item = items[slot];
    if (!item) continue;
    item.textures.forEach((name, index) => {
      if (!name) return;
      const [region, folder] = ITEM_REGIONS[index];
      const [gendered, unisex] = itemTexturePath(folder, name, gender);
      paintImage(region, characterData.readImage(gendered, maxSize) ?? characterData.readImage(unisex, maxSize));
    });
  }
  return body;
}

// Item models placed on attachment points. Weapons get both a drawn and a
// sheathed placement; the renderer shows one per the sheath state.
export function itemAttachments(characterData, look, items) {
  const placements = [];
  const head = items[SLOT.head];
  if (head?.models[0] && !look.helmHidden) {
    const suffix = `_${RACE_HELM_SUFFIX[look.race] ?? 'Hu'}${look.gender ? 'F' : 'M'}`;
    placements.push({
      attachment: ATTACH.helm,
      model: `Item\\ObjectComponents\\Head\\${head.models[0].replace(/\.md[xl]$/i, '')}${suffix}.m2`,
      texture: head.modelTextures[0] ? `Item\\ObjectComponents\\Head\\${head.modelTextures[0]}.blp` : null,
      role: 'helm',
    });
  }
  const shoulders = items[SLOT.shoulders];
  if (shoulders) {
    [[0, ATTACH.shoulderLeft], [1, ATTACH.shoulderRight]].forEach(([index, attachment]) => {
      if (!shoulders.models[index]) return;
      placements.push({
        attachment,
        model: `Item\\ObjectComponents\\Shoulder\\${shoulders.models[index].replace(/\.md[xl]$/i, '.m2')}`,
        texture: shoulders.modelTextures[index] ? `Item\\ObjectComponents\\Shoulder\\${shoulders.modelTextures[index]}.blp` : null,
        role: 'shoulder',
      });
    });
  }
  const weapon = (item, folders, drawn, sheathed, role) => {
    if (!item?.models[0]) return;
    const fileName = item.models[0].replace(/\.md[xl]$/i, '.m2');
    const folder = folders.find((candidate) => characterData.readFile(`Item\\ObjectComponents\\${candidate}\\${fileName}`)) ?? folders[0];
    const model = `Item\\ObjectComponents\\${folder}\\${fileName}`;
    const texture = item.modelTextures[0] ? `Item\\ObjectComponents\\${folder}\\${item.modelTextures[0]}.blp` : null;
    placements.push({ attachment: drawn, model, texture, role, sheath: 'drawn' });
    if (sheathed !== null) placements.push({ attachment: sheathed, model, texture, role, sheath: 'sheathed' });
  };
  weapon(items[SLOT.mainHand], ['Weapon'], ATTACH.handRight, ATTACH.sheathMainHand, 'mainHand');
  const offHand = items[SLOT.offHand];
  const shield = offHand && characterData.readFile(`Item\\ObjectComponents\\Shield\\${offHand.models[0]?.replace(/\.md[xl]$/i, '.m2')}`);
  if (shield) weapon(offHand, ['Shield'], ATTACH.shield, ATTACH.sheathShield, 'offHand');
  else weapon(offHand, ['Weapon'], ATTACH.handLeft, ATTACH.sheathOffHand, 'offHand');
  weapon(items[SLOT.ranged], ['Weapon'], ATTACH.handLeft, null, 'ranged');
  return placements;
}

// Loads everything for one character look: the skinned model (with geosets
// chosen), textures by type, and item attachments.
export function loadCharacter(characterData, look, { textureMax = 512 } = {}) {
  const folder = characterData.raceFolder(look.race);
  if (!folder) return null;
  const genderName = look.gender ? 'Female' : 'Male';
  const modelName = `Character\\${folder}\\${genderName}\\${folder}${genderName}.m2`;

  const items = {};
  for (const slot of VISIBLE_SLOTS) {
    const item = characterData.item(look.items?.[slot] ?? 0);
    if (item) items[slot] = item;
  }
  if (look.helmHidden) delete items[SLOT.head];
  if (look.cloakHidden) delete items[SLOT.back];
  // NPC look items only shape geosets and attachments; their textures are baked.
  const hides = items[SLOT.head] ? helmetHides(characterData.helmetVis(items[SLOT.head].helmetVis[look.gender ? 1 : 0]), look.race) : new Set();

  const geosets = defaultGeosets();
  if (!hides.has('hair')) geosets.hair = characterData.hairGeoset(look.race, look.gender, look.hairStyle);
  const facial = characterData.facialGeosets(look.race, look.gender, look.facialStyle);
  if (!hides.has('facial1')) geosets.groups[1] = facial[0];
  if (!hides.has('facial2')) geosets.groups[3] = facial[1];
  if (!hides.has('facial3')) geosets.groups[2] = facial[2];
  if (hides.has('ears')) geosets.groups[7] = 1;
  applyItemGeosets(geosets, items);

  const model = loadSkinnedM2(modelName, characterData.readFile, { showSection: (id) => geosetVisible(geosets, id) });
  if (!model) return null;

  const bodyImage = look.bakedTexture
    ? characterData.readImage(look.bakedTexture, textureMax)
    : compositeBody(characterData, { ...look, hairHidden: hides.has('hair') }, items, { maxSize: textureMax });
  const skinSection = characterData.section(look.race, look.gender, SECTION_SKIN, 0, look.skin);
  const hairSection = characterData.section(look.race, look.gender, SECTION_HAIR, look.hairStyle, look.hairColor);
  const capeTexture = items[SLOT.back]?.modelTextures[0] ? `Item\\ObjectComponents\\Cape\\${items[SLOT.back].modelTextures[0]}.blp` : null;
  const byType = {
    [TEXTURE_BODY]: bodyImage ? { name: 'body', encoded: encodeRgba(bodyImage) } : null,
    [TEXTURE_HAIR]: hairSection?.[0] ? { name: path.win32.basename(hairSection[0]), file: hairSection[0] } : null,
    [TEXTURE_SKIN_EXTRA]: skinSection?.[1] ? { name: path.win32.basename(skinSection[1]), file: skinSection[1] } : null,
    [TEXTURE_ITEM]: capeTexture ? { name: path.win32.basename(capeTexture), file: capeTexture } : null,
  };
  const textureFor = (textureIndex) => {
    const texture = model.textures[textureIndex];
    if (!texture) return null;
    const source = texture.type === TEXTURE_HARDCODED
      ? (texture.filename ? { name: path.win32.basename(texture.filename), file: texture.filename } : null)
      : byType[texture.type] ?? null;
    if (!source) return null;
    if (source.encoded) return source;
    const blp = characterData.readFile(source.file);
    return blp ? { name: source.name, blp } : null;
  };

  const attachments = resolveAttachments(characterData, modelName, itemAttachments(characterData, look, items));
  return { model, textureFor, attachments, modelName };
}

// Loads each placed item's model and finds its attachment point on the
// skeleton; items whose point or model is missing are dropped.
export function resolveAttachments(characterData, modelName, placements) {
  const skeletonAttachments = readM2Attachments(characterData.readFile(modelName));
  return placements.flatMap((placement) => {
    const point = skeletonAttachments.find((candidate) => candidate.id === placement.attachment);
    const itemModel = point ? loadM2(placement.model, characterData.readFile) : null;
    if (!itemModel) return [];
    // A weapon's blade, bottom and top, which a swing's trail sweeps.
    const blade = readM2Events(characterData.readFile(placement.model), ['$WTB', '$WTT']);
    const bottom = blade.find((event) => event.name === '$WTB');
    const top = blade.find((event) => event.name === '$WTT');
    return [{
      ...placement,
      bone: point.bone,
      position: point.position,
      mesh: itemModel,
      ...(bottom && top ? { trail: { bottom: bottom.position, top: top.position } } : {}),
      textureFor: (batch) => {
        const name = batch.textureType === TEXTURE_HARDCODED ? batch.texture : batch.textureType === TEXTURE_ITEM ? placement.texture : null;
        const blp = name ? characterData.readFile(name) : null;
        return blp ? { name: path.win32.basename(name), blp } : null;
      },
    }];
  });
}

// Weapons for a creature model (by item display ID per weapon slot).
export function creatureWeaponAttachments(characterData, modelName, weapons) {
  const items = {};
  for (const slot of [SLOT.mainHand, SLOT.offHand, SLOT.ranged]) {
    const item = characterData.item(weapons[slot] ?? 0);
    if (item) items[slot] = item;
  }
  return resolveAttachments(characterData, modelName, itemAttachments(characterData, { helmHidden: true }, items));
}
