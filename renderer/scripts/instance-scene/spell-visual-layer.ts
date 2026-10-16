import { type Camera, Group, Quaternion } from 'three';

import {
  type AreaEffect, type AreaRing, type Beam, type CastGlow, type ChainLink, type CombatEffectStore, type Impact, type Point3, type Projectile,
  schoolColor, type UnitKey,
} from '../utils/spell-events';
import { type ChainDraw, ChainLightning } from './chain-ribbons';
import { useServerAxes } from './iso-camera';
import { EffectInstance, type EffectPlacement, type EffectTemplate, EffectTemplateCache, type EffectView, getEffectView, type MissileClips } from './m2-effect';
import { type FlightFrame, MissileFlight } from '../utils/missile-flight';
import { WeaponTrails } from './weapon-trails';
import type { UnitAnchor } from './spell-effects';
import type { UnitLook } from './unit-models';
import {
  AREA_ART_SCALE, areaRain, artForSchool, castKit, type ColorFlash, DEFAULT_ALPHA_FADE_MS, DIRECTED_HAND_ATTACHMENT, flashColor, groundSlot,
  attachOffset, attachTurn, CREATURE_SPELL_ATTACKABLE, type EffectScales, fadeAlpha, limitScale, unitEffectScale, kitAlpha, kitClips, kitColor, kitColorFlash, kitFade, kitFreeze, kitWeaponTrail, KIT_WAITS_FOR_BOLT,
  MISSILE_HEIGHT_SHARE, missileAttachment, missileOffset, type ProceduralFade, RAIN_MAX_DELAY_MS, rainPoint,
  slotAttachment, type SpellVisual, type UnitAnchorRole, type VisualKit, type VisualMissile, type VisualPoints,
} from '../utils/spell-kits';

// Plays the client's own spell art (level 2) for the combat effect store's
// casts, missiles, and impacts, from the spell's SpellVisual kits: precast
// effects on the caster while casting, channel effects while channelling,
// cast effects as it fires, the missile model in flight, and impact effects
// on the target. It also says which animations the kits name, for the unit
// models. Spells without art, or whose art is still loading, are left to the
// level 1 glows (SpellEffectLayer), which asks `handles` first.

// What the layer needs to know about units and the scene: where a point on
// a unit is, by role (estimated when its model lacks it) or by the model's
// own attachment or release event (null when the model lacks it), whether
// the unit is drawn as its model, its overall scale, standing height
// (yards), and which way it faces; and where a falling model lands.
export interface UnitInfo {
  anchor: UnitAnchor;
  attachment: (unit: UnitKey, attachment: number | string, offset?: Point3) => Point3 | null;
  isDrawn: (unit: UnitKey) => boolean;
  scale: (unit: UnitKey) => number;
  height: (unit: UnitKey) => number;
  facing: (unit: UnitKey) => number;
  // The ground under `target`, searched from `center` (the area's middle),
  // or `center` if there is none.
  ground: (center: Point3, target: Point3) => Point3;
  // When (ms in) a drawn unit's clip lets a spell's missile go, or null.
  releaseMs: (unit: UnitKey, clip: string) => number | null;
  // Where a segment first meets the ground or a building, as a share of its
  // length, or null.
  intersect: (from: Point3, to: Point3) => number | null;
  // A drawn unit's blades (bottom, top) of the weapons it holds drawn.
  blades: (unit: UnitKey) => Array<[Point3, Point3]>;
  // A creature's creature_template type_flags (0 for players).
  creatureTypeFlags: (unit: UnitKey) => number;
  // Which way a drawn unit's attachment is turned (world, three.js axes),
  // or null.
  attachmentTurn: (unit: UnitKey, attachment: number) => Quaternion | null;
  // How the client sizes spell effects on a drawn unit's model, or null.
  effectScales: (unit: UnitKey) => EffectScales | null;
}

// A missile waits at most this long for its caster's animation to let it go.
const MAX_RELEASE_WAIT_MS = 2000;
// A missile following the ground with this flag keeps its height over the
// target's feet rather than aiming at its point.
const FOLLOW_TARGET_HEIGHT = 0x8;
// Without the visual's landing point, a missile lands at the chest, else
// the base, where the model has them.
const MISSILE_LANDING_FALLBACKS = [15, 19];
// A missile that never reaches its target (it fled, say) is ended this long
// past when the spell landed.
const MISSILE_OVERRUN_MS = 2000;

// A missile being played: when it is let go, its copies (a motion script
// can fly several), and its targeting art on the target while they fly.
interface PlayingMissile {
  releaseAt: number;
  copies: Array<{ flight: MissileFlight; effect: PlayingEffect; frame: FlightFrame | null }> | null;
  targeting: PlayingEffect[];
}

// Kit slots onto WowMin's estimated points, for units not drawn as models.
function slotRole(slot: string): UnitAnchorRole {
  switch (slot) {
    case 'head': return 'head';
    case 'breath': return 'breath';
    case 'base': case 'world': return 'feet';
    case 'leftHand': case 'leftWeapon': return 'handLeft';
    case 'rightHand': case 'rightWeapon': return 'handRight';
    default: return 'chest';
  }
}

// The release events a missile leaves from when its visual names no point:
// the hand or weapon the cast animation throws from.
const RELEASE_EVENTS = ['$CSR', '$CSL', '$CST'];

