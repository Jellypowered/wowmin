// Resolves a spell to the client's own art for it: Spell.dbc → SpellVisual →
// SpellVisualKit (one per stage: precast, cast, impact, ...) → the effect
// model on each body slot (SpellVisualEffectName). Field numbers are for
// 3.3.5 and were checked against the client's tables.

import { readDbc } from './dbc.mjs';
import { parseMotionScript } from './missile-motion.mjs';

const SPELL_VISUAL_FIELD = 131;
// Spell.dbc's enUS name and rank ("Rank 3", "Racial").
const SPELL_NAME_FIELD = 136;
const SPELL_RANK_FIELD = 153;
// Spell.dbc's three effects and the auras they apply. A taunt forces its
// target to attack (effect 114) or applies the taunt aura (11).
const SPELL_EFFECT_FIELDS = [71, 72, 73];
const SPELL_AURA_FIELDS = [95, 96, 97];
const EFFECT_ATTACK_ME = 114;
const AURA_MOD_TAUNT = 11;
// An aura that casts another spell every so often (Starfall, Bladestorm),
// and the fields saying what each effect targets, how far it reaches
// (SpellRadius), and which spell it triggers.
const AURA_PERIODIC_TRIGGER_SPELL = 23;
const SPELL_TARGET_FIELDS = [86, 87, 88, 89, 90, 91];
const SPELL_RADIUS_FIELDS = [92, 93, 94];
const SPELL_TRIGGER_FIELDS = [116, 117, 118];
const SPELL_SCHOOL_MASK_FIELD = 225;
// A spell's missile record (SpellMissile): one with flag 1 flies a gravity
// arc (catapults, vehicle guns, Heroic Leap) at a pitch and speed in these
// ranges.
const SPELL_MISSILE_FIELD = 227;
const MISSILE_FLAG_TRAJECTORY = 0x1;
const MISSILE_FIELDS = { flags: 1, pitchMin: 2, pitchMax: 3, speedMin: 4, speedMax: 5, gravity: 12 };
// A spell that roots its target (SPELL_AURA_MOD_ROOT): its kits' world
// effect follows the unit rather than staying where it started.
const AURA_MOD_ROOT = 26;
// Targets round the caster (TARGET_SRC_CASTER), as a triggered area is.
const TARGET_AREA_AROUND_CASTER = 22;
const RADIUS_FIELD = 1;
// A wand's Shoot has no art of its own: the client picks a bolt by the
// wand's damage school. These visuals are the wand set (all share precast
// kit 372, AnimationData 111, and nothing in Spell.dbc names them); which
// school each serves is read from its missile model. By school bit.
const WAND_SHOOT_SPELL = 5019;
export const WAND_VISUALS = { 2: 228, 4: 225, 8: 2797, 16: 229, 32: 226, 64: 2799 };
// SpellVisual fields naming a kit, by the stage the kit plays at.
const VISUAL_KITS = {
  precast: 1, cast: 2, impact: 3, state: 4, stateDone: 5, channel: 6,
  casterImpact: 14, targetImpact: 15, missileTargeting: 22, instantArea: 23, impactArea: 24, persistentArea: 25,
};
// The kits the client looks in for a chain procedure; a visual with one
// plays no impact area kit.
const CHAIN_KIT_STAGES = ['cast', 'impact', 'state', 'channel', 'casterImpact', 'targetImpact'];
// The missile: its model, where it lands and leaves from (an index into the
// client's effect attachments, or a raw M2 attachment with flag 0x200; -1
// for none), and offsets from those (model space) as it leaves and lands.
const VISUAL_MISSILE_MODEL = 8;
const VISUAL_MISSILE_DESTINATION_ATTACHMENT = 10;
const VISUAL_FLAGS = 13;
const VISUAL_FLAG_RAW_ATTACHMENTS = 0x200;
// A visual whose missiles leave as the spell fires, not on the cast
// animation's release.
const VISUAL_FLAG_RELEASE_AT_ONCE = 0x4;
// A missile that follows the ground: its height (thousandths of a yard,
// at least a quarter yard), how fast it drops to it, from how far along its
// flight it heads in to its target (thousandths), and flags (1: on).
const VISUAL_FOLLOW_GROUND = { height: 17, dropSpeed: 18, approach: 19, flags: 20 };
const FOLLOW_GROUND_ON = 0x1;
const MIN_FOLLOW_HEIGHT = 0.25;
// The missile's motion script (SpellMissileMotion: name, script, flags,
// how many missiles fly).
const VISUAL_MISSILE_MOTION = 21;
const MOTION_SCRIPT = 2;
const MOTION_COUNT = 4;
// AnimationData's behaviour: a cast kit whose animation casts a spell (or
// throws) holds its missiles until the animation releases them.
const ANIMATION_BEHAVIOR = 6;
const RELEASING_BEHAVIORS = new Set([2, 32, 33, 53, 54, 46, 49, 107]);
const VISUAL_MISSILE_ATTACHMENT = 16;
const VISUAL_MISSILE_CAST_OFFSET = 26;
const VISUAL_MISSILE_IMPACT_OFFSET = 29;
// SpellVisualKit: start and loop animation, then an effect per body slot.
const KIT_START_ANIM = 1;
const KIT_ANIM = 2;
// The kit's flags: 0x1 waits for its chain's bolt to reach the unit; 0x4
// and 0x8 play the animation itself, without falling back.
const KIT_FLAGS = 37;
const KIT_RAW_ANIMATION = 0x4 | 0x8;
// AnimationData: a clip's name, and the clip a model without it plays
// instead (0 for none; falling back to Stand is left to the unit).
const ANIMATION_NAME = 1;
const ANIMATION_FALLBACK = 5;
// Spell.dbc's target flags and implicit targets, for telling a harmful
// spell (the client skips some of its colours on some creatures).
const SPELL_TARGET_FLAGS = 16;
const TARGET_FLAG_HELPFUL = 0x100;
const TARGET_FLAG_HARMFUL = 0x80;
const HARMFUL_TARGETS = new Set([2, 6, 15, 16, 24, 28, 53, 54, 93]);
const KIT_SLOTS = ['head', 'chest', 'base', 'leftHand', 'rightHand', 'breath', 'leftWeapon', 'rightWeapon',
  'special1', 'special2', 'special3', 'world'];
