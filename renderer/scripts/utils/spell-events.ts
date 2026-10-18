import type { StreamAuraCategory, StreamCombatEvent, StreamCombatEventUpdate } from '../../../src/types/api';

import { LIVE_RENDER_DELAY_MS } from './live-positions';

// Turns the live combat events into short-lived effects to draw: glows in a
// caster's hands, projectiles, beams, impact flashes, area rings, aura tints,
// and floating numbers, plus cues that start attack animations. Events play
// on the same delayed clock as positions, so effects line up with the
// interpolated units. Nothing here knows where units are: effects name units
// by key ('p<guid>' or 'c<guid>', as the model layer does), and whoever draws
// them skips any whose units aren't shown.

export type UnitKey = string;
export type Point3 = [number, number, number];

export const unitKey = (guid: number, creature: boolean): UnitKey => `${creature ? 'c' : 'p'}${guid}`;

export interface CastGlow {
  caster: UnitKey;
  spellId: number;
  schoolMask: number;
  color: string;
  startAt: number;
  endAt: number;
  // A short flash as a spell is released, rather than a held cast.
  release: boolean;
  // A channel, held for its duration, rather than a cast before release.
  channeled: boolean;
  // Whether WoWMin's own glow draws it. The client's cast art plays for
  // every cast as it fires, a weapon strike's or a proc's too; the glow
  // only for spells cast on purpose.
  glow: boolean;
}

export interface Projectile {
  source: UnitKey;
  target: UnitKey;
  spellId: number;
  schoolMask: number;
  color: string;
  startAt: number;
  travelMs: number;
  // The spell's missile speed (yards a second; 0 for none).
  missileSpeed: number;
  // Instant spells without a missile get a quick streak instead.
  streak: boolean;
  // Arrows and bullets: small and pale.
  physical: boolean;
}

// A channelled spell's beam from caster to target.
export interface Beam {
  source: UnitKey;
  target: UnitKey;
  spellId: number;
  color: string;
  startAt: number;
  endAt: number;
}

export interface Impact {
  // Who cast it: on the caster, the client plays the spell's caster impact.
  source: UnitKey;
  target: UnitKey;
  // 0 for a white hit.
  spellId: number;
  schoolMask: number;
  color: string;
  at: number;
  heal: boolean;
  // Periodic ticks flash smaller.
  small: boolean;
  // Whether the client's impact art plays for it: not for periodic ticks,
  // nor for a hit whose cast's landing already played it.
  kit: boolean;
  // Whether WoWMin's own glow draws it: not for a cast's landing (a buff),
  // only for hits.
  glow: boolean;
}

export interface AreaRing {
  caster: UnitKey;
  spellId: number;
  channeled: boolean;
  // The spell's ground point, or null to centre on the caster.
  point: Point3 | null;
  radius: number;
  color: string;
  startAt: number;
  endAt: number;
}

// A spell's area on the ground, for the client's area art: where, how wide,
// and how long it lasts (a channel's or a lasting area's duration; 0 for an
// instant burst).
export interface AreaEffect {
  caster: UnitKey;
  spellId: number;
  // The spell's ground point, or null to centre on the caster.
  point: Point3 | null;
  radius: number;
  startAt: number;
  endAt: number;
  channeled: boolean;
  // The spell's missile speed (yards a second; 0 for none): an impact area
  // waits for the missile to reach the ground point.
  missileSpeed: number;
}

// One link of a spell's chain: from the caster to its target (index 0), or
// from one target on to the next it jumped to (Chain Heal, Chain Lightning),
// or a channel's, held from the caster to its target until it ends (`endAt`:
// Drain Life).
export interface ChainLink {
  spellId: number;
  caster: UnitKey;
  from: UnitKey;
  to: UnitKey;
  index: number;
  startAt: number;
  endAt?: number;
}

export interface CombatNumber {
  target: UnitKey;
  amount: number;
  color: string;
  heal: boolean;
  periodic: boolean;
  at: number;
}

export type StrikeKind = 'melee' | 'ranged' | 'cast';

export interface StrikeCue {
  unit: UnitKey;
  kind: StrikeKind;
}

