import { type MissileMotion, type MotionOutputs, runMotionScript } from './missile-motion';
import type { Point3 } from './spell-events';

// A spell's missile in flight, as the client flies one: from where its
// caster released it towards its target's landing point, sped up to arrive
// about when the spell lands (at most twice its speed), along a gravity arc
// if it flies one, hugging the ground if it follows it, and bent, turned,
// scaled, and sped up or slowed by its motion script. Pure, so it can be
// tested without three.js.

// A missile following the ground: its height above it, how fast it drops
// to it, from how far along (0 to 1) it heads in to its target, and flags
// (4: head in along its way; 8: keep its height over the target's).
export interface FollowGround {
  height: number;
  dropSpeed: number;
  approach: number;
  flags: number;
}

// A gravity arc: gravity (yards/s²), and the pitch (radians) and speed
// ranges it is launched at.
export interface Trajectory {
  gravity: number;
  pitch: [number, number];
  speed: [number, number];
}

export interface FlightSetup {
  launch: Point3;
  // When it was released, and when the spell lands (ms).
  releaseAt: number;
  arriveAt: number;
  // The spell's speed (yards a second).
  speed: number;
  // Where the caster stood when it released (for the speed-up).
  casterAt: Point3;
  castAt: number;
  index?: number;
  count?: number;
  random?: () => number;
  spellId?: number;
  motion?: MissileMotion;
  followGround?: FollowGround;
  trajectory?: Trajectory;
  // Where a segment first meets the ground or a building, as a share of
  // its length; null if it doesn't.
  intersect?: (from: Point3, to: Point3) => number | null;
}

export interface FlightFrame {
  // Where the model is drawn (the flight plus the script's offsets), the
  // way it faces (unit length), the script's turn (degrees) and scale.
  position: Point3;
  forward: Point3;
  turn: { yaw: number; pitch: number; roll: number } | null;
  scale: number;
  arrived: boolean;
}

const MAX_SPEED_UP = 2;
const MIN_SPEED = 0.01;
const EPSILON = 2.3841858e-7;
// The script's sideways-and-up offset is by angle in degrees.
const DEGREES = Math.PI / 180;
// Ground following: how far ahead and down it looks for the ground.
const MAX_GROUND_STEP = 50;
const GROUND_SEARCH_DEPTH = 20;
const FOLLOW_ALONG_WAY = 0x4;
const GROUND_SEARCH_STEPS = 4;

const sub = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length3 = (a: Point3): number => Math.hypot(a[0], a[1], a[2]);

// A gravity arc's launch velocity and flight time to `delta` at `pitch`, or
// null when no arc reaches it.
export function trajectoryVelocity(pitch: number, delta: Point3, gravity: number): { velocity: Point3; time: number } | null {
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  const horizontal = Math.hypot(delta[0], delta[1]);
  if (Math.abs(cos) < 0.0001 || horizontal < 0.0001 || Math.abs(gravity) < 0.0001) return null;
  const half = ((1 / cos) * horizontal * sin - delta[2]) / gravity;
  if (half * 2 <= 0.01) return null;
  const time = Math.sqrt(half * 2);
  const speed = (1 / cos) * (horizontal / time);
  return { velocity: [(delta[0] / horizontal) * cos * speed, (delta[1] / horizontal) * cos * speed, sin * speed], time };
}

export class MissileFlight {
  private position: Point3;
  private readonly launch: Point3;
  private lastAt: number;
  private speed: number;
  private readonly baseSpeed: number;
  private progress = 0;
  private horizontalProgress = 0;
  private readonly initialDistance: number;
  private readonly randoms: [number, number, number];
  private motion: MissileMotion | null;
  private lastDrawn: Point3 | null = null;
  private smoothDirection: Point3 | null = null;
  private arc: { velocity: Point3; timeScale: number; gravity: number } | null = null;
  private done = false;

  constructor(private readonly setup: FlightSetup, target: Point3) {
    const random = setup.random ?? Math.random;
    this.launch = [...setup.launch];
    this.position = [...setup.launch];
    this.lastAt = setup.releaseAt;
    this.motion = setup.motion ?? null;
    this.randoms = [random(), random(), random()];
    this.initialDistance = length3(sub(target, this.position));
    this.baseSpeed = setup.speed;
    // Sped up to land about when the spell does: the time it would take
    // from where the caster stands, less the time since the cast.
    const distance = length3(sub(target, setup.casterAt));
    const remaining = distance / setup.speed - (setup.releaseAt - setup.castAt) / 1000;
    this.speed = remaining > 0 ? Math.min(MAX_SPEED_UP * setup.speed, distance / remaining) : MAX_SPEED_UP * setup.speed;
    if (setup.trajectory) {
      const pitch = (setup.trajectory.pitch[0] + setup.trajectory.pitch[1]) / 2;
      const arc = trajectoryVelocity(pitch, sub(target, this.position), setup.trajectory.gravity);
      if (arc) {
        const left = Math.max(0.0001, (setup.arriveAt - setup.releaseAt) / 1000);
        this.arc = { velocity: arc.velocity, timeScale: Math.min(2, Math.max(0, arc.time / left)), gravity: setup.trajectory.gravity };
      }
    }
  }