const KIT_FIRST_SLOT = 3;
// Up to four procedures a kit runs (CharProc), each with four parameters
// (CharParamZero..Three, one array per parameter).
const KIT_PROCS = 17;
const KIT_PROC_PARAMS = [21, 25, 29, 33];
// Procedures 0 and 12 draw a chain between units (Chain Heal, Chain
// Lightning, Drain Life): the first parameter is the SpellChainEffects row,
// the third whether it lasts until its kit ends (a channel's), the fourth
// whether each link runs from the caster rather than on from the last
// target.
const CHAIN_PROCEDURES = [0, 12];
// SpellChainEffects, by field. Its colour and blend mode are single bytes,
// so the fields after them are read by byte offset (CHAIN_BYTES).
const CHAIN_FIELDS = {
  segmentLength: 1, width: 2, noise: 3, scrollSpeed: 4, segmentMs: 5, delayMs: 6, texture: 7, flags: 8,
  jointCount: 9, jointOffsetRadius: 10, jointsPerMinorJoint: 11, minorJointsPerMajorJoint: 12, minorJointScale: 13,
  majorJointScale: 14, jointMoveSpeed: 15, jointSmoothness: 16, minJointJump: 17, maxJointJump: 18,
  waveHeight: 19, waveFrequency: 20, waveSpeed: 21, minWaveAngle: 22, maxWaveAngle: 23, minWaveSpin: 24, maxWaveSpin: 25,
  arcHeight: 26, minArcAngle: 27, maxArcAngle: 28, minArcSpin: 29, maxArcSpin: 30, linkDelayMs: 31,
  minFlickerOn: 32, maxFlickerOn: 33, minFlickerOff: 34, maxFlickerOff: 35, pulseSpeed: 36, pulseOnLength: 37, pulseFadeLength: 38,
};
const CHAIN_INT_FIELDS = new Set(['segmentMs', 'delayMs', 'flags', 'jointCount', 'jointsPerMinorJoint', 'minorJointsPerMajorJoint']);
const CHAIN_BYTES = { alpha: 156, red: 157, green: 158, blue: 159, blendMode: 160, combo: 161, renderLayer: 165, textureLength: 169, wavePhase: 173 };
// A chain's combo names up to twelve more chains drawn with it, each a
// 4-byte ID packed so it holds no zero byte.
const MAX_CHAIN_COMBO = 12;
export function decodeChainId(packed) {
  const bits = (packed & 0xFEFEFEFE) >>> 0;
  let high = (bits >>> 7) & 0x200000;
  high = (((high | (bits & 0x20000000)) >>> 3) | (bits & 0x2000000)) >>> 0;
  high = ((((high >>> 4) | (bits & 0x40000000)) >>> 3) | (bits & 0x4000000)) >>> 0;
  return ((high >>> 11) | ((((bits >>> 4) & 0xFF800000) | bits) & 0xFFFFFF)) >>> 0;
}
// Procedure 9 rains models over a lasting area (Blizzard's ice, Rain of
// Fire's fire): its first parameter is the row of SpellVisualKitAreaModel,
// counted from 0, whose model falls, the first row when there is no such
// row.
const AREA_MODEL_FILE = 1;
// GameObjectDisplayInfo: the model file.
const GAMEOBJECT_MODEL_FIELD = 1;
// SpellVisualEffectName: name, file, area effect size, scale.
const EFFECT_FILE = 2;
const EFFECT_AREA_SIZE = 3;
const EFFECT_SCALE = 4;

