import { EPSILON } from './vec3';

// Pure maths for playing the client's spell effect models: animation tracks
// exported by scripts/scene/effect-model.mjs, particle spawning, and the
// curves a particle follows over its life, as the client's particle system
// does them.

// An exported track: g is the loop (global sequence) index or -1, s is true
// for stepped keys, and k maps a clip name (or 'global') to [times in ms,
// flat values].
export interface ExportedTrack {
  g: number;
  s: boolean;
  k: Record<string, [number[], number[]]>;
}

// Over a particle's life: times as fractions of it, flat values.
export interface LifeCurve {
  t: number[];
  v: number[];
}

export interface TrackClock {
  clip: string;
  // Time into the clip, in ms.
  timeMs: number;
  // Time since the effect started, in ms, for looping (global) tracks.
  elapsedMs: number;
  loops: readonly number[];
}

export type Vec3 = [number, number, number];

// The track's value at the clock's time, `width` numbers per key; the
// fallback when the track is missing or has no keys for this clip.
export function evalTrack(track: ExportedTrack | null | undefined, width: number, clock: TrackClock, fallback: number[]): number[] {
  const out = new Array<number>(width);
  return evalTrackInto(track, width, clock, out) ? out : fallback;
}

// As evalTrack, written into `out` (`width` numbers); false, leaving `out`
// as it was, where evalTrack gives the fallback.
export function evalTrackInto(track: ExportedTrack | null | undefined, width: number, clock: TrackClock, out: number[]): boolean {
  if (!track) return false;
  if (track.g >= 0) {
    const keys = track.k.global;
    if (!keys) return false;
    const loop = clock.loops[track.g] ?? 0;
    return interpolateInto(keys[0], keys[1], width, loop > 0 ? clock.elapsedMs % loop : 0, track.s, out);
  }
  // No keys for this clip means the default, not another clip's keys: an
  // effect's start (Stand) often fades in or bursts, and its idle (Hold)
  // must not replay that. (A clip past the track's last sequence was given
  // the first sequence's keys when the model was exported.)
  const keys = track.k[clock.clip];
  return keys ? interpolateInto(keys[0], keys[1], width, clock.timeMs, track.s, out) : false;
}

export function interpolate(times: number[], values: number[], width: number, time: number, step = false): number[] {
  const out = new Array<number>(width);
  return interpolateInto(times, values, width, time, step, out) ? out : [];
}

// The keys' value at `time` written into `out` (`width` numbers); false if
// there are no keys.
export function interpolateInto(times: number[], values: number[], width: number, time: number, step: boolean, out: number[]): boolean {
  const count = Math.min(times.length, Math.floor(values.length / width));
  if (!count) return false;
  let index: number;
  let t = 0;
  if (count === 1 || time <= times[0]) index = 0;
  else if (time >= times[count - 1]) index = count - 1;
  else {
    index = 0;
    while (index < count - 2 && times[index + 1] <= time) index += 1;
    if (!step) {
      const span = times[index + 1] - times[index];
      t = span > 0 ? (time - times[index]) / span : 0;
    }
  }
  const from = index * width;
  if (t === 0) {
    for (let component = 0; component < width; component += 1) out[component] = values[from + component];
  } else {
    for (let component = 0; component < width; component += 1) {
      const value = values[from + component];
      out[component] = value + (values[from + width + component] - value) * t;
    }
  }
  return true;
}

// A curve over a particle's life at `fraction` (0 born, 1 dying).
export function evalLifeCurve(curve: LifeCurve, width: number, fraction: number, fallback: number[]): number[] {
  const out = new Array<number>(width);
  return evalLifeCurveInto(curve, width, fraction, out) ? out : fallback;
}

// As evalLifeCurve, written into `out`; false where it gives the fallback.
export function evalLifeCurveInto(curve: LifeCurve, width: number, fraction: number, out: number[]): boolean {
  return interpolateInto(curve.t, curve.v, width, Math.min(1, Math.max(0, fraction)), false, out);
}

// UV rectangle [u0, v0, u1, v1] of cell `cell` on a texture of rows x
// columns cells, as the client lays them out: counted along each row from
// the top left, the cell rounded to the nearest. A texture whose rows or
// columns aren't a power of two is one cell.
export function cellUv(cell: number, rows: number, columns: number): [number, number, number, number] {
  return cellUvInto(cell, rows, columns, [0, 0, 0, 0]);
}

// As cellUv, written into `out`.
export function cellUvInto(cell: number, rows: number, columns: number, out: [number, number, number, number]): [number, number, number, number] {
  const power = (value: number) => value >= 1 && (value & (value - 1)) === 0;
  if (!power(rows) || !power(columns)) {
    out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 1;
    return out;
  }
  const index = Math.max(0, Math.round(cell));
  const column = index & (columns - 1);
  const row = index >> Math.log2(columns);
  out[0] = column / columns; out[1] = row / rows; out[2] = (column + 1) / columns; out[3] = (row + 1) / rows;
  return out;
}

// A source of random numbers in [-1, 1), and the one spawning uses unless
// given another.
export type Random = () => number;
export const signedRandom = (): number => Math.random() * 2 - 1;