export const NUMBER_LIFETIME_MS = 1200;
export const IMPACT_LIFETIME_MS = 450;
export const RELEASE_FLASH_MS = 250;
export const STREAK_MS = 180;
export const AREA_FLASH_MS = 900;
// A unit that has had a real swing or cast this recently no longer gets the
// made-up timed strikes.
export const EVENT_DRIVEN_MS = 5000;
// A held cast stays lit a little past its cast time, in case the "fired"
// event is late.
export const CAST_GRACE_MS = 400;
const MIN_TRAVEL_MS = 120;
// Wider than this, an area is raid- or zone-wide (boss auras, party buffs),
// and a ring would cover the whole view.
export const MAX_RING_RADIUS = 30;
const MAX_TRAVEL_MS = 3000;
// Auras the server never says have ended (lost datagrams) go after this.
const AURA_MAX_MS = 10 * 60 * 1000;
const MAX_NUMBERS = 200;
const MAX_IMPACTS = 200;
const MAX_PROJECTILES = 150;
// A hit by a spell this close to its cast's own landing on the same unit is
// that landing, so it doesn't play the spell's impact again.
export const IMPACT_MATCH_MS = 600;
// Hits of a spell this soon after its cast are its chain's jumps; links are
// kept this long after their chain began, for whoever draws them.
export const CHAIN_JUMP_MS = 1000;
export const CHAIN_LINK_MS = 3000;
const MAX_CHAIN_LINKS = 100;
const RATE_WINDOW_MS = 2000;

// Auto Shot, Shoot (bow, gun, crossbow, wand), and Throw.
const RANGED_ATTACK_SPELLS = new Set([75, 2480, 3018, 5019, 7918, 7919, 2764]);

// School bits, most telling first: a fire-and-frost spell reads as frost.
const SCHOOL_COLORS: Array<[number, string]> = [
  [64, '#f0abfc'], // arcane
  [32, '#a855f7'], // shadow
  [16, '#7dd3fc'], // frost
  [8, '#4ade80'], // nature
  [4, '#fb923c'], // fire
  [2, '#fde68a'], // holy
  [1, '#f1f5f9'], // physical
];
export const HEAL_COLOR = '#4ade80';
const UNKNOWN_SCHOOL_COLOR = '#f1f5f9';

export function schoolColor(schoolMask: number): string {
  return SCHOOL_COLORS.find(([bit]) => schoolMask & bit)?.[1] ?? UNKNOWN_SCHOOL_COLOR;
}

export const isPhysicalOnly = (schoolMask: number): boolean => schoolMask === 1;

// Tint colours for notable auras, strongest first when a unit has several.
const AURA_TINTS: Array<[StreamAuraCategory, string]> = [
  ['crowdControl', '#a78bfa'],
  ['shield', '#fde047'],
  ['defensive', '#60a5fa'],
  ['offensive', '#f87171'],
];

export function auraTintColor(category: StreamAuraCategory): string {
  return AURA_TINTS.find(([candidate]) => candidate === category)?.[1] ?? '#ffffff';
}

// Which attack animation a fired spell plays, if any: ranged attacks shoot,
// physical strikes (Mortal Strike and the like) swing, and the rest cast.
export function getCastStrikeKind(event: StreamCombatEvent): StrikeKind | null {
  if (event.triggered) return null;
  const physical = isPhysicalOnly(event.schoolMask);
  if (RANGED_ATTACK_SPELLS.has(event.spellId)) return 'ranged';
  if (physical && !event.helpful && event.missileSpeed > 0) return 'ranged';
  if (physical) {
    const atSomeoneElse = event.targetGuid !== 0
      && (event.targetGuid !== event.sourceGuid || event.targetCreature !== event.sourceCreature);
    return !event.helpful && atSomeoneElse ? 'melee' : null;
  }
  return 'cast';
}

export function getTravelMs(distance: number, missileSpeed: number): number {
  if (missileSpeed <= 0) return STREAK_MS;
  return Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, (distance / missileSpeed) * 1000));
}

interface QueuedEvent {
  event: StreamCombatEvent;
  at: number;
}

// A cast whose later hits may be chain jumps: where it has reached, and the
// units it has been to.
interface OpenChain {
  source: UnitKey;
  spellId: number;
  last: UnitKey;
  visited: Set<UnitKey>;
  at: number;
}

interface ActiveAura {
  target: UnitKey;
  spellId: number;
  category: StreamAuraCategory;
  endAt: number;
}

