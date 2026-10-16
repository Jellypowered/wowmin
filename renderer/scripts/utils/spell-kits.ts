import type { SpellChain } from './lightning';
import type { FollowGround, Trajectory } from './missile-flight';
import type { MissileMotion } from './missile-motion';
import type { CastGlow, Point3 } from './spell-events';

// The client's spell art as wowmin plays it: a spell's kits by stage, which
// body slot each effect sits on, and the animations kits name. Pure, so it
// can be tested without three.js.

// Where on a unit an effect sits (as SpellEffectLayer's anchors).
export type UnitAnchorRole = 'handRight' | 'handLeft' | 'chest' | 'head' | 'breath' | 'overhead' | 'feet';

// A spell's art as served by /assets/models/visual/<spellId>.json
// (scripts/scene/spell-visuals.mjs).
export interface VisualEffect {
  slot: string;
  id: number;
  scale: number;
}

export interface VisualKit {
  id: number;
  anim: number;
  effects: VisualEffect[];
  // Procedures the client runs for the kit: a code and four parameters.
  procs?: Array<{ code: number; params: number[] }>;
}

export type KitStage = 'precast' | 'cast' | 'channel' | 'impact' | 'casterImpact' | 'targetImpact' | 'state' | 'stateDone'
  | 'missileTargeting' | 'instantArea' | 'impactArea' | 'persistentArea';

// A chain drawn from the caster to its target and on to each target it
// jumps to (Chain Heal, Chain Lightning), or held to its target while a
// channel lasts (`persist`: Drain Life). `stage` is the kit that runs it;
// `reverse` runs each link from the caster rather than on from the last
// target. Each link draws a bolt of each of `effects`, the chain and the
// chains its combo adds, whose textures are served as
// /assets/models/icon/chain-<id>.png. `points` says where links leave and
// land, as a missile's do.
export interface VisualChain {
  stage: KitStage;
  persist: boolean;
  reverse: boolean;
  effects: SpellChain[];
  points: VisualPoints;
}

// An aura that keeps casting an area spell round its bearer (Starfall):
// how far it reaches, the spells it casts, and its school.
export interface BearerArea {
  radius: number;
  triggers: number[];
  schoolMask: number;
}

// Where a spell's missile or chain link leaves and lands. Each point is an
// index into the client's effect attachments (EFFECT_ATTACHMENTS), or with
// `rawAttachments` an M2 attachment ID; -1 for none. The offsets are in
// model space from those points.
export interface VisualPoints {
  attachment?: number;
  destinationAttachment?: number;
  rawAttachments?: boolean;
  castOffset?: Point3;
  impactOffset?: Point3;
}

// A spell's missile: its model, where it leaves and lands, and how it
// flies: whether it waits for the cast animation to release it, and its
// motion script, ground following, and gravity arc, if any.
export interface VisualMissile extends VisualPoints {
  id: number;
  scale: number;
  waitsForRelease?: boolean;
  motion?: MissileMotion;
  followGround?: FollowGround;
  trajectory?: Trajectory;
}

export interface SpellVisual {
  missile: VisualMissile | null;
  kits: Partial<Record<KitStage, VisualKit>>;
  chain?: VisualChain;
  // Whether a kit the client looks in has a chain procedure; such spells
  // play no impact area kit.
  chainEffect?: boolean;
  bearerArea?: BearerArea;
  // Whether the spell roots its target: its kits' world effects follow the
  // unit instead of staying where they started.
  rootsUnit?: boolean;
  // Art by school bit, for spells whose art depends on the cast's school
  // (a wand's Shoot); the spell's own fields are then empty.
  bySchool?: Record<string, SpellVisual>;
}

// The art a cast of this school plays: the school's own for a spell that
// has art by school (null if its school has none), else the spell's.
export function artForSchool(visual: SpellVisual, schoolMask: number): SpellVisual | null {
  if (!visual.bySchool) return visual;
  const school = Object.keys(visual.bySchool).map(Number).find((bit) => schoolMask & bit);
  return school === undefined ? null : visual.bySchool[school];
}

