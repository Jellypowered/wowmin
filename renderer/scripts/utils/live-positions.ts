import type {
  MapPlayerPosition, StreamAppearance, StreamAppearanceUpdate, StreamBotDecision, StreamBotUpdate, StreamCreatureSample, StreamCreatureUpdate, StreamFrame,
  StreamDebuffUpdate, StreamGameObject, StreamGameObjectUpdate, StreamMarker, StreamMarkerUpdate, StreamPassenger, StreamPassengerUpdate, StreamPath, StreamPathUpdate, StreamPlayerSample, StreamUnitAuraUpdate,
} from '../../../src/types/api';

// Buffers stream samples per player and interpolates between them, drawing a
// little in the past so there is always a newer sample to move towards.

export const LIVE_RENDER_DELAY_MS = 150;
// Samples older than this no longer describe the player; use the polled data.
export const LIVE_STALE_MS = 2000;
// Movement larger than this between two samples is a teleport: snap, not slide.
const TELEPORT_DISTANCE = 50;
const HISTORY_LENGTH = 4;

interface Positioned {
  x: number;
  y: number;
  z: number;
  orientation: number;
}

interface TimedSample<T extends Positioned = StreamPlayerSample> {
  at: number;
  sample: T;
}

export function lerpAngle(from: number, to: number, t: number): number {
  const turn = Math.PI * 2;
  let delta = (to - from) % turn;
  if (delta > Math.PI) delta -= turn;
  if (delta < -Math.PI) delta += turn;
  return from + delta * t;
}

// The state at `now - LIVE_RENDER_DELAY_MS`, interpolated between the samples
// either side of it.
function sampleHistory<T extends Positioned>(samples: TimedSample<T>[], now: number): T {
  const time = now - LIVE_RENDER_DELAY_MS;
  const next = samples.findIndex((entry) => entry.at >= time);
  if (next === -1) return samples[samples.length - 1].sample;
  if (next === 0) return samples[0].sample;
  const before = samples[next - 1];
  const after = samples[next];
  const { sample: from } = before;
  const { sample: to } = after;
  if (Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) > TELEPORT_DISTANCE) return to;
  const t = after.at === before.at ? 1 : (time - before.at) / (after.at - before.at);
  return {
    ...to,
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
    orientation: lerpAngle(from.orientation, to.orientation, t),
  };
}

export class LivePositionBuffer {
  private readonly history = new Map<string, TimedSample[]>();
  private lastFrameAt = -Infinity;

  push(frame: StreamFrame, receivedAt: number): void {
    this.lastFrameAt = receivedAt;
    for (const sample of frame.players) {
      const samples = this.history.get(sample.name) ?? [];
      samples.push({ at: receivedAt, sample });
      if (samples.length > HISTORY_LENGTH) samples.shift();
      this.history.set(sample.name, samples);
    }
    for (const [name, samples] of this.history) {
      if (receivedAt - samples[samples.length - 1].at > LIVE_STALE_MS) this.history.delete(name);
    }
  }

  clear(): void {
    this.history.clear();
    this.lastFrameAt = -Infinity;
  }

  // True while frames are still arriving, i.e. worth animating.
  isActive(now: number): boolean {
    return now - this.lastFrameAt <= LIVE_STALE_MS;
  }

  // The player's guid from their latest sample, or null if not streamed.
  guidOf(name: string): number | null {
    const samples = this.history.get(name);
    return samples?.length ? samples[samples.length - 1].sample.guid : null;
  }

  // The name of the streamed player with this guid, or null.
  nameOf(guid: number): string | null {
    for (const [name, samples] of this.history) {
      if (samples[samples.length - 1].sample.guid === guid) return name;
    }
    return null;
  }

  // The player's state at `now - LIVE_RENDER_DELAY_MS`, or null if the stream
  // has nothing recent for them.
  sampleAt(name: string, now: number): StreamPlayerSample | null {
    const samples = this.history.get(name);
    if (!samples?.length || now - samples[samples.length - 1].at > LIVE_STALE_MS) return null;
    return sampleHistory(samples, now);
  }