export class SpellVisuals {
  constructor(readFile) {
    this.readFile = readFile;
    this.tables = new Map();
    this.present = new Map();
  }

  table(name) {
    if (!this.tables.has(name)) {
      const buffer = this.readFile(`DBFilesClient\\${name}.dbc`);
      this.tables.set(name, buffer ? readDbc(buffer).byId() : new Map());
    }
    return this.tables.get(name);
  }

  // The model file for a game object display (GameObjectDisplayInfo), or null
  // if it has none to draw: building (WMO) objects, which the effect
  // converter can't build, and the invisible marker models of traps.
  gameObjectModel(displayId) {
    const file = this.table('GameObjectDisplayInfo').get(displayId)?.string(GAMEOBJECT_MODEL_FIELD);
    if (!file || /\.wmo$/i.test(file) || /invisible/i.test(file)) return null;
    const modelName = file.replace(/\.md[xl]$/i, '.m2');
    return this.hasFile(modelName) ? modelName : null;
  }

  // The model file for an effect, or null if it isn't in the client.
  effectModel(effectId) {
    const effect = this.table('SpellVisualEffectName').get(effectId);
    const file = effect?.string(EFFECT_FILE);
    if (!file) return null;
    const modelName = file.replace(/\.md[xl]$/i, '.m2');
    return this.hasFile(modelName) ? modelName : null;
  }

  // Whether the client has a file, remembered (reading one decompresses it).
  hasFile(name) {
    let known = this.present.get(name);
    if (known === undefined) {
      known = Boolean(this.readFile(name));
      this.present.set(name, known);
    }
    return known;
  }

  // The model procedure 9 rains for its first parameter, or null if the
  // client lacks it.
  areaModel(index) {
    const rows = [...this.table('SpellVisualKitAreaModel').values()];
    const file = (rows[index] ?? rows[0])?.string(AREA_MODEL_FILE);
    if (!file) return null;
    const modelName = file.replace(/\.md[xl]$/i, '.m2');
    return this.hasFile(modelName) ? modelName : null;
  }

  effect(effectId) {
    const effect = this.table('SpellVisualEffectName').get(effectId);
    if (!effect || !this.effectModel(effectId)) return null;
    return { id: effectId, scale: effect.float(EFFECT_SCALE) || 1, areaSize: effect.float(EFFECT_AREA_SIZE) };
  }