export class CombatEffectStore {
  private queue: QueuedEvent[] = [];
  private castList: CastGlow[] = [];
  private projectileList: Projectile[] = [];
  private beamList: Beam[] = [];
  private impactList: Impact[] = [];
  private ringList: AreaRing[] = [];
  private areaList: AreaEffect[] = [];
  private numberList: CombatNumber[] = [];
  private chainList: ChainLink[] = [];
  private openChains: OpenChain[] = [];
  private readonly auras = new Map<string, ActiveAura>();
  private readonly lastStrikeAt = new Map<UnitKey, number>();
  private readonly arrivals: number[] = [];
  private droppedTotal = 0;

  // Queues an update's events to play LIVE_RENDER_DELAY_MS after they
  // happened, as positions do.
  push(update: StreamCombatEventUpdate, receivedAt: number): void {
    this.droppedTotal += update.dropped;
    for (const event of update.events) {
      this.queue.push({ event, at: receivedAt - event.ageMs + LIVE_RENDER_DELAY_MS });
      this.arrivals.push(receivedAt);
    }
    this.queue.sort((left, right) => left.at - right.at);
  }

  clear(): void {
    this.queue = [];
    this.castList = [];
    this.projectileList = [];
    this.beamList = [];
    this.impactList = [];
    this.ringList = [];
    this.areaList = [];
    this.numberList = [];
    this.chainList = [];
    this.openChains = [];
    this.auras.clear();
    this.lastStrikeAt.clear();
    this.arrivals.length = 0;
    this.droppedTotal = 0;
  }

  // Plays the events now due and drops finished effects. `distance` gives
  // the yards between two units, or null if either isn't known, for missile
  // travel times. Returns the attack animations to start.
  advance(now: number, distance: (from: UnitKey, to: UnitKey) => number | null): StrikeCue[] {
    const cues: StrikeCue[] = [];
    let due = 0;
    while (due < this.queue.length && this.queue[due].at <= now) {
      const { event, at } = this.queue[due];
      const cue = this.apply(event, at, distance);
      if (cue) cues.push(cue);
      due += 1;
    }
    if (due) this.queue.splice(0, due);
    this.prune(now);
    return cues;
  }

  get casts(): readonly CastGlow[] { return this.castList; }
  get projectiles(): readonly Projectile[] { return this.projectileList; }
  get beams(): readonly Beam[] { return this.beamList; }
  get impacts(): readonly Impact[] { return this.impactList; }
  get rings(): readonly AreaRing[] { return this.ringList; }
  get areas(): readonly AreaEffect[] { return this.areaList; }
  get numbers(): readonly CombatNumber[] { return this.numberList; }
  get chains(): readonly ChainLink[] { return this.chainList; }
  get dropped(): number { return this.droppedTotal; }

  // Whether anything is still to play or on screen, so the view keeps drawing.
  get active(): boolean {
    return Boolean(this.queue.length || this.castList.length || this.projectileList.length || this.beamList.length
      || this.impactList.length || this.ringList.length || this.areaList.length || this.numberList.length || this.chainList.length);
  }

  // Events received over the last couple of seconds, per second.
  eventsPerSecond(now: number): number {
    while (this.arrivals.length && this.arrivals[0] < now - RATE_WINDOW_MS) this.arrivals.shift();
    return this.arrivals.length / (RATE_WINDOW_MS / 1000);
  }

  // The tint colour for a unit's strongest notable aura, or null. Auras
  // `shownAsArt` says the client's art already shows are left out.
  tint(unit: UnitKey, shownAsArt: (spellId: number) => boolean = () => false): string | null {
    let best: number | null = null;
    for (const aura of this.auras.values()) {
      if (aura.target !== unit || shownAsArt(aura.spellId)) continue;
      const rank = AURA_TINTS.findIndex(([category]) => category === aura.category);
      if (rank >= 0 && (best === null || rank < best)) best = rank;
    }
    return best === null ? null : AURA_TINTS[best][1];
  }

  // Units with a notable aura, with its tint colour.
  tints(): Map<UnitKey, string> {
    const tints = new Map<UnitKey, string>();
    for (const aura of this.auras.values()) {
      if (!tints.has(aura.target)) tints.set(aura.target, this.tint(aura.target)!);
    }
    return tints;
  }

  // Whether the unit's attacks have recently come from real events.
  isEventDriven(unit: UnitKey, now: number): boolean {
    const at = this.lastStrikeAt.get(unit);
    return at !== undefined && now - at < EVENT_DRIVEN_MS;
  }