// `offset` turned to face `yaw`, from `origin`.
function offsetFrom(origin: Point3, offset: Point3, yaw: number, up = 0): Point3 {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [origin[0] + offset[0] * cos - offset[1] * sin, origin[1] + offset[0] * sin + offset[1] * cos, origin[2] + offset[2] + up];
}

// Animations a unit should play for its spells: a loop while casting or
// channelling, and a one-off as a spell fires or lands or a cast begins;
// each the clips to try, in order.
export interface KitAnimation {
  loop: string[] | null;
  once: string[] | null;
}

interface PlayingEffect {
  instance: EffectInstance;
  // Where it is this frame, or null to stay where it was.
  place: (now: number) => EffectPlacement | null;
  // When it stops emitting (ms, delayed clock); null to stop when told.
  stopAt: number | null;
  last: EffectPlacement | null;
}

// A steady area round a unit while an aura lasts (Starfall's reach), drawn
// on the floor by the scene's own shaders.
export interface BearerAreaCircle {
  unit: UnitKey;
  radius: number;
  color: string;
}

// Global particle budget: past it, emitters stop spawning until room frees.
const PARTICLE_BUDGET = 4000;
const DEGREES = Math.PI / 180;
const layerQuaternion = new Quaternion();
// The release event a chain leaves its caster from when its visual names no
// point.
const CHAIN_RELEASE_EVENT = '$CSL';

export class SpellVisualLayer {
  readonly group = new Group();
  private readonly visuals = new Map<number, SpellVisual | null | 'loading'>();
  private readonly templates: EffectTemplateCache;
  private readonly playing: PlayingEffect[] = [];
  private readonly missiles = new Map<Projectile, PlayingMissile>();
  private readonly casts = new Map<CastGlow, { kit: VisualKit; effects: PlayingEffect[]; startedAt: number; harmful: boolean }>();
  private readonly seenImpacts = new WeakSet<Impact>();
  // Areas being played: their lasting effects, and what they rain.
  // An impact area kit waits for the missile to reach the ground point.
  private readonly areas = new Map<AreaEffect, {
    lasting: PlayingEffect[];
    rain: { template: EffectTemplate; rate: number; carry: number; center: Point3; shards: Array<{ at: number; position: Point3 }> } | null;
    impactAt: number | null;
  }>();
  // Each unit's art auras as last seen, to tell when one ends (state done).
  private lastAuras = new Map<UnitKey, ReadonlySet<number>>();
  private lastUpdateAt = 0;
  // Aura art on units, by unit and state kit: its effects, and the pose it
  // names (an aura's pose wins over a cast's: a stunned unit isn't casting).
  private readonly states = new Map<string, { unit: UnitKey; kit: VisualKit; effects: PlayingEffect[]; startedAt: number; harmful: boolean }>();
  // Colour flashes kits have started on units (kit procedure 13).
  private readonly flashes = new Map<UnitKey, { flash: ColorFlash; startAt: number }>();
  // Units' see-through amounts as they fade (kit procedure 14), and when
  // each was last stepped.
  private readonly alphas = new Map<UnitKey, { alpha: number; fadeMs: number; at: number }>();
  private readonly onceAnimations = new Map<UnitKey, string[]>();
  private particleCount = 0;
  // This frame's units. Effects that follow a unit read it every frame, so
  // they keep up with it (each frame brings new positions).
  private units: UnitInfo = {
    anchor: () => null, attachment: () => null, isDrawn: () => false, scale: () => 1, height: () => 2, facing: () => 0, ground: (center) => center,
    releaseMs: () => null, intersect: () => null, blades: () => [], creatureTypeFlags: () => 0, attachmentTurn: () => null,
    effectScales: () => null,
  };
  private readonly chains: ChainLightning;
  private readonly trails = new WeaponTrails();
  // Units' procedural fades (kit procedure 15), from when each began.
  private readonly fades = new Map<UnitKey, { fade: ProceduralFade; startAt: number }>();
  // Spells that auras with a bearer area cast (Starfall's 30 yard search),
  // whose own rings the steady area replaces.
  private readonly bearerTriggers = new Set<number>();

  constructor(private readonly onLoaded: () => void) {
    this.templates = new EffectTemplateCache(onLoaded, 'spell effect');
    this.chains = new ChainLightning(onLoaded);
    this.group.add(this.chains.group, this.trails.group);
    useServerAxes(this.group);
  }

  get count(): number {
    return this.playing.length + this.chains.count + this.trails.count;
  }

  get particles(): number {
    return this.particleCount;
  }

  // Whether the client's art decides how the store entry looks, so level 1
  // should not draw it: anything this layer plays, and anything of a spell
  // with art, even a stage it has no art for (Holy Light has no missile, so
  // nothing flies). Spells without art, or still loading, keep level 1.
  // A ring of a spell an aura with a bearer area casts gives way to that
  // area.
  handles(entry: Projectile | Impact | CastGlow | AreaRing | Beam): boolean {
    const playing = 'travelMs' in entry ? this.missiles.has(entry)
      : 'radius' in entry || 'source' in entry ? false
        : 'caster' in entry ? this.casts.has(entry) : this.seenImpacts.has(entry);
    if (playing) return true;
    if ('radius' in entry && this.bearerTriggers.has(entry.spellId)) return true;
    const visual = entry.spellId ? this.visuals.get(entry.spellId) : null;
    if (typeof visual !== 'object' || visual === null) return false;
    return 'schoolMask' in entry ? artForSchool(visual, entry.schoolMask) !== null : true;
  }