  // The speed it flies at now (yards a second), after the speed-up.
  get currentSpeed(): number {
    return this.speed;
  }

  // How far it had to fly when released (yards), for its flight clip's rate.
  get initialYards(): number {
    return this.initialDistance;
  }

  // Steps the flight to `now` towards `target` (the landing point this
  // frame).
  step(now: number, target: Point3): FlightFrame {
    const seconds = Math.max(0, (now - this.lastAt) / 1000);
    this.lastAt = now;
    if (this.done) return this.frame(target, target, true);
    const delta = sub(target, this.position);
    const distance = length3(delta);
    const direction: Point3 = distance < EPSILON ? [0, 0, 1] : [delta[0] / distance, delta[1] / distance, delta[2] / distance];
    if (this.arc) {
      if (now >= this.setup.arriveAt) return this.arrive(target);
      const t = this.arc.timeScale * (now - this.setup.releaseAt) / 1000;
      this.position = [0, 1, 2].map((axis) => this.launch[axis] + this.arc!.velocity[axis] * t) as Point3;
      this.position[2] -= t * this.arc.gravity * t * 0.5;
      const total = (this.setup.arriveAt - this.setup.releaseAt) / 1000;
      this.progress = Math.min(1, (now - this.setup.releaseAt) / 1000 / total);
      this.horizontalProgress = this.progress;
    } else {
      const step = seconds * this.speed;
      if (step >= distance) return this.arrive(target);
      if (step > 0) {
        if (this.setup.followGround && this.setup.intersect) this.followGround(direction, step, target);
        else for (let axis = 0; axis < 3; axis += 1) this.position[axis] += direction[axis] * step;
      }
      this.updateProgress(target, distance - step);
    }
    return this.frame(target, direction, false);
  }

  private arrive(target: Point3): FlightFrame {
    this.done = true;
    this.position = [...target];
    return this.frame(target, target, true);
  }

  // How far along it is (0 to 1), never going back.
  private updateProgress(target: Point3, remaining: number): void {
    const whole = sub(target, this.launch);
    const total = length3(whole);
    this.progress = Math.max(this.progress, total <= 1e-6 ? 1 : 1 - remaining / total);
    const flat = Math.hypot(whole[0], whole[1]);
    const left = Math.hypot(target[0] - this.position[0], target[1] - this.position[1]);
    this.horizontalProgress = Math.max(this.horizontalProgress, flat <= 1e-6 ? 1 : 1 - left / flat);
  }

  // Moves along the ground at its height, a few steps over rises, settling
  // to the ground below at its drop speed, and heading in to its target
  // once far enough along.
  private followGround(direction: Point3, step: number, target: Point3): void {
    const follow = this.setup.followGround!;
    const intersect = this.setup.intersect!;
    const distance = Math.min(MAX_GROUND_STEP, Math.max(0, step));
    const ahead: Point3 = [0, 1, 2].map((axis) => direction[axis] * distance * 2 + this.position[axis]) as Point3;
    const flatLength = Math.hypot(direction[0], direction[1]);
    const flat: Point3 = Math.abs(direction[2]) <= 0.999 ? [direction[0] / flatLength, direction[1] / flatLength, 0] : [1, 0, 0];
    let steps = GROUND_SEARCH_STEPS;
    let remaining = distance;
    let end: Point3 = [...this.position];
    for (;;) {
      const move: Point3 = [flat[0] * remaining, flat[1] * remaining, flat[2] * remaining];
      end = [this.position[0] + move[0], this.position[1] + move[1], this.position[2] + move[2]];
      const t = intersect(this.position, end);
      if (t === null) break;
      for (let axis = 0; axis < 3; axis += 1) this.position[axis] += move[axis] * t;
      remaining *= 1 - t;
      this.position[2] += follow.height;
      steps -= 1;
      if (t > 0.999 || steps <= 0) break;
    }
    this.position = end;
    if (steps === GROUND_SEARCH_STEPS) {
      const down: Point3 = [this.position[0], this.position[1], this.position[2] - (follow.height + GROUND_SEARCH_DEPTH)];
      const t = intersect(this.position, down);
      if (t !== null) {
        let ground = this.position[2] + (down[2] - this.position[2]) * t + follow.height;
        const settled = this.position[2] - (this.position[2] - ground) * follow.dropSpeed * distance;
        if (settled > ground) ground = settled;
        this.position[2] = ground;
      }
    }
    if (follow.approach < this.horizontalProgress) {
      const blend = ((this.horizontalProgress - follow.approach) / (1 - follow.approach)) ** 2;
      const towards = follow.flags & FOLLOW_ALONG_WAY ? ahead : target;
      for (let axis = 0; axis < 3; axis += 1) this.position[axis] = towards[axis] * blend + this.position[axis] * (1 - blend);
    }
  }