  private apply(
    event: StreamCombatEvent,
    at: number,
    distance: (from: UnitKey, to: UnitKey) => number | null,
  ): StrikeCue | null {
    const source = unitKey(event.sourceGuid, event.sourceCreature);
    const target = event.targetGuid ? unitKey(event.targetGuid, event.targetCreature) : null;
    const color = schoolColor(event.schoolMask);
    switch (event.kind) {
      case 'castStart':
        this.endCast(source);
        this.castList.push({
          caster: source, spellId: event.spellId, schoolMask: event.schoolMask, color, startAt: at, endAt: at + event.value + CAST_GRACE_MS,
          release: false, channeled: false, glow: true,
        });
        return null;
      case 'castCancel':
        this.endCast(source);
        this.beamList = this.beamList.filter((beam) => beam.source !== source || beam.spellId !== event.spellId);
        // A cancelled channel's area ends with it; a lasting area stays.
        this.areaList = this.areaList.filter((area) => !area.channeled || area.caster !== source || area.spellId !== event.spellId);
        this.ringList = this.ringList.filter((ring) => !ring.channeled || ring.caster !== source || ring.spellId !== event.spellId);
        this.chainList = this.chainList.filter((link) => link.endAt === undefined || link.caster !== source || link.spellId !== event.spellId);
        return null;
      case 'castGo':
        return this.applyCastGo(event, source, target, color, at, distance);
      case 'auraApply':
        if (target && event.auraCategory) {
          this.auras.set(`${target}:${event.spellId}`, {
            target, spellId: event.spellId, category: event.auraCategory,
            endAt: at + (event.value > 0 ? event.value : AURA_MAX_MS),
          });
        }
        return null;
      case 'auraRemove':
        if (target) this.auras.delete(`${target}:${event.spellId}`);
        return null;
      case 'swing':
        if (!event.sourceGuid) return null;
        this.lastStrikeAt.set(source, at);
        return { unit: source, kind: 'melee' };
      case 'damage':
      case 'heal': {
        if (!target) return null;
        const heal = event.kind === 'heal';
        const numberColor = heal ? HEAL_COLOR : color;
        this.numberList.push({ target, amount: event.value, color: numberColor, heal, periodic: event.periodic, at });
        // White hits already show as the swing; a hit its cast's landing
        // already played keeps only the glow.
        if (heal || event.spellId) {
          const landed = event.spellId !== 0 && this.impactList.some((impact) => !impact.glow && impact.spellId === event.spellId
            && impact.target === target && Math.abs(impact.at - at) <= IMPACT_MATCH_MS);
          this.impactList.push({
            source, target, spellId: event.spellId, schoolMask: event.schoolMask, color: numberColor, at, heal, small: event.periodic,
            kit: !event.periodic && !landed, glow: true,
          });
        }
        if (event.spellId && !event.periodic) this.jumpChain(source, target, event.spellId, at);
        return null;
      }
      default:
        return null;
    }
  }