  // Steady areas round units whose auras keep casting an area spell round
  // them (Starfall), in the spell's school colour.
  bearerAreas(auras: ReadonlyMap<UnitKey, readonly number[]>): BearerAreaCircle[] {
    const areas: BearerAreaCircle[] = [];
    for (const [unit, spellIds] of auras) {
      for (const spellId of spellIds) {
        const area = this.visual(spellId)?.bearerArea;
        if (area) areas.push({ unit, radius: area.radius, color: schoolColor(area.schoolMask) });
      }
    }
    return areas;
  }

  // Whether an aura's spell shows client art on the unit, so its level 1
  // halo should give way. False while its art is loading.
  hasAuraArt(spellId: number): boolean {
    const visual = this.visuals.get(spellId);
    return typeof visual === 'object' && visual !== null && Boolean(visual.kits.state?.effects.length);
  }

  // How each unit's model looks now, as the client changes it: its colour
  // a flash while one lasts, else the newest playing kit's that has one (a
  // harmful spell's skipping creatures flagged so); its see-through amount
  // the newest playing kit's, faded to over that kit's time (and back to
  // opaque over the default), times any procedural fade; and its animation
  // held still while a kit freezes it. Units left out look as their models
  // do.
  unitLooks(now: number): Map<UnitKey, UnitLook> {
    const colors = new Map<UnitKey, { color: number; since: number }>();
    const targets = new Map<UnitKey, { alpha: number; fadeMs: number; since: number }>();
    const freezes = new Map<UnitKey, { atSeconds: number | null; since: number }>();
    const consider = (unit: UnitKey, kit: VisualKit, since: number, harmful: boolean) => {
      const color = kitColor(kit);
      if (color !== null && !this.colorSkips(unit, harmful) && since >= (colors.get(unit)?.since ?? -Infinity)) colors.set(unit, { color, since });
      const alpha = kitAlpha(kit);
      if (alpha && since >= (targets.get(unit)?.since ?? -Infinity)) targets.set(unit, { ...alpha, since });
      const freeze = kitFreeze(kit);
      if (freeze && since >= (freezes.get(unit)?.since ?? -Infinity)) freezes.set(unit, { ...freeze, since });
    };
    for (const { unit, kit, startedAt, harmful } of this.states.values()) consider(unit, kit, startedAt, harmful);
    for (const [cast, { kit, startedAt, harmful }] of this.casts) if (!cast.release) consider(cast.caster, kit, startedAt, harmful);
    const looks = new Map<UnitKey, UnitLook>();
    const look = (unit: UnitKey): UnitLook => {
      let entry = looks.get(unit);
      if (!entry) looks.set(unit, entry = { color: null, alpha: 1 });
      return entry;
    };
    for (const [unit, { color }] of colors) look(unit).color = color;
    for (const [unit, { flash, startAt }] of this.flashes) {
      const color = flashColor(flash, now - startAt);
      if (color === null) this.flashes.delete(unit);
      else look(unit).color = color;
    }
    for (const unit of new Set([...targets.keys(), ...this.alphas.keys()])) {
      const target = targets.get(unit);
      const current = this.alphas.get(unit) ?? { alpha: 1, fadeMs: DEFAULT_ALPHA_FADE_MS, at: now };
      const goal = target?.alpha ?? 1;
      const fadeMs = target?.fadeMs ?? DEFAULT_ALPHA_FADE_MS;
      const step = (now - current.at) / fadeMs;
      const alpha = goal < current.alpha ? Math.max(goal, current.alpha - step) : Math.min(goal, current.alpha + step);
      if (!target && alpha >= 1) {
        this.alphas.delete(unit);
        continue;
      }
      this.alphas.set(unit, { alpha, fadeMs, at: now });
      look(unit).alpha = alpha;
    }
    for (const [unit, { fade, startAt }] of this.fades) {
      const alpha = fadeAlpha(fade, now - startAt);
      if (alpha === null) this.fades.delete(unit);
      else look(unit).alpha *= alpha;
    }
    for (const [unit, { atSeconds }] of freezes) look(unit).freeze = { atSeconds };
    return looks;
  }

  // Whether the client leaves a spell's colours off a unit: a harmful
  // spell's, on a creature flagged so.
  private colorSkips(unit: UnitKey, harmful: boolean): boolean {
    return harmful && Boolean(this.units.creatureTypeFlags(unit) & CREATURE_SPELL_ATTACKABLE);
  }

  // The animations kits ask of each unit now; one-offs are handed out once.
  takeAnimations(): Map<UnitKey, KitAnimation> {
    const animations = new Map<UnitKey, KitAnimation>();
    for (const [cast, { kit }] of this.casts) {
      if (cast.release) continue;
      const loop = kitClips(kit);
      if (loop) animations.set(cast.caster, { loop, once: null });
    }
    for (const { unit, kit } of this.states.values()) {
      const loop = kitClips(kit);
      if (loop) animations.set(unit, { loop, once: null });
    }
    for (const [unit, once] of this.onceAnimations) {
      animations.set(unit, { loop: animations.get(unit)?.loop ?? null, once });
    }
    this.onceAnimations.clear();
    return animations;
  }