  kit(kitId) {
    const kit = this.table('SpellVisualKit').get(kitId);
    if (!kit) return null;
    const effects = KIT_SLOTS.flatMap((slot, index) => {
      const effect = this.effect(kit.int(KIT_FIRST_SLOT + index));
      return effect ? [{ slot, ...effect }] : [];
    });
    const startAnim = kit.int(KIT_START_ANIM);
    const anim = kit.int(KIT_ANIM);
    const procs = [0, 1, 2, 3].flatMap((index) => {
      const code = kit.int(KIT_PROCS + index);
      return code >= 0 ? [{ code, params: KIT_PROC_PARAMS.map((field) => kit.float(field + index)) }] : [];
    });
    if (!effects.length && !procs.length && anim < 0 && startAnim < 0) return null;
    const flags = kit.uint(KIT_FLAGS);
    const raw = Boolean(flags & KIT_RAW_ANIMATION);
    const animClips = this.animationClips(anim, raw);
    const startClips = this.animationClips(startAnim, raw);
    return {
      id: kitId, startAnim, anim, effects, procs, flags,
      ...(animClips.length ? { animClips } : {}), ...(startClips.length ? { startClips } : {}),
    };
  }

  // The clips an animation plays, by name: its own, then (unless `raw`)
  // each it falls back to on a model without it, short of Stand.
  animationClips(animId, raw = false) {
    const clips = [];
    const seen = new Set();
    for (let id = animId; id > 0 && !seen.has(id); id = raw ? 0 : this.table('AnimationData').get(id)?.int(ANIMATION_FALLBACK) ?? 0) {
      seen.add(id);
      const name = this.table('AnimationData').get(id)?.string(ANIMATION_NAME);
      if (name) clips.push(name);
    }
    return clips;
  }

  // Whether the client counts a spell as harmful: by its target flags, else
  // by any implicit target at an enemy.
  harmful(spell) {
    const flags = spell.uint(SPELL_TARGET_FLAGS);
    if (flags & TARGET_FLAG_HELPFUL) return false;
    if (flags & TARGET_FLAG_HARMFUL) return true;
    const targets = SPELL_TARGET_FIELDS.map((field) => spell.int(field));
    if (targets.some((target) => HARMFUL_TARGETS.has(target))) return true;
    return false;
  }

  // A chain effect (SpellChainEffects): every field the client draws it
  // by, and the chains its combo adds; null if its texture is missing.
  chain(chainId) {
    const chain = this.table('SpellChainEffects').get(chainId);
    const texture = chain?.string(CHAIN_FIELDS.texture);
    if (!texture || !this.hasFile(texture)) return null;
    const fields = Object.fromEntries(Object.entries(CHAIN_FIELDS).filter(([name]) => name !== 'texture')
      .map(([name, field]) => [name, CHAIN_INT_FIELDS.has(name) ? chain.int(field) : chain.float(field)]));
    const combo = chain.bytesAt(CHAIN_BYTES.combo);
    const comboIds = [];
    for (let offset = 0; offset + 4 <= combo.length && comboIds.length < MAX_CHAIN_COMBO; offset += 4) {
      const id = decodeChainId(combo.readUInt32LE(offset));
      if (!id || !this.table('SpellChainEffects').has(id)) break;
      comboIds.push(id);
    }
    return {
      id: chainId,
      ...fields,
      color: (chain.byteAt(CHAIN_BYTES.red) << 16) | (chain.byteAt(CHAIN_BYTES.green) << 8) | chain.byteAt(CHAIN_BYTES.blue),
      alpha: chain.byteAt(CHAIN_BYTES.alpha) / 255,
      blendMode: chain.byteAt(CHAIN_BYTES.blendMode),
      renderLayer: chain.intAt(CHAIN_BYTES.renderLayer),
      textureLength: chain.floatAt(CHAIN_BYTES.textureLength),
      wavePhase: chain.floatAt(CHAIN_BYTES.wavePhase),
      combo: comboIds,
    };
  }