  // Every player in the latest live frame. This also recovers playerbots that
  // the character-database fallback cannot reliably report as online.
  samples(now: number): StreamPlayerSample[] {
    const current: StreamPlayerSample[] = [];
    for (const [name, samples] of this.history) {
      if (!samples.length || now - samples[samples.length - 1].at > LIVE_STALE_MS) {
        this.history.delete(name);
      } else {
        current.push(sampleHistory(samples, now));
      }
    }
    return current;
  }
}

// Idle creatures are re-sent once a second; one missing for longer than this
// has despawned.
export const LIVE_CREATURE_STALE_MS = 3500;

// Buffers creature samples per guid and interpolates them like players.
export class LiveCreatureBuffer {
  private readonly history = new Map<number, TimedSample<StreamCreatureSample>[]>();

  push(update: StreamCreatureUpdate, receivedAt: number): void {
    for (const sample of update.creatures) {
      const samples = this.history.get(sample.guid) ?? [];
      samples.push({ at: receivedAt, sample });
      if (samples.length > HISTORY_LENGTH) samples.shift();
      this.history.set(sample.guid, samples);
    }
  }

  clear(): void {
    this.history.clear();
  }

  // The creature's latest sample, or null if it is not being streamed.
  latest(guid: number): StreamCreatureSample | null {
    const samples = this.history.get(guid);
    return samples?.length ? samples[samples.length - 1].sample : null;
  }

  samples(now: number): StreamCreatureSample[] {
    const current: StreamCreatureSample[] = [];
    for (const [guid, samples] of this.history) {
      if (now - samples[samples.length - 1].at > LIVE_CREATURE_STALE_MS) this.history.delete(guid);
      else current.push(sampleHistory(samples, now));
    }
    return current;
  }
}

// Overlays the stream's fast-changing fields on a polled player record; names,
// classes, groups, and the rest stay as polled.
export function applyLiveSample(player: MapPlayerPosition, sample: StreamPlayerSample): MapPlayerPosition {
  return {
    ...player,
    position_x: sample.x,
    position_y: sample.y,
    position_z: sample.z,
    orientation: sample.orientation,
    healthPct: sample.healthPct,
    powerPct: sample.powerPct,
    alive: sample.alive,
    inCombat: sample.inCombat,
    waitingForResurrect: sample.waitingForResurrect,
    roleMask: sample.roleMask ?? player.roleMask,
    wmoGroupId: sample.wmoGroupId,
    onTaxi: (sample.stateFlags & 1) !== 0,
    mounted: (sample.stateFlags & 2) !== 0,
    sapped: (sample.stateFlags & 4) !== 0,
    stunned: (sample.stateFlags & 8) !== 0,
    spiritForm: (sample.stateFlags & 16) !== 0,
    flagCarrier: (sample.stateFlags & 32) !== 0,
    flying: (sample.stateFlags & 64) !== 0,
    sitting: (sample.stateFlags & 128) !== 0,
  };
}

// A path not re-sent for this long is gone (the module refreshes every second).
export const LIVE_PATH_STALE_MS = 2500;

// Store key for a creature's path; players' paths are keyed by name.
export const creaturePathKey = (guid: number): string => `#${guid}`;

// Latest movement path per player name or creature (creaturePathKey).
export class LivePathStore {
  private readonly paths = new Map<string, { at: number; path: StreamPath }>();

  push(update: StreamPathUpdate, receivedAt: number): void {
    for (const path of update.paths) {
      const key = path.creature ? creaturePathKey(path.guid) : path.name;
      if (path.points.length) this.paths.set(key, { at: receivedAt, path });
      else this.paths.delete(key);
    }
  }

  clear(): void {
    this.paths.clear();
  }