  // `auras` lists each unit's art auras (spell IDs), from the live stream.
  update(store: CombatEffectStore | null, now: number, units: UnitInfo, camera: Camera,
    auras: ReadonlyMap<UnitKey, readonly number[]> = new Map()): void {
    this.units = units;
    const castsNow = new Set(store?.casts ?? []);
    const areasNow = new Set(store?.areas ?? []);
    const seconds = this.lastUpdateAt ? Math.min(0.1, Math.max(0, (now - this.lastUpdateAt) / 1000)) : 0;
    this.lastUpdateAt = now;
    if (store) {
      for (const area of store.areas) this.startArea(area, now, units);
      for (const cast of store.casts) this.startCast(cast, now);
      for (const projectile of store.projectiles) this.startMissile(projectile, now);
      for (const impact of store.impacts) this.startImpact(impact, now, store.chains);
    }
    this.syncStates(store ? auras : new Map(), now, units);
    // Casts the store has ended: held effects stop; release flashes play out.
    for (const [cast, { effects }] of this.casts) {
      if (castsNow.has(cast)) continue;
      if (!cast.release) for (const effect of effects) effect.instance.stop();
      this.casts.delete(cast);
    }
    // Areas: an impact area once its missile lands; rain while they last,
    // the models already falling finishing after. When they end, lasting
    // effects end too.
    for (const [area, playing] of this.areas) {
      if (playing.impactAt !== null && now >= playing.impactAt) {
        playing.impactAt = null;
        const visual = this.visual(area.spellId);
        if (visual?.kits.impactArea) this.playGroundKit(visual.kits.impactArea, area, now);
      }
      const rain = playing.rain;
      if (rain) {
        if (now < area.endAt) {
          rain.carry += rain.rate * seconds;
          for (; rain.carry >= 1; rain.carry -= 1) {
            const target = rainPoint(rain.center, area.radius, Math.random(), Math.random());
            rain.shards.push({ at: now + 2 * Math.floor(Math.random() * (RAIN_MAX_DELAY_MS / 2)), position: this.units.ground(rain.center, target) });
          }
        }
        rain.shards = rain.shards.filter(({ at, position }) => {
          if (now < at) return true;
          const shard = this.play(rain.template, now, false, () => ({ position, yaw: 0, scale: 1 }));
          shard.stopAt = now + shard.instance.duration;
          return false;
        });
      }
      if (!areasNow.has(area) || now >= area.endAt) {
        for (const effect of playing.lasting) effect.instance.stop(now);
        playing.lasting = [];
        if (rain && !rain.shards.length) playing.rain = null;
        if (!areasNow.has(area) && !playing.rain && playing.impactAt === null) this.areas.delete(area);
      }
    }
    // Missiles: let go when their caster's animation does, then flown
    // until each copy lands; their targeting art ends as the last does.
    for (const [projectile, missile] of this.missiles) {
      if (!missile.copies && store && now >= missile.releaseAt) this.launchMissile(projectile, missile, now);
      const overrun = now >= projectile.startAt + projectile.travelMs + MISSILE_OVERRUN_MS;
      const landed = missile.copies?.every(({ frame }) => frame?.arrived) ?? false;
      if (!store || overrun || landed || (!missile.copies && now >= missile.releaseAt)) {
        for (const { effect } of missile.copies ?? []) effect.instance.stop(now);
        for (const playing of missile.targeting) playing.instance.stop(now);
        this.missiles.delete(projectile);
      }
    }

    // Effects bring their own nodes up to date; the scene view does the rest.
    this.group.updateWorldMatrix(true, false);
    const view = getEffectView(camera, this.group);
    this.updateChains(store?.chains ?? [], now, view, seconds);
    this.trails.update(now, this.units.blades);
    const budget = { left: PARTICLE_BUDGET };
    for (let index = this.playing.length - 1; index >= 0; index -= 1) {
      const effect = this.playing[index];
      if (effect.stopAt !== null && now >= effect.stopAt && !effect.instance.stopped) effect.instance.stop(now);
      const placement = effect.place(now) ?? effect.last;
      if (placement) {
        effect.last = placement;
        effect.instance.update(now, placement, view, this.group, budget);
      }
      if (effect.instance.done || (!placement && effect.instance.stopped)) {
        effect.instance.dispose();
        this.playing.splice(index, 1);
      }
    }
    this.particleCount = PARTICLE_BUDGET - budget.left;
  }

  private visual(spellId: number): SpellVisual | null | undefined {
    if (!spellId) return null;
    const known = this.visuals.get(spellId);
    if (known === 'loading') return undefined;
    if (known !== undefined) return known;
    this.visuals.set(spellId, 'loading');
    fetch(`assets/models/visual/${spellId}.json`)
      .then((response) => (response.ok ? response.json() as Promise<SpellVisual> : null))
      .catch(() => null)
      .then((visual) => {
        this.visuals.set(spellId, visual);
        for (const art of visual ? [visual, ...Object.values(visual.bySchool ?? {})] : []) {
          if (art.missile) this.template(art.missile.id);
          for (const kit of Object.values(art.kits)) kit?.effects.forEach((effect) => this.template(effect.id));
          const rain = areaRain(art);
          if (rain) this.areaTemplate(rain.model);
        }
        for (const trigger of visual?.bearerArea?.triggers ?? []) this.bearerTriggers.add(trigger);
        this.onLoaded();
      });
    return undefined;
  }