  // The chain texture's file, for the icon builder.
  chainTexture(chainId) {
    return this.table('SpellChainEffects').get(chainId)?.string(CHAIN_FIELDS.texture) || null;
  }

  // For an aura that keeps casting an area spell round its bearer: the
  // area's radius, the spells it casts, and its school; or null.
  bearerArea(spell) {
    const radii = this.table('SpellRadius');
    const triggers = [];
    let radius = 0;
    SPELL_AURA_FIELDS.forEach((field, index) => {
      if (spell.int(field) !== AURA_PERIODIC_TRIGGER_SPELL) return;
      const trigger = this.table('Spell').get(spell.uint(SPELL_TRIGGER_FIELDS[index]));
      if (!trigger) return;
      const reach = Math.max(0, ...[0, 1, 2]
        .filter((effect) => [effect, effect + 3].some((slot) => trigger.uint(SPELL_TARGET_FIELDS[slot]) === TARGET_AREA_AROUND_CASTER))
        .map((effect) => radii.get(trigger.uint(SPELL_RADIUS_FIELDS[effect]))?.float(RADIUS_FIELD) ?? 0));
      if (reach <= 0) return;
      triggers.push(trigger.uint(0));
      radius = Math.max(radius, reach);
    });
    return triggers.length ? { radius, triggers, schoolMask: spell.uint(SPELL_SCHOOL_MASK_FIELD) } : null;
  }

  // The spell's name, rank, and whether it taunts, or null if the client has
  // no such spell.
  info(spellId) {
    const spell = this.table('Spell').get(spellId);
    if (!spell) return null;
    const taunt = SPELL_EFFECT_FIELDS.some((field) => spell.int(field) === EFFECT_ATTACK_ME)
      || SPELL_AURA_FIELDS.some((field) => spell.int(field) === AURA_MOD_TAUNT);
    return { id: spellId, name: spell.string(SPELL_NAME_FIELD), rank: spell.string(SPELL_RANK_FIELD), taunt };
  }

  // Everything wowmin draws for a spell, or null if it has no art. A wand's
  // Shoot lists its art by school instead (`bySchool`).
  forSpell(spellId) {
    const spell = this.table('Spell').get(spellId);
    if (!spell) return null;
    if (spellId === WAND_SHOOT_SPELL) {
      const bySchool = Object.fromEntries(Object.entries(WAND_VISUALS).flatMap(([school, visualId]) => {
        const art = this.forVisual(visualId);
        return art ? [[school, art]] : [];
      }));
      return Object.keys(bySchool).length ? { spellId, visualId: 0, missile: null, kits: {}, bySchool } : null;
    }
    const art = this.forVisual(spell.uint(SPELL_VISUAL_FIELD));
    if (!art) return null;
    const trajectory = art.missile ? this.trajectory(spell) : null;
    if (trajectory) art.missile.trajectory = trajectory;
    const bearerArea = this.bearerArea(spell);
    const rootsUnit = SPELL_AURA_FIELDS.some((field) => spell.int(field) === AURA_MOD_ROOT);
    const harmful = this.harmful(spell);
    return {
      spellId, ...art, ...(bearerArea ? { bearerArea } : {}), ...(rootsUnit ? { rootsUnit } : {}), ...(harmful ? { harmful } : {}),
    };
  }