  get(key: string, now: number): StreamPath | null {
    const entry = this.paths.get(key);
    if (!entry) return null;
    if (now - entry.at > LIVE_PATH_STALE_MS) {
      this.paths.delete(key);
      return null;
    }
    return entry.path;
  }
}

type Point3 = [number, number, number];

function distanceToSegment(point: Point3, start: Point3, end: Point3): number {
  const segment = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const lengthSquared = segment[0] ** 2 + segment[1] ** 2 + segment[2] ** 2;
  const t = lengthSquared
    ? Math.max(0, Math.min(1, ((point[0] - start[0]) * segment[0] + (point[1] - start[1]) * segment[1]
      + (point[2] - start[2]) * segment[2]) / lengthSquared))
    : 0;
  return Math.hypot(
    point[0] - (start[0] + segment[0] * t),
    point[1] - (start[1] + segment[1] * t),
    point[2] - (start[2] + segment[2] * t),
  );
}

// A bot's decisions are dropped after this long without an update; the module
// re-sends them every second.
export const LIVE_BOT_STALE_MS = 3500;

// The latest decisions per bot name, with ages brought up to date on read.
export class LiveBotStore {
  private readonly bots = new Map<string, { at: number; bot: StreamBotDecision }>();

  push(update: StreamBotUpdate, receivedAt: number): void {
    for (const bot of update.bots) this.bots.set(bot.name, { at: receivedAt, bot });
  }

  clear(): void {
    this.bots.clear();
  }

  get size(): number {
    return this.bots.size;
  }

  get(name: string, now: number): StreamBotDecision | null {
    const entry = this.bots.get(name);
    if (!entry) return null;
    const elapsed = now - entry.at;
    if (elapsed > LIVE_BOT_STALE_MS) {
      this.bots.delete(name);
      return null;
    }
    if (elapsed <= 0) return entry.bot;
    const { bot } = entry;
    return {
      ...bot,
      moveTarget: bot.moveTarget && { ...bot.moveTarget, ageMs: bot.moveTarget.ageMs + elapsed },
      actions: bot.actions.map((action) => ({ ...action, ageMs: action.ageMs + elapsed })),
    };
  }
}

// The waypoints still ahead of `position`. Paths arrive up to a second apart,
// so drop the points the player has walked past since: if the player is
// nearer a later segment than the first waypoint, everything before that
// segment's end is behind them.
export function trimPathToPosition(points: Point3[], position: Point3): Point3[] {
  if (points.length < 2) return points;
  let start = 0;
  let best = Math.hypot(position[0] - points[0][0], position[1] - points[0][1], position[2] - points[0][2]);
  for (let index = 0; index < points.length - 1; index += 1) {
    const distance = distanceToSegment(position, points[index], points[index + 1]);
    if (distance < best - 1e-6) {
      best = distance;
      start = index + 1;
    }
  }
  return points.slice(start);
}

// How each unit looks; the module re-sends every 5 s, so one not heard from
// for this long has gone.
export const LIVE_APPEARANCE_STALE_MS = 15_000;

export class LiveAppearanceStore {
  private readonly appearances = new Map<string, { at: number; appearance: StreamAppearance }>();

  push(update: StreamAppearanceUpdate, receivedAt: number): void {
    for (const appearance of update.units) {
      this.appearances.set(`${appearance.creature ? 'c' : 'p'}${appearance.guid}`, { at: receivedAt, appearance });
    }
  }

  clear(): void {
    this.appearances.clear();
  }

  get size(): number {
    return this.appearances.size;
  }

  get(creature: boolean, guid: number, now: number): StreamAppearance | null {
    const key = `${creature ? 'c' : 'p'}${guid}`;
    const entry = this.appearances.get(key);
    if (!entry) return null;
    if (now - entry.at > LIVE_APPEARANCE_STALE_MS) {
      this.appearances.delete(key);
      return null;
    }
    return entry.appearance;
  }
}