  // The art a cast of this school plays: as visual(), but null for a spell
  // with art by school that has none for this one.
  private art(spellId: number, schoolMask: number): SpellVisual | null | undefined {
    const visual = this.visual(spellId);
    return visual ? artForSchool(visual, schoolMask) : visual;
  }

  // Each chain link as the client times it: a bolt of each of its chain's
  // effects, the first link after the effect's delay and each later one
  // its link delay after the one before, for the effect's segment time; a
  // lasting chain (a channel's) from the start until its link ends. The
  // first link, or with `reverse` every link, leaves the caster; the rest
  // leave the last target.
  private updateChains(links: readonly ChainLink[], now: number, view: EffectView, seconds: number): void {
    const draws: ChainDraw[] = [];
    for (const link of links) {
      const chain = this.visual(link.spellId)?.chain;
      if (!chain) continue;
      const fromCaster = link.index === 0 || chain.reverse;
      chain.effects.forEach((effect, index) => {
        const lasting = chain.persist && link.endAt !== undefined;
        const showAt = lasting ? link.startAt : link.startAt + effect.delayMs + link.index * effect.linkDelayMs;
        const endAt = lasting ? link.endAt! : showAt + effect.segmentMs;
        if (now < showAt || now >= endAt) return;
        const from = fromCaster ? this.boltSource(chain.points, link.caster) : this.landingPoint(chain.points, link.from);
        const to = this.landingPoint(chain.points, link.to);
        if (from && to) draws.push({ key: link, index, chain: effect, from, to });
      });
    }
    this.chains.update(draws, view, seconds);
  }

  // Where a chain leaves its caster, as the client picks it: the visual's
  // point and offset when the model has that point, else the offset from
  // where the cast animation throws from with the left hand, else the
  // offset from three quarters up the caster.
  private boltSource(points: VisualPoints, caster: UnitKey): Point3 | null {
    const feet = this.units.anchor(caster, 'feet');
    if (!feet) return null;
    const offset = missileOffset(points.castOffset);
    const height = this.units.height(caster) * MISSILE_HEIGHT_SHARE;
    if (!this.units.isDrawn(caster)) return [feet[0], feet[1], feet[2] + height];
    const point = missileAttachment(points.attachment, points.rawAttachments);
    return (point !== null && this.units.attachment(caster, point, offset))
      || this.units.attachment(caster, CHAIN_RELEASE_EVENT, offset)
      || offsetFrom(feet, offset, this.units.facing(caster), height);
  }

  private template(effectId: number): EffectTemplate | null | undefined {
    return this.templates.get(`assets/models/effect/${effectId}.glb`);
  }

  // A model a lasting area rains (a SpellVisualKitAreaModel row).
  private areaTemplate(row: number): EffectTemplate | null | undefined {
    return this.templates.get(`assets/models/effect/area-${row}.glb`);
  }

  // The kit's templates once all are in (null for any that failed), or
  // undefined while some are loading, so a kit plays together.
  private kitTemplates(kit: VisualKit): Array<EffectTemplate | null> | undefined {
    const templates = kit.effects.map((effect) => this.template(effect.id));
    return templates.some((template) => template === undefined) ? undefined : templates as Array<EffectTemplate | null>;
  }

  private play(template: EffectTemplate, now: number, loop: boolean, place: PlayingEffect['place'], missile: MissileClips | null = null,
    birth = false): PlayingEffect {
    const instance = new EffectInstance(template, now, loop, missile, birth);
    this.group.add(instance.root, instance.particles);
    const effect: PlayingEffect = { instance, place, stopAt: null, last: null };
    this.playing.push(effect);
    return effect;
  }

  // Each of a kit's effects on its body slot of `unit`, following it, and
  // any colour flash it starts there. A slot the unit's model lacks shows
  // nothing, as in the client; a unit not drawn as a model shows each at
  // WowMin's estimate. The world effect stands at the unit's feet, and
  // follows it only for a spell that roots it. A kit's procedures start
  // here too: a colour flash, a weapon trail, a procedural fade.
  private playKit(kit: VisualKit, templates: Array<EffectTemplate | null>, unit: UnitKey, now: number, loop: boolean,
    art: SpellVisual | null = null): PlayingEffect[] {
    const follows = Boolean(art?.rootsUnit);
    const flash = kitColorFlash(kit);
    if (flash && !this.colorSkips(unit, Boolean(art?.harmful))) this.flashes.set(unit, { flash, startAt: now });
    const trail = kitWeaponTrail(kit);
    if (trail) this.trails.start(unit, trail, now);
    const fade = kitFade(kit);
    if (fade) this.fades.set(unit, { fade, startAt: now });
    const drawn = this.units.isDrawn(unit);
    return kit.effects.flatMap((effect, index) => {
      const template = templates[index];
      if (!template) return [];
      // A model attachment sits on its raw M2 attachment, offset in its
      // frame, or (-1) stands at the feet, offset the way the unit faces.
      const attached = effect.slot === 'attach';
      const attachment = attached ? (effect.attachment !== undefined && effect.attachment >= 0 ? effect.attachment : null) : slotAttachment(effect.slot);
      const offset: Point3 = attached ? attachOffset(effect) : [0, 0, 0];
      const turn = attached ? attachTurn(effect) : null;
      if (drawn && attachment !== null && !this.units.attachment(unit, attachment, offset)) return [];
      const atFeet = () => {
        const feet = this.units.anchor(unit, 'feet');
        return feet && offsetFrom(feet, offset, this.units.facing(unit));
      };
      let fixed: Point3 | null = null;
      if (attachment === null && !follows) fixed = atFeet();
      const playing = this.play(template, now, loop, () => {
        const onModel = attachment !== null && this.units.isDrawn(unit);
        const point = fixed ?? (attachment === null ? atFeet() : onModel
          ? this.units.attachment(unit, attachment, offset) : this.units.anchor(unit, slotRole(effect.slot)));
        // Riding on an attachment, it turns with it, as the client's does.
        const quaternion = onModel ? this.layerTurn(this.units.attachmentTurn(unit, attachment!)) : null;
        const scale = unitEffectScale(effect, this.units.scale(unit), this.units.effectScales(unit), attachment === null);
        return point ? { position: point, yaw: this.units.facing(unit), quaternion, turn, scale } : null;
      });
      if (!loop) playing.stopAt = now + playing.instance.duration;
      return [playing];
    });
  }