// AnimationData IDs kits name, by the clip names unit models export
// (UNIT_ANIMATIONS in scripts/scene/m2-skinned.mjs).
const KIT_ANIMATIONS: Record<number, string> = {
  9: 'CombatWound', 10: 'CombatCritical', 14: 'Stun', 16: 'AttackUnarmed', 17: 'Attack1H', 32: 'SpellCast',
  51: 'ReadySpellDirected', 52: 'ReadySpellOmni', 53: 'SpellCastDirected', 54: 'SpellCastOmni', 55: 'BattleRoar',
  57: 'Special1H', 107: 'AttackThrown', 108: 'ReadyThrown', 118: 'SpecialUnarmed', 123: 'UseStandingLoop',
  124: 'ChannelCastDirected', 125: 'ChannelCastOmni',
};

export function kitAnimationName(anim: number | undefined): string | null {
  return anim === undefined ? null : KIT_ANIMATIONS[anim] ?? null;
}

// The M2 attachment each kit slot's effect sits on in the client. A model
// without it shows no effect there.
// The world effect isn't attached: it stands at the unit's feet.
const SLOT_ATTACHMENTS: Record<string, number> = {
  head: 20, base: 19, leftHand: 21, rightHand: 22, breath: 17, chest: 34,
  special1: 23, special2: 24, special3: 25, leftWeapon: 2, rightWeapon: 1,
};

export function slotAttachment(slot: string): number | null {
  return SLOT_ATTACHMENTS[slot] ?? null;
}

// Placed at an area's ground point, a kit draws only its world and base
// effects there and its head effect on the caster (the client's ground
// mode); the rest of its slots are skipped.
export function groundSlot(slot: string): 'ground' | 'caster' | null {
  if (slot === 'world' || slot === 'base') return 'ground';
  return slot === 'head' ? 'caster' : null;
}

// The client's table of effect attachments, which missile points index;
// index 13 means the weapon, here its hand (4).
const EFFECT_ATTACHMENTS = [20, 34, 19, 21, 22, 17, 23, 24, 25, 15, 16, 37, 38, 22, 47, 48];
const WEAPON_EFFECT_ATTACHMENT = 13;
// With no attachment of its own but an offset, a missile leaves from the
// directed spell hand (38) when the model has it.
export const DIRECTED_HAND_ATTACHMENT = EFFECT_ATTACHMENTS[12];

// The M2 attachment a missile point names, or null for none.
export function missileAttachment(point: number | undefined, raw = false): number | null {
  if (point === undefined || point < 0) return null;
  if (raw) return point;
  return EFFECT_ATTACHMENTS[point === WEAPON_EFFECT_ATTACHMENT ? 4 : point] ?? null;
}

// The client reads missile offsets with their Y flipped.
export function missileOffset(offset: Point3 | undefined): Point3 {
  return offset ? [offset[0], -offset[1], offset[2]] : [0, 0, 0];
}

// Without a point on the model, a missile leaves from and lands at this
// share of its unit's height.
export const MISSILE_HEIGHT_SHARE = 0.75;

// The kit a cast plays: the cast kit as it fires, the channel kit (or the
// precast kit) while channelling, and the precast kit while casting.
export function castKit(visual: SpellVisual, cast: Pick<CastGlow, 'release' | 'channeled'>): VisualKit | undefined {
  if (cast.release) return visual.kits.cast;
  if (cast.channeled) return visual.kits.channel ?? visual.kits.precast;
  return visual.kits.precast;
}