  private applyCastGo(
    event: StreamCombatEvent,
    source: UnitKey,
    target: UnitKey | null,
    color: string,
    at: number,
    distance: (from: UnitKey, to: UnitKey) => number | null,
  ): StrikeCue | null {
    this.endCast(source);
    const physical = isPhysicalOnly(event.schoolMask);
    const atOther = target !== null && target !== source;
    const glow = !event.triggered && !physical;
    if (glow && event.channeled && event.value > 0) {
      this.castList.push({
        caster: source, spellId: event.spellId, schoolMask: event.schoolMask, color, startAt: at, endAt: at + event.value,
        release: false, channeled: true, glow,
      });
      if (atOther) {
        this.beamList.push({ source, target: target!, spellId: event.spellId, color, startAt: at, endAt: at + event.value });
      }
    } else if (!event.channeled) {
      this.castList.push({
        caster: source, spellId: event.spellId, schoolMask: event.schoolMask, color, startAt: at, endAt: at + RELEASE_FLASH_MS,
        release: true, channeled: false, glow,
      });
    }
    // Triggered spells (procs, a channel's bolts) fly only with a real missile.
    const flies = event.triggered ? event.missileSpeed > 0 : !physical || event.missileSpeed > 0;
    let travelMs = 0;
    if (atOther && !event.channeled && flies) {
      const yards = distance(source, target!);
      if (yards !== null) {
        travelMs = getTravelMs(yards, event.missileSpeed);
        this.projectileList.push({
          source, target: target!, spellId: event.spellId, schoolMask: event.schoolMask, color, startAt: at,
          travelMs, missileSpeed: event.missileSpeed, streak: event.missileSpeed <= 0, physical,
        });
      }
    }
    // A helpful spell lands on its target when it arrives, amount or not (a
    // buff); its heal, if any, then plays no second impact. Harmful ones
    // wait for their hit, since a miss lands nothing.
    if (event.helpful && target && !event.channeled && event.spellId) {
      this.impactList.push({
        source, target, spellId: event.spellId, schoolMask: event.schoolMask, color: HEAL_COLOR,
        at: at + (event.missileSpeed > 0 ? travelMs : 0), heal: true, small: false, kit: true, glow: false,
      });
    }
    // Buffs and heals reach the party; only harmful areas get a ring.
    if (event.area && !event.helpful && event.radius > 0 && event.radius <= MAX_RING_RADIUS) {
      this.ringList.push({
        caster: source, spellId: event.spellId, channeled: event.channeled, point: event.point, radius: event.radius, color,
        startAt: at, endAt: at + (event.channeled && event.value > 0 ? event.value : AREA_FLASH_MS),
      });
    }
    // Every area, for the client's area art (which draws helpful ones too).
    if (event.area || event.persistentArea) {
      const lasts = (event.channeled || event.persistentArea) && event.value > 0;
      this.areaList.push({
        caster: source, spellId: event.spellId, point: event.point, radius: event.radius, startAt: at,
        endAt: at + (lasts ? event.value : 0), channeled: event.channeled, missileSpeed: event.missileSpeed,
      });
    }
    // A chain starts at the caster's target; its spell's hits that follow are
    // its jumps.
    if (atOther && !event.channeled) {
      this.openChains = this.openChains.filter((chain) => chain.source !== source || chain.spellId !== event.spellId);
      this.openChains.push({ source, spellId: event.spellId, last: target!, visited: new Set([target!]), at });
      this.chainList.push({ spellId: event.spellId, caster: source, from: source, to: target!, index: 0, startAt: at });
    } else if (atOther && event.value > 0) {
      this.chainList.push({ spellId: event.spellId, caster: source, from: source, to: target!, index: 0, startAt: at, endAt: at + event.value });
    }
    const kind = getCastStrikeKind(event);
    if (!kind) return null;
    this.lastStrikeAt.set(source, at);
    return { unit: source, kind };
  }

  // A hit by a chain's spell on a unit it hasn't been to is its next jump.
  private jumpChain(source: UnitKey, target: UnitKey, spellId: number, at: number): void {
    const chain = this.openChains.find((open) => open.source === source && open.spellId === spellId);
    if (!chain || at - chain.at > CHAIN_JUMP_MS || chain.visited.has(target)) return;
    chain.visited.add(target);
    this.chainList.push({ spellId, caster: source, from: chain.last, to: target, index: chain.visited.size - 1, startAt: chain.at });
    chain.last = target;
  }

  private endCast(caster: UnitKey): void {
    this.castList = this.castList.filter((cast) => cast.caster !== caster || cast.release);
  }

  private prune(now: number): void {
    this.castList = this.castList.filter((cast) => cast.endAt > now);
    this.projectileList = this.projectileList
      .filter((projectile) => projectile.startAt + projectile.travelMs > now).slice(-MAX_PROJECTILES);
    this.beamList = this.beamList.filter((beam) => beam.endAt > now);
    this.impactList = this.impactList.filter((impact) => impact.at + IMPACT_LIFETIME_MS > now).slice(-MAX_IMPACTS);
    this.ringList = this.ringList.filter((ring) => ring.endAt > now);
    // Instant areas stay a moment, so the layer sees them.
    this.areaList = this.areaList.filter((area) => Math.max(area.endAt, area.startAt + AREA_FLASH_MS) > now);
    this.numberList = this.numberList.filter((number) => number.at + NUMBER_LIFETIME_MS > now).slice(-MAX_NUMBERS);
    this.chainList = this.chainList.filter((link) => (link.endAt ?? link.startAt + CHAIN_LINK_MS) > now).slice(-MAX_CHAIN_LINKS);
    this.openChains = this.openChains.filter((chain) => now - chain.at <= CHAIN_JUMP_MS);
    for (const [key, aura] of this.auras) if (aura.endAt <= now) this.auras.delete(key);
    for (const [unit, at] of this.lastStrikeAt) if (now - at >= EVENT_DRIVEN_MS) this.lastStrikeAt.delete(unit);
  }
}