  // The frame to draw: the script's offsets on top of the flight, facing
  // its way of travel (or straight at the target), the script's turn and
  // scale, and its speed for the next step.
  private frame(target: Point3, direction: Point3, arrived: boolean): FlightFrame {
    const drawn: Point3 = [...this.position];
    let outputs: MotionOutputs | null = null;
    if (this.motion && !arrived) {
      try {
        outputs = runMotionScript(this.motion.script, {
          progress: this.progress,
          time: (this.lastAt - this.setup.releaseAt) / 1000,
          missileIndex: this.setup.index ?? 0,
          missileCount: this.setup.count ?? 1,
          distanceToFirePos: length3(sub(this.launch, this.position)),
          distanceToImpactPos: length3(sub(target, this.position)),
          startDistance: this.initialDistance,
          totalDistance: length3(sub(target, this.launch)),
          rand1: this.randoms[0], rand2: this.randoms[1], rand3: this.randoms[2],
          spellID: this.setup.spellId ?? 0,
        });
      } catch {
        // As the client: a script that fails is dropped for this missile.
        this.motion = null;
      }
    }
    if (outputs) {
      if (outputs.speedAbs > 0) this.speed = outputs.speedAbs;
      if (outputs.speedScalar > 0) this.speed = outputs.speedScalar * this.baseSpeed;
      if (outputs.speedOffset !== 0) this.speed = Math.max(MIN_SPEED, outputs.speedOffset + this.baseSpeed);
      this.applyOffsets(drawn, target, outputs);
    }
    let forward: Point3 = arrived ? this.smoothDirection ?? [1, 0, 0] : direction;
    // With a script, a ground to follow, or an arc, it faces the way it
    // moves, smoothed when it barely moves.
    if (!arrived && (this.motion || this.arc || this.setup.followGround) && this.lastDrawn) {
      let moved = sub(drawn, this.lastDrawn);
      let movedLength = length3(moved);
      if (movedLength > EPSILON) {
        if (movedLength < 0.01 && this.smoothDirection) {
          const weight = Math.max(0.05, movedLength * 100);
          moved = [0, 1, 2].map((axis) => moved[axis] * weight + this.smoothDirection![axis] * (1 - weight)) as Point3;
          movedLength = length3(moved);
        }
        forward = [moved[0] / movedLength, moved[1] / movedLength, moved[2] / movedLength];
      }
    }
    if (!arrived) {
      this.smoothDirection = forward;
      this.lastDrawn = drawn;
    }
    const turn = outputs && (outputs.modelYaw || outputs.modelPitch || outputs.modelRoll)
      ? { yaw: outputs.modelYaw, pitch: outputs.modelPitch, roll: outputs.modelRoll } : null;
    const scale = outputs && outputs.scale > 0 ? Math.max(0.01, outputs.scale) : 1;
    return { position: drawn, forward, turn, scale, arrived };
  }

  // The script's offsets: sideways and up by an angle, then right, forward
  // (along the level way to the target), and up.
  private applyOffsets(point: Point3, target: Point3, outputs: MotionOutputs): void {
    const flat = [target[0] - this.launch[0], target[1] - this.launch[1]];
    const flatLength = Math.hypot(flat[0], flat[1]);
    const way: Point3 = flatLength > EPSILON ? [flat[0] / flatLength, flat[1] / flatLength, 0] : [flat[0], flat[1], 0];
    const side: Point3 = [-way[1], way[0], 0];
    if (outputs.transMag !== 0) {
      const angle = outputs.transAngle * DEGREES;
      point[0] += Math.sin(angle) * side[0] * outputs.transMag;
      point[1] += Math.sin(angle) * side[1] * outputs.transMag;
      point[2] += Math.cos(angle) * outputs.transMag;
    }
    for (let axis = 0; axis < 3; axis += 1) point[axis] += side[axis] * outputs.transRight + way[axis] * outputs.transFront;
    point[2] += outputs.transUp;
  }
}