  // A world turn (three.js axes) as a turn in this layer, or null.
  private layerTurn(world: Quaternion | null): [number, number, number, number] | null {
    if (!world) return null;
    const turn = this.group.getWorldQuaternion(layerQuaternion).invert().multiply(world);
    return [turn.x, turn.y, turn.z, turn.w];
  }

  // An area kit at its ground point, as the client plays one there: its
  // world and base effects at the point, its head effect on the caster.
  // Lasting effects (`loop`) are returned so they can end with the area.
  private playGroundKit(kit: VisualKit, area: AreaEffect, now: number, loop = false): PlayingEffect[] {
    const templates = this.kitTemplates(kit);
    const center = area.point ?? this.units.anchor(area.caster, 'feet');
    if (!templates || !center) return [];
    const yaw = this.units.facing(area.caster);
    return kit.effects.flatMap((effect, index) => {
      const template = templates[index];
      const where = groundSlot(effect.slot);
      if (!template || !where) return [];
      if (where === 'caster') return this.playKit({ ...kit, effects: [effect], procs: [] }, [template], area.caster, now, loop);
      const attached = effect.slot === 'attach';
      const position = attached ? offsetFrom(center, attachOffset(effect), yaw) : center;
      const turn = attached ? attachTurn(effect) : null;
      const playing = this.play(template, now, loop, () => ({ position, yaw, turn, scale: limitScale(effect.scale, effect) }));
      if (!loop) playing.stopAt = now + playing.instance.duration;
      return [playing];
    });
  }

  private startCast(cast: CastGlow, now: number): void {
    if (this.casts.has(cast) || now < cast.startAt) return;
    const art = this.art(cast.spellId, cast.schoolMask);
    const kit = art ? castKit(art, cast) : undefined;
    if (!kit) return;
    const templates = this.kitTemplates(kit);
    if (!templates) return;
    this.casts.set(cast, {
      kit, effects: this.playKit(kit, templates, cast.caster, now, !cast.release, art), startedAt: now, harmful: Boolean(art?.harmful),
    });
    // A cast plays its kit's animation once as it fires; a cast beginning
    // plays its start animation once before holding its loop.
    const once = cast.release ? kitClips(kit) : !cast.channeled && kit.startClips?.length ? kit.startClips : null;
    if (once) this.onceAnimations.set(cast.caster, once);
  }

  // Plays each shown unit's aura art and colour (its spells' state kits,
  // once per kit), ending art for auras that have gone with its Death, and
  // playing a gone aura's state done kit once. A unit whose list went
  // (stale, or no longer shown) ends its art without one.
  private syncStates(auras: ReadonlyMap<UnitKey, readonly number[]>, now: number, units: UnitInfo): void {
    const wanted = new Map<string, { unit: UnitKey; kit: VisualKit; visual: SpellVisual }>();
    for (const [unit, spellIds] of auras) {
      if (!units.anchor(unit, 'feet')) continue;
      for (const spellId of spellIds) {
        const visual = this.visual(spellId);
        const kit = visual?.kits.state;
        if (!kit || (!kit.effects.length && kit.anim < 0 && !kit.procs?.length)) continue;
        const key = `${unit}|${kit.id}`;
        if (!wanted.has(key)) wanted.set(key, { unit, kit, visual });
      }
    }
    for (const [key, state] of this.states) {
      if (wanted.has(key)) continue;
      for (const effect of state.effects) effect.instance.stop(now);
      this.states.delete(key);
    }
    for (const [key, { unit, kit, visual }] of wanted) {
      if (this.states.has(key)) continue;
      const templates = this.kitTemplates(kit);
      if (!templates) continue;
      this.states.set(key, {
        unit, kit, effects: this.playKit(kit, templates, unit, now, true, visual), startedAt: now, harmful: Boolean(visual.harmful),
      });
    }
    const seen = new Map<UnitKey, ReadonlySet<number>>();
    for (const [unit, spellIds] of auras) {
      const current = new Set(spellIds);
      seen.set(unit, current);
      const before = this.lastAuras.get(unit);
      if (!before || !units.anchor(unit, 'feet')) continue;
      for (const spellId of before) {
        if (current.has(spellId)) continue;
        const visual = this.visual(spellId);
        const kit = visual?.kits.stateDone;
        const templates = kit && this.kitTemplates(kit);
        if (kit && templates) this.playKit(kit, templates, unit, now, false, visual);
      }
    }
    this.lastAuras = seen;
  }