// Kit procedures that colour a unit's model, as the client's unit code runs
// them: 1 multiplies the model's colour by its first parameter (0xRRGGBB,
// stored as a float) for as long as the kit plays, the newest such kit on a
// unit winning; 13 does so for a moment, holding for its second parameter
// (seconds) and fading back to white over its third, over any procedure 1
// colour. Their other parameters are unused. 14 makes the unit see-through:
// its first parameter (0 to 1) times the model's own opacity, reached over
// its third parameter (seconds; a second when 0), the newest such kit
// winning (Shadowform).
const COLOR_PROCEDURE = 1;
const COLOR_FLASH_PROCEDURE = 13;
const ALPHA_PROCEDURE = 14;
export const DEFAULT_ALPHA_FADE_MS = 1000;

export interface ColorFlash {
  color: number;
  holdMs: number;
  fadeMs: number;
}

// The colour a kit gives its unit while it plays, or null.
export function kitColor(kit: VisualKit): number | null {
  const proc = kit.procs?.find((candidate) => candidate.code === COLOR_PROCEDURE);
  return proc ? Math.round(proc.params[0]) & 0xffffff : null;
}

// How see-through a kit makes its unit while it plays, and how fast it
// fades to that, or null.
export function kitAlpha(kit: VisualKit): { alpha: number; fadeMs: number } | null {
  const proc = kit.procs?.find((candidate) => candidate.code === ALPHA_PROCEDURE);
  if (!proc || !(proc.params[0] > 0 && proc.params[0] <= 1)) return null;
  return { alpha: proc.params[0], fadeMs: proc.params[2] > 0 ? proc.params[2] * 1000 : DEFAULT_ALPHA_FADE_MS };
}

// The colour flash a kit starts on its unit, or null.
export function kitColorFlash(kit: VisualKit): ColorFlash | null {
  const proc = kit.procs?.find((candidate) => candidate.code === COLOR_FLASH_PROCEDURE);
  if (!proc) return null;
  return { color: Math.round(proc.params[0]) & 0xffffff, holdMs: proc.params[1] * 1000, fadeMs: proc.params[2] * 1000 };
}

// A flash's colour `elapsedMs` after it began: its own while it holds, then
// fading to white; null once it is over.
export function flashColor(flash: ColorFlash, elapsedMs: number): number | null {
  if (elapsedMs < 0) return null;
  if (elapsedMs < flash.holdMs) return flash.color;
  const fade = elapsedMs - flash.holdMs;
  if (fade >= flash.fadeMs) return null;
  const strength = 1 - fade / flash.fadeMs;
  const channel = (shift: number) => Math.round(255 - (255 - ((flash.color >> shift) & 0xff)) * strength);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

// Procedure 9 in a lasting area's kit rains models over it, as the client
// does: its first parameter is the row of
// SpellVisualKitAreaModel that falls (served as effect/area-<row>.glb), its
// second how many fall a second, at the client's default effect level.
const RAIN_PROCEDURE = 9;
const DEFAULT_RAIN_RATE = 5;
// Each model starts up to this long after it is spawned.
export const RAIN_MAX_DELAY_MS = 510;
// Ground art drawn at the models' own size looked a little too large next to
// the client (the user's eye on Consecration, Flamestrike, Death and Decay,
// and Blizzard), so area-kit models are scaled by this.
export const AREA_ART_SCALE = 0.75;

export interface AreaRain {
  model: number;
  rate: number;
}

// What a spell's lasting area rains, or null for nothing.
export function areaRain(visual: SpellVisual): AreaRain | null {
  const proc = visual.kits.persistentArea?.procs?.find((candidate) => candidate.code === RAIN_PROCEDURE);
  if (!proc) return null;
  return { model: Math.max(0, Math.round(proc.params[0])), rate: proc.params[1] > 0 ? proc.params[1] : DEFAULT_RAIN_RATE };
}

// Where a falling model aims, from two random numbers in [0, 1): as the
// client, a random way out from `center` and a random share of `radius`,
// so more land near the middle.
export function rainPoint(center: Point3, radius: number, a: number, b: number): Point3 {
  const distance = radius * a;
  const angle = b * Math.PI * 2;
  return [center[0] + Math.cos(angle) * distance, center[1] + Math.sin(angle) * distance, center[2]];
}