  // A SpellVisual's missile, kits, and chain, or null if it has no missile
  // or kits.
  forVisual(visualId) {
    const visual = this.table('SpellVisual').get(visualId);
    if (!visual) return null;
    const kits = {};
    for (const [stage, field] of Object.entries(VISUAL_KITS)) {
      const kit = this.kit(visual.uint(field));
      if (kit) kits[stage] = kit;
    }
    const missile = this.effect(visual.uint(VISUAL_MISSILE_MODEL));
    if (!missile && !Object.keys(kits).length) return null;
    const vector = (field) => [0, 1, 2].map((axis) => visual.float(field + axis));
    // Where its missiles, and its chains' links, leave and land.
    const points = {
      attachment: visual.int(VISUAL_MISSILE_ATTACHMENT),
      destinationAttachment: visual.int(VISUAL_MISSILE_DESTINATION_ATTACHMENT),
      rawAttachments: Boolean(visual.uint(VISUAL_FLAGS) & VISUAL_FLAG_RAW_ATTACHMENTS),
      castOffset: vector(VISUAL_MISSILE_CAST_OFFSET),
      impactOffset: vector(VISUAL_MISSILE_IMPACT_OFFSET),
    };
    const chain = this.visualChain(kits, points);
    const chainEffect = CHAIN_KIT_STAGES.some((stage) => kits[stage]?.procs.some((proc) => CHAIN_PROCEDURES.includes(proc.code)));
    return {
      visualId: visual.uint(0),
      missile: missile && { ...missile, ...points, ...this.missileFlight(visual, kits.cast) },
      kits,
      ...(chain ? { chain } : {}),
      ...(chainEffect ? { chainEffect } : {}),
    };
  }

  // How a visual's missile flies: whether it waits for the cast animation
  // to release it, whether it follows the ground and how, and its motion
  // script and how many fly.
  missileFlight(visual, castKit) {
    const behavior = castKit && castKit.anim > 0 ? this.table('AnimationData').get(castKit.anim)?.int(ANIMATION_BEHAVIOR) : undefined;
    const waitsForRelease = !(visual.uint(VISUAL_FLAGS) & VISUAL_FLAG_RELEASE_AT_ONCE) && RELEASING_BEHAVIORS.has(behavior);
    const followFlags = visual.uint(VISUAL_FOLLOW_GROUND.flags);
    const followGround = followFlags & FOLLOW_GROUND_ON ? {
      height: Math.max(MIN_FOLLOW_HEIGHT, visual.float(VISUAL_FOLLOW_GROUND.height) / 1000),
      dropSpeed: visual.float(VISUAL_FOLLOW_GROUND.dropSpeed) / 1000,
      approach: Math.min(1, Math.max(0, visual.float(VISUAL_FOLLOW_GROUND.approach) / 1000)),
      flags: followFlags,
    } : null;
    const motionRow = this.table('SpellMissileMotion').get(visual.uint(VISUAL_MISSILE_MOTION));
    let motion = null;
    if (motionRow) {
      try {
        motion = { count: Math.max(1, motionRow.uint(MOTION_COUNT)), script: parseMotionScript(motionRow.string(MOTION_SCRIPT)) };
      } catch {
        motion = null;
      }
    }
    return { waitsForRelease, ...(followGround ? { followGround } : {}), ...(motion ? { motion } : {}) };
  }

  // A spell's gravity arc, if its missile flies one: gravity, and the pitch
  // and speed ranges it is launched at.
  trajectory(spell) {
    const row = this.table('SpellMissile').get(spell.uint(SPELL_MISSILE_FIELD));
    if (!row || !(row.int(MISSILE_FIELDS.flags) & MISSILE_FLAG_TRAJECTORY)) return null;
    return {
      gravity: row.float(MISSILE_FIELDS.gravity),
      pitch: [row.float(MISSILE_FIELDS.pitchMin), row.float(MISSILE_FIELDS.pitchMax)],
      speed: [row.float(MISSILE_FIELDS.speedMin), row.float(MISSILE_FIELDS.speedMax)],
    };
  }

  // The chain a visual's kits draw: the stage whose kit runs the chain
  // procedure, whether it lasts and runs from the caster, its chain and the
  // chains its combo adds (each drawn with it), and where its links leave
  // and land; or null.
  visualChain(kits, points) {
    for (const [stage, kit] of Object.entries(kits)) {
      const proc = kit.procs.find((candidate) => CHAIN_PROCEDURES.includes(candidate.code));
      if (!proc) continue;
      const root = this.chain(proc.params[0]);
      if (!root) return null;
      const effects = [root, ...root.combo.map((id) => this.chain(id)).filter(Boolean)];
      return { stage, persist: proc.params[2] !== 0, reverse: proc.params[3] !== 0, effects, points };
    }
    return null;
  }
}