// A unit's art auras are resent every 5 s while it has any; past this
// without word, they are dropped.
export const LIVE_AURA_STALE_MS = 12_000;

// The auras with spell art each unit wears, by unit key ('p<guid>' or
// 'c<guid>'), from the module's unit aura lists.
export class LiveAuraStore {
  private readonly auras = new Map<string, { at: number; spellIds: number[] }>();

  push(update: StreamUnitAuraUpdate, receivedAt: number): void {
    for (const unit of update.units) {
      const key = `${unit.creature ? 'c' : 'p'}${unit.guid}`;
      if (unit.spellIds.length) this.auras.set(key, { at: receivedAt, spellIds: unit.spellIds });
      else this.auras.delete(key);
    }
  }

  clear(): void {
    this.auras.clear();
  }

  // Every unit's current art auras, dropping stale ones.
  all(now: number): Map<string, number[]> {
    const current = new Map<string, number[]>();
    for (const [key, entry] of this.auras) {
      if (now - entry.at > LIVE_AURA_STALE_MS) this.auras.delete(key);
      else current.set(key, entry.spellIds);
    }
    return current;
  }
}

// A unit's debuffs are re-sent every 3 s while it has any; past this without
// word, they're dropped.
export const LIVE_DEBUFF_STALE_MS = 10_000;

export interface LiveDebuff {
  spellId: number;
  // Time left now; null when it lasts until removed.
  remainingMs: number | null;
  stacks: number;
  fromPlayer: boolean;
}

// The harmful auras on each unit, by unit key ('p<guid>' or 'c<guid>'),
// counting down from when each list arrived.
export class LiveDebuffStore {
  private readonly units = new Map<string, { at: number; update: StreamDebuffUpdate['units'][number] }>();

  push(update: StreamDebuffUpdate, receivedAt: number): void {
    for (const unit of update.units) {
      const key = `${unit.creature ? 'c' : 'p'}${unit.guid}`;
      if (unit.debuffs.length) this.units.set(key, { at: receivedAt, update: unit });
      else this.units.delete(key);
    }
  }

  clear(): void {
    this.units.clear();
  }

  get(key: string, now: number): LiveDebuff[] {
    const entry = this.units.get(key);
    if (!entry) return [];
    if (now - entry.at > LIVE_DEBUFF_STALE_MS) {
      this.units.delete(key);
      return [];
    }
    return entry.update.debuffs.flatMap((debuff): LiveDebuff[] => {
      if (!debuff.remainingMs) return [{ spellId: debuff.spellId, remainingMs: null, stacks: debuff.stacks, fromPlayer: debuff.fromPlayer }];
      const remainingMs = debuff.remainingMs - (now - entry.at);
      return remainingMs > 0 ? [{ spellId: debuff.spellId, remainingMs, stacks: debuff.stacks, fromPlayer: debuff.fromPlayer }] : [];
    });
  }
}

// Raid markers are re-sent every 2 s while any are set; past this without
// word, they're dropped.
export const LIVE_MARKER_STALE_MS = 6000;

// The raid marker on each unit, by unit key.
export class LiveMarkerStore {
  private markers = new Map<string, number>();
  private at = 0;

  push(update: StreamMarkerUpdate, receivedAt: number): void {
    this.markers = new Map(update.markers.map((marker: StreamMarker) => [`${marker.creature ? 'c' : 'p'}${marker.guid}`, marker.icon]));
    this.at = receivedAt;
  }

  clear(): void {
    this.markers.clear();
  }

  get(key: string, now: number): number | null {
    if (now - this.at > LIVE_MARKER_STALE_MS) this.markers.clear();
    return this.markers.get(key) ?? null;
  }
}

// Game objects are re-sent every 10 s; past this without word, one is gone.
export const LIVE_GAMEOBJECT_STALE_MS = 35_000;