export interface SpawnParams {
  emitterType: number;
  // The emission area's width and length tracks: a plane's extent along x
  // and y; a sphere's least and greatest radius; a spline's stretch (0 to 1).
  areaWidth: number;
  areaLength: number;
  // Latitude and longitude ranges (radians).
  verticalRange: number;
  horizontalRange: number;
  speed: number;
  speedVariation: number;
  zSource: number;
  // Sphere only: fly straight up (M2 flag 0x100).
  upward?: boolean;
  splinePoints?: number[];
}

// Where a new particle starts and how fast it goes, in its emitter's frame,
// as the client's plane, sphere, and spline emitters make them. `random`
// returns numbers in [-1, 1).
export function spawnParticle(params: SpawnParams, random: Random = signedRandom): { position: Vec3; velocity: Vec3 } {
  const unit = () => (random() + 1) / 2;
  const zSource = Math.abs(params.zSource) < 0.001 ? 0 : params.zSource;
  // Away from a point zSource up the emitter's axis, at `speed`.
  const fromSource = (position: Vec3, speed: number): Vec3 => {
    const away: Vec3 = [position[0], position[1], position[2] - zSource];
    const size = Math.hypot(...away);
    return size > EPSILON ? [away[0] / size * speed, away[1] / size * speed, away[2] / size * speed] : [0, 0, 0];
  };
  const speedOf = () => params.speed * (1 + random() * params.speedVariation);
  if (params.emitterType === 2) {
    // Sphere: a shell between the radii, at a latitude above or below the
    // level and a longitude from straight ahead, flying outward.
    const radius = unit() * (params.areaLength - params.areaWidth) + params.areaWidth;
    const latitude = random() * params.verticalRange;
    const longitude = random() * params.horizontalRange;
    const direction: Vec3 = [Math.cos(longitude) * Math.cos(latitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
    const position: Vec3 = [direction[0] * radius, direction[1] * radius, direction[2] * radius];
    const speed = speedOf();
    if (zSource) return { position, velocity: fromSource(position, speed) };
    const way: Vec3 = params.upward ? [0, 0, 1] : direction;
    return { position, velocity: [way[0] * speed, way[1] * speed, way[2] * speed] };
  }
  if (params.emitterType === 3 && params.splinePoints && params.splinePoints.length >= 6) {
    // Spline: a point along its stretch, flying up (turned about the line
    // by the latitude, and pushed along that way by the longitude).
    const start = Math.min(1, Math.max(0, params.areaWidth));
    const end = Math.min(1, Math.max(0, params.areaLength));
    const { point, tangent } = splinePoint(params.splinePoints, start + unit() * (end - start));
    const speed = speedOf();
    let position = point;
    if (zSource) return { position, velocity: fromSource(position, speed) };
    let velocity: Vec3 = [0, 0, speed];
    if (params.verticalRange) {
      const way = rotateAbout([0, 0, 1], tangent, random() * params.verticalRange);
      if (params.horizontalRange) position = [0, 1, 2].map((axis) => position[axis] + way[axis] * params.horizontalRange * unit()) as Vec3;
      velocity = [way[0] * speed, way[1] * speed, way[2] * speed];
    }
    return { position, velocity };
  }
  // Plane: a point on the rectangle, flying up within the angles.
  const y = random();
  const x = random();
  const position: Vec3 = [x * params.areaWidth * 0.5, y * params.areaLength * 0.5, 0];
  const speed = speedOf();
  if (zSource) return { position, velocity: fromSource(position, speed) };
  const latitude = random() * params.verticalRange;
  const longitude = random() * params.horizontalRange;
  return {
    position,
    velocity: [Math.cos(longitude) * Math.sin(latitude) * speed, Math.sin(latitude) * Math.sin(longitude) * speed, Math.cos(latitude) * speed],
  };
}

// A point `t` (0 to 1) of the way along a polyline by length, and the line's
// direction there.
function splinePoint(points: number[], t: number): { point: Vec3; tangent: Vec3 } {
  const count = points.length / 3;
  const at = (index: number): Vec3 => [points[index * 3], points[index * 3 + 1], points[index * 3 + 2]];
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < count - 1; index += 1) {
    const [a, b] = [at(index), at(index + 1)];
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lengths.push(segment);
    total += segment;
  }
  let left = t * total;
  for (let index = 0; index < lengths.length; index += 1) {
    if (left <= lengths[index] || index === lengths.length - 1) {
      const [a, b] = [at(index), at(index + 1)];
      const share = lengths[index] > 0 ? Math.min(1, left / lengths[index]) : 0;
      const tangent: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const size = Math.hypot(...tangent) || 1;
      return { point: [0, 1, 2].map((axis) => a[axis] + tangent[axis] * share) as Vec3, tangent: [tangent[0] / size, tangent[1] / size, tangent[2] / size] };
    }
    left -= lengths[index];
  }
  return { point: at(0), tangent: [1, 0, 0] };
}

// `vector` turned `angle` radians about the unit `axis`.
function rotateAbout(vector: Vec3, axis: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = vector[0] * axis[0] + vector[1] * axis[1] + vector[2] * axis[2];
  const cross: Vec3 = [axis[1] * vector[2] - axis[2] * vector[1], axis[2] * vector[0] - axis[0] * vector[2], axis[0] * vector[1] - axis[1] * vector[0]];
  return [0, 1, 2].map((index) => vector[index] * cos + cross[index] * sin + axis[index] * dot * (1 - cos)) as Vec3;
}

// Particles a step emits, as the client counts them: the accumulated rate
// rounded to the nearest, the rest carried to the next step.
export function emitCount(carry: number, rate: number, seconds: number): { count: number; carry: number } {
  const total = carry + rate * Math.max(0, seconds);
  const count = Math.max(0, Math.floor(total + 0.5));
  return { count, carry: total - count };
}

// The client's table of 128 random numbers in [0, 1) that twinkling reads:
// a particle shows while the twinkle's on-share exceeds its entry, and its
// size varies by it.
export const TWINKLE_TABLE: readonly number[] = (() => {
  let seed = 0x2545f491;
  return Array.from({ length: 128 }, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) / 0x1000000;
  });
})();

