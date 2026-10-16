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
  if (!track) return fallback;
  let keys: [number[], number[]] | undefined;
  let time: number;
  if (track.g >= 0) {
    keys = track.k.global;
    const loop = clock.loops[track.g] ?? 0;
    time = loop > 0 ? clock.elapsedMs % loop : 0;
  } else {
    // No keys for this clip means the default, not another clip's keys: an
    // effect's start (Stand) often fades in or bursts, and its idle (Hold)
    // must not replay that.
    keys = track.k[clock.clip];
    time = clock.timeMs;
  }
  if (!keys) return fallback;
  return interpolate(keys[0], keys[1], width, time, track.s);
}

export function interpolate(times: number[], values: number[], width: number, time: number, step = false): number[] {
  const count = Math.min(times.length, Math.floor(values.length / width));
  if (!count) return [];
  const at = (index: number) => values.slice(index * width, index * width + width);
  if (count === 1 || time <= times[0]) return at(0);
  if (time >= times[count - 1]) return at(count - 1);
  let index = 0;
  while (index < count - 2 && times[index + 1] <= time) index += 1;
  if (step) return at(index);
  const span = times[index + 1] - times[index];
  const t = span > 0 ? (time - times[index]) / span : 0;
  const from = at(index);
  const to = at(index + 1);
  return from.map((value, component) => value + (to[component] - value) * t);
}

// A curve over a particle's life at `fraction` (0 born, 1 dying).
export function evalLifeCurve(curve: LifeCurve, width: number, fraction: number, fallback: number[]): number[] {
  const values = interpolate(curve.t, curve.v, width, Math.min(1, Math.max(0, fraction)));
  return values.length ? values : fallback;
}

// UV rectangle [u0, v0, u1, v1] of cell `cell` on a texture of rows x
// columns cells, as the client lays them out: counted along each row from
// the top left, the cell rounded to the nearest. A texture whose rows or
// columns aren't a power of two is one cell.
export function cellUv(cell: number, rows: number, columns: number): [number, number, number, number] {
  const power = (value: number) => value >= 1 && (value & (value - 1)) === 0;
  if (!power(rows) || !power(columns)) return [0, 0, 1, 1];
  const index = Math.max(0, Math.round(cell));
  const column = index & (columns - 1);
  const row = index >> Math.log2(columns);
  return [column / columns, row / rows, (column + 1) / columns, (row + 1) / rows];
}

// A random number in [-1, 1), and in [0, 1).
export type Random = () => number;
export const signedRandom = (): number => Math.random() * 2 - 1;

export interface SpawnParams {
  emitterType: number;
  // The width (0xC8) and length (0xDC) tracks: a plane's extent along x
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
    return size > 2.3841858e-7 ? [away[0] / size * speed, away[1] / size * speed, away[2] / size * speed] : [0, 0, 0];
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
  return TWINKLE_TABLE[((Math.round(framesPerSecond * age) & 0xff) + offset) & 127];
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

// The angle of a UV rotation quaternion about Z.
export function quaternionAngleZ(q: number[]): number {
  return 2 * Math.atan2(q[2] ?? 0, q[3] ?? 1);
}