// The spawned game objects with models, by guid; despawned ones are dropped
// as the module says they've gone.
export class LiveGameObjectStore {
  private readonly objects = new Map<number, { at: number; object: StreamGameObject }>();

  push(update: StreamGameObjectUpdate, receivedAt: number): void {
    for (const object of update.objects) {
      if (object.gone) this.objects.delete(object.guid);
      else this.objects.set(object.guid, { at: receivedAt, object });
    }
  }

  clear(): void {
    this.objects.clear();
  }

  all(now: number): StreamGameObject[] {
    const current: StreamGameObject[] = [];
    for (const [guid, entry] of this.objects) {
      if (now - entry.at > LIVE_GAMEOBJECT_STALE_MS) this.objects.delete(guid);
      else current.push(entry.object);
    }
    return current;
  }
}

// Passenger lists come with every snapshot while anyone rides a vehicle;
// past this without word, a player is on foot.
export const LIVE_PASSENGER_STALE_MS = 2500;

// Which vehicle and seat each player rides, by player guid.
export class LivePassengerStore {
  private readonly passengers = new Map<number, { at: number; passenger: StreamPassenger }>();

  push(update: StreamPassengerUpdate, receivedAt: number): void {
    for (const passenger of update.passengers) this.passengers.set(passenger.guid, { at: receivedAt, passenger });
  }

  clear(): void {
    this.passengers.clear();
  }

  get(guid: number, now: number): StreamPassenger | null {
    const entry = this.passengers.get(guid);
    if (!entry) return null;
    if (now - entry.at > LIVE_PASSENGER_STALE_MS) {
      this.passengers.delete(guid);
      return null;
    }
    return entry.passenger;
  }

  // Guids of creatures players are riding.
  vehicles(now: number): Set<number> {
    const vehicles = new Set<number>();
    for (const guid of [...this.passengers.keys()]) {
      const passenger = this.get(guid, now);
      if (passenger?.vehicleCreature) vehicles.add(passenger.vehicleGuid);
    }
    return vehicles;
  }
}

// Equipment slots that change how a character looks, in the order of the
// character model key (scripts/scene/unit-model.mjs characterKey).
const CHARACTER_KEY_SLOTS = [0, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18];
const HEAD_SLOT = 0;
const BACK_SLOT = 14;
const WEAPON_SLOTS = [15, 16, 17];

// The model for a unit's current look: a creature display (with its
// weapons), which also covers druid forms and other shapeshifts and morphs,
// or a dressed character.
// A mounted unit's mount model (its mount display, as a creature), or null
// when it isn't riding one.
export function getMountModelUrl(appearance: StreamAppearance | null, mounted: boolean): string | null {
  return mounted && appearance?.mountDisplayId ? `assets/models/creature/${appearance.mountDisplayId}.glb` : null;
}

export function getUnitModelUrl(appearance: StreamAppearance | null): string | null {
  if (!appearance?.displayId) return null;
  if (appearance.creature || appearance.displayId !== appearance.nativeDisplayId) {
    const weapons = appearance.creature ? WEAPON_SLOTS.map((slot) => appearance.items[slot] ?? 0) : [0, 0, 0];
    return weapons.some(Boolean)
      ? `assets/models/creature/${appearance.displayId}-${weapons.join('.')}.glb`
      : `assets/models/creature/${appearance.displayId}.glb`;
  }
  const items = CHARACTER_KEY_SLOTS.map((slot) => {
    if ((slot === HEAD_SLOT && appearance.helmHidden) || (slot === BACK_SLOT && appearance.cloakHidden)) return 0;
    return appearance.items[slot] ?? 0;
  });
  const flags = (appearance.helmHidden ? 1 : 0) | (appearance.cloakHidden ? 2 : 0);
  return `assets/models/character/${[
    appearance.race, appearance.gender, appearance.skin, appearance.face, appearance.hairStyle, appearance.hairColor,
    appearance.facialStyle, flags, items.join('.'),
  ].join('-')}.glb`;
}