// The twinkle entry a particle reads at `age`, for one that twinkles at
// `framesPerSecond` from its own `offset` (0 to 127).
export function twinkleEntry(age: number, framesPerSecond: number, offset: number): number {
  return TWINKLE_TABLE[((Math.round(framesPerSecond * age) & 0xff) + offset) & (TWINKLE_TABLE.length - 1)];
}

// Particle and ribbon blends as three.js-agnostic modes, by the client's
// blend tables: opaque, alpha key, alpha, add by alpha (SrcAlpha, One),
// add (One, One), modulate (DstColor, Zero), modulate 2x (DstColor,
// SrcColor).
export type EffectBlend = 'opaque' | 'alphaKey' | 'alpha' | 'add' | 'addColor' | 'mod' | 'mod2x';

// A particle emitter's blend byte: 0 opaque, 1 alpha key, 2 alpha, 3 add
// (One, One), 4 add by alpha, 5 modulate, 6 modulate 2x; anything else
// opaque.
export function particleBlend(type: number): EffectBlend {
  switch (type) {
    case 1: return 'alphaKey';
    case 2: return 'alpha';
    case 3: return 'addColor';
    case 4: return 'add';
    case 5: return 'mod';
    case 6: return 'mod2x';
    default: return 'opaque';
  }
}

// An M2 material's blend (ribbons, geometry): 0 opaque, 1 alpha key, 2
// alpha, 3 add (One, One), 4 add by alpha, 5 modulate, 6 modulate 2x.
export function materialBlend(type: number): EffectBlend {
  switch (type) {
    case 0: return 'opaque';
    case 1: return 'alphaKey';
    case 3: return 'addColor';
    case 4: return 'add';
    case 5: return 'mod';
    case 6: return 'mod2x';
    default: return 'alpha';
  }
}

export type Matrix3Elements = [number, number, number, number, number, number, number, number, number];

// A texture's UV transform as the client builds it, row-major for a 3x3
// matrix: moved by `translation` first, then scaled and turned (by the
// quaternion) about the texture's middle.
export function uvMatrix(translation: number[], rotation: number[], scaling: number[]): Matrix3Elements {
  const [x, y, z, w] = [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1];
  const [sx, sy] = [scaling[0] ?? 1, scaling[1] ?? 1];
  const a = (1 - 2 * (y * y + z * z)) * sx;
  const b = 2 * (x * y - w * z) * sy;
  const c = 2 * (x * y + w * z) * sx;
  const d = (1 - 2 * (x * x + z * z)) * sy;
  const u = (translation[0] ?? 0) - 0.5;
  const v = (translation[1] ?? 0) - 0.5;
  return [a, b, a * u + b * v + 0.5, c, d, c * u + d * v + 0.5, 0, 0, 1];
}

// The steps an emitter takes over a frame of `seconds`, as the client
// splits them: a frame of up to a tenth of a second is one step; a longer
// one is whole tenths, at most as many as fit in a particle's `life`, then
// what's left over past the whole tenths.
export function particleSteps(seconds: number, life: number): number[] {
  if (seconds <= 0.1) return [Math.max(0, seconds)];
  const whole = Math.floor(seconds * 10);
  const steps = Math.max(0, Math.min(whole, Math.floor(life * 10)));
  return [...Array<number>(steps).fill(0.1), seconds - whole * 0.1];
}

// The share of its rate an emitter `distance` yards from the camera lets
// go: all of it within 50 yards, falling to a quarter by 87.5.
export function distanceThinning(distance: number): number {
  return Math.min(1, Math.max(0.25, 1 - (distance - 50) * 0.02));
}

// How far below a particle the client looks for the ground (yards).
export const PARTICLE_GROUND_DEPTH = 20;

// The client's camera field of view, top to bottom (radians), and how far
// back it stands to show a view `height` yards tall.
const CLIENT_FOV_Y = Math.PI / 2 * 0.6;
export const cameraDistanceFor = (height: number): number => height / (2 * Math.tan(CLIENT_FOV_Y / 2));