  // A spell's area art. At a ground point: the instant area kit as the
  // spell is cast, and the impact area kit once its missile reaches the
  // point (at once without one), unless its visual has a chain. A lasting
  // area (a channel's, or a lasting area's) draws its own model, the
  // persistent area kit's world effect or else its base one, at the point
  // or round the caster, and rains what that kit names.
  private startArea(area: AreaEffect, now: number, units: UnitInfo): void {
    if (this.areas.has(area) || now < area.startAt) return;
    const visual = this.visual(area.spellId);
    if (visual === undefined) return;
    if (visual === null) {
      this.areas.set(area, { lasting: [], rain: null, impactAt: null });
      return;
    }
    const lasting = visual.kits.persistentArea;
    const rain = area.endAt > area.startAt ? areaRain(visual) : null;
    // Wait until every model is in, so the area plays together.
    const kits = [visual.kits.instantArea, visual.kits.impactArea, lasting].filter((kit): kit is VisualKit => Boolean(kit));
    const rainTemplate = rain ? this.areaTemplate(rain.model) : null;
    if (kits.some((kit) => !this.kitTemplates(kit)) || rainTemplate === undefined) return;
    const center = area.point ?? units.anchor(area.caster, 'feet');
    if (!center) return;
    let impactAt: number | null = null;
    if (area.point) {
      if (visual.kits.instantArea) this.playGroundKit(visual.kits.instantArea, area, now);
      if (visual.kits.impactArea && !visual.chainEffect) {
        const feet = units.anchor(area.caster, 'feet');
        const yards = feet ? Math.hypot(feet[0] - center[0], feet[1] - center[1], feet[2] - center[2]) : 0;
        impactAt = area.startAt + (area.missileSpeed > 0 ? (yards / area.missileSpeed) * 1000 : 0);
      }
    }
    const lasts = area.endAt > area.startAt;
    let lastingEffects: PlayingEffect[] = [];
    if (lasting) {
      const effect = lasting.effects.find((candidate) => candidate.slot === 'world') ?? lasting.effects.find((candidate) => candidate.slot === 'base');
      const template = effect ? this.kitTemplates(lasting)![lasting.effects.indexOf(effect)] : null;
      if (effect && template) {
        const yaw = units.facing(area.caster);
        // It plays its Birth first, as the client's lasting area does.
        const playing = this.play(template, now, lasts, () => ({ position: center, yaw, scale: effect.scale * AREA_ART_SCALE }), null, true);
        if (lasts) lastingEffects = [playing];
        else playing.stopAt = now + playing.instance.duration;
      }
    }
    this.areas.set(area, {
      lasting: lastingEffects,
      rain: rain && rainTemplate ? { template: rainTemplate, rate: rain.rate, carry: 0, center, shards: [] } : null,
      impactAt,
    });
  }

  // Where a missile leaves its caster, as the client picks it: the visual's
  // point and offset when the model has that point; with no point but an
  // offset, the offset from the directed spell hand, or from the feet; else
  // where the cast animation throws from, or three quarters up the caster.
  private firePoint(missile: VisualMissile, caster: UnitKey): Point3 | null {
    const feet = this.units.anchor(caster, 'feet');
    if (!feet) return null;
    const offset = missileOffset(missile.castOffset);
    const drawn = this.units.isDrawn(caster);
    const point = missileAttachment(missile.attachment, missile.rawAttachments);
    if (drawn && point !== null) {
      const at = this.units.attachment(caster, point, offset);
      if (at) return at;
    } else if (point === null && offset.some((value) => value !== 0)) {
      return (drawn && this.units.attachment(caster, DIRECTED_HAND_ATTACHMENT, offset))
        || offsetFrom(feet, offset, this.units.facing(caster));
    }
    if (drawn) {
      for (const event of RELEASE_EVENTS) {
        const at = this.units.attachment(caster, event);
        if (at) return at;
      }
    }
    return [feet[0], feet[1], feet[2] + this.units.height(caster) * MISSILE_HEIGHT_SHARE];
  }

  // Where a missile or chain lands on its target: the visual's point and
  // offset when the model has that point (for a missile, else its chest or
  // base), else the offset from three quarters up it.
  private landingPoint(points: VisualPoints, target: UnitKey, fallbacks: number[] = []): Point3 | null {
    const offset = missileOffset(points.impactOffset);
    const point = missileAttachment(points.destinationAttachment, points.rawAttachments);
    if (point !== null && this.units.isDrawn(target)) {
      for (const candidate of [point, ...fallbacks]) {
        const at = this.units.attachment(target, candidate, offset);
        if (at) return at;
      }
    }
    const feet = this.units.anchor(target, 'feet');
    return feet && offsetFrom(feet, offset, this.units.facing(target), this.units.height(target) * MISSILE_HEIGHT_SHARE);
  }

  // A spell's missile, as the client flies it: none for a spell without
  // speed (it lands at once); let go when the caster's cast animation lets
  // it go (at most two seconds on), or at once; see launchMissile.
  private startMissile(projectile: Projectile, now: number): void {
    if (this.missiles.has(projectile) || now < projectile.startAt || projectile.streak) return;
    const art = this.art(projectile.spellId, projectile.schoolMask);
    const missile = art?.missile;
    if (!missile || !this.template(missile.id)) return;
    let releaseAt = projectile.startAt;
    const clips = missile.waitsForRelease ? kitClips(art.kits.cast) ?? [] : [];
    const releaseMs = clips.map((clip) => this.units.releaseMs(projectile.source, clip)).find((ms) => ms !== null) ?? null;
    if (releaseMs !== null) releaseAt += Math.min(MAX_RELEASE_WAIT_MS, releaseMs);
    this.missiles.set(projectile, { releaseAt, copies: null, targeting: [] });
  }

  // Lets a missile go from where its caster releases it: a copy for each
  // its motion script flies, each looping its flight clip at its speed and
  // playing its impact clip as it lands; and the targeting art on the
  // target while they fly.
  private launchMissile(projectile: Projectile, playing: PlayingMissile, now: number): void {
    const art = this.art(projectile.spellId, projectile.schoolMask);
    const missile = art?.missile;
    const template = missile ? this.template(missile.id) : null;
    const launch = missile ? this.firePoint(missile, projectile.source) : null;
    const casterAt = this.units.anchor(projectile.source, 'feet');
    const target = missile ? this.missileTarget(missile, projectile.target) : null;
    if (!art || !missile || !template || !launch || !casterAt || !target) {
      playing.copies = [];
      return;
    }
    const count = missile.motion?.count ?? 1;
    const flyMs = template.effect.clips?.Fly;
    playing.copies = Array.from({ length: count }, (_, index) => {
      const flight = new MissileFlight({
        launch, casterAt, releaseAt: now, castAt: projectile.startAt, arriveAt: projectile.startAt + projectile.travelMs,
        speed: projectile.speed,
        index, count, spellId: projectile.spellId, motion: missile.motion, followGround: missile.followGround, trajectory: missile.trajectory,
        intersect: this.units.intersect,
      }, target);
      const clips: MissileClips = { rate: flyMs && flight.initialYards > 0 ? (flyMs * flight.currentSpeed * 0.001) / flight.initialYards : 1 };
      const copy = { flight, effect: null as unknown as PlayingEffect, frame: null as FlightFrame | null };
      copy.effect = this.play(template, now, true, (time) => {
        const to = this.missileTarget(missile, projectile.target);
        if (!to) return null;
        const frame = copy.frame?.arrived ? copy.frame : flight.step(time, to);
        copy.frame = frame;
        if (frame.arrived) copy.effect.instance.stop(time);
        const [x, y, z] = frame.forward;
        const position = frame.arrived ? to : frame.position;
        return {
          position, yaw: Math.atan2(y, x), pitch: Math.atan2(z, Math.hypot(x, y)), scale: missile.scale * frame.scale,
          turn: frame.turn && { yaw: frame.turn.yaw * DEGREES, pitch: frame.turn.pitch * DEGREES, roll: frame.turn.roll * DEGREES },
        };
      }, clips);
      return copy;
    });
    const targetingKit = art.kits.missileTargeting;
    const targetingTemplates = targetingKit ? this.kitTemplates(targetingKit) : null;
    if (targetingKit && targetingTemplates) playing.targeting = this.playKit(targetingKit, targetingTemplates, projectile.target, now, true, art);
  }

  // Where a missile aims on its target this frame; one following the
  // ground with that flag keeps its height over the target's feet.
  private missileTarget(missile: VisualMissile, target: UnitKey): Point3 | null {
    const point = this.landingPoint(missile, target, MISSILE_LANDING_FALLBACKS);
    const follow = missile.followGround;
    if (!point || !follow || !(follow.flags & FOLLOW_TARGET_HEIGHT)) return point;
    const feet = this.units.anchor(target, 'feet');
    return feet ? [point[0], point[1], feet[2] + follow.height] : point;
  }

  // A spell landing on a unit: on its caster the caster impact kit, on
  // anyone else the target impact kit, else the impact kit. A kit that
  // waits for its chain's bolt plays when the bolt to the unit appears.
  private startImpact(impact: Impact, now: number, links: readonly ChainLink[]): void {
    if (this.seenImpacts.has(impact) || now < impact.at || !impact.kit) return;
    const art = this.art(impact.spellId, impact.schoolMask);
    const own = impact.target === impact.source ? art?.kits.casterImpact : art?.kits.targetImpact;
    const kit = own ?? art?.kits.impact;
    if (!kit) return;
    if (kit.flags && kit.flags & KIT_WAITS_FOR_BOLT && art?.chain) {
      const effect = art.chain.effects[0];
      const link = links.find((candidate) => candidate.spellId === impact.spellId && candidate.to === impact.target);
      if (effect && link && now < link.startAt + effect.delayMs + link.index * effect.linkDelayMs) return;
    }
    const templates = this.kitTemplates(kit);
    if (!templates) return;
    this.seenImpacts.add(impact);
    this.playKit(kit, templates, impact.target, now, false, art);
    const once = kitClips(kit);
    if (once) this.onceAnimations.set(impact.target, once);
  }
}
