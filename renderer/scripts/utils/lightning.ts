import type { Point3 } from './spell-events';

// A chain's bolt as the client draws one (SpellChainEffects): a strip of
// joints from its source to its target, each joint jittered off the line
// and drifting (or jumping) about, optionally in a hierarchy of major and
// minor joints, bent by a wave and an arc, flickering on and off, and lit
// by a pulse running along it; drawn as a textured strip across the line
// of sight, pinched to a point at each end. Pure, so it can be tested
// without three.js.

// A chain effect as served by the spell art (scripts/scene/spell-visuals.mjs).
// Times are in milliseconds where named so, otherwise seconds; lengths in
// yards; angles in radians.
export interface SpellChain {
  id: number;
  segmentLength: number;
  width: number;
  noise: number;
  // Texture lengths a second the texture scrolls along the bolt.
  scrollSpeed: number;
  // How long each link shows, and the wait before the first.
  segmentMs: number;
  delayMs: number;
  // The wait between one link and the next.
  linkDelayMs: number;
  flags: number;
  jointCount: number;
  jointOffsetRadius: number;
  jointsPerMinorJoint: number;
  minorJointsPerMajorJoint: number;
  minorJointScale: number;
  majorJointScale: number;
  jointMoveSpeed: number;
  jointSmoothness: number;
  minJointJump: number;
  maxJointJump: number;
  waveHeight: number;
  waveFrequency: number;
  waveSpeed: number;
  minWaveAngle: number;
  maxWaveAngle: number;
  minWaveSpin: number;
  maxWaveSpin: number;
  wavePhase: number;
  arcHeight: number;
  minArcAngle: number;
  maxArcAngle: number;
  minArcSpin: number;
  maxArcSpin: number;
  minFlickerOn: number;
  maxFlickerOn: number;
  minFlickerOff: number;
  maxFlickerOff: number;
  pulseSpeed: number;
  pulseOnLength: number;
  pulseFadeLength: number;
  // 0xRRGGBB, and its opacity (0 to 1).
  color: number;
  alpha: number;
  // The client's blend mode (0 opaque, 1 alpha key, 2 alpha, 3 add, 4
  // modulate, 5 modulate 2x, 6 modulate add).
  blendMode: number;
  // Drawn in order of layer, 0 to 3.
  renderLayer: number;
  textureLength: number;
  combo?: number[];
}

// Chain flags.
const FIXED_JOINT_COUNT = 0x1;
const JOINT_HIERARCHY = 0x2;
const JOINT_JUMPS = 0x4;
const HELICAL_WAVE = 0x8;
const FLICKER = 0x10;
const PULSE = 0x20;
const PULSE_REPEATS = 0x40;
const FLAT_STRIP = 0x80;
const TEXTURE_BY_LENGTH = 0x100;
const TEXTURE_FROM_END = 0x200;
const FIXED_WAVE_PHASE = 0x400;

const MAX_JOINTS = 1000;
const MAX_LENGTH = 10000;
const EPSILON = 2.3841858e-7;

export type Random = () => number;

interface Joint {
  position: Point3;
  smoothed: Point3 | null;
  velocity: Point3;
  jumpTimer: number;
}

// A bolt's strip this frame, in the bolt's coordinates: two vertices per
// joint (positions xyz, texture uv, opacity), of which vertices `start` to
// `start + count` are drawn as a triangle strip.
export interface BoltStrip {
  positions: Float32Array;
  uvs: Float32Array;
  alphas: Float32Array;
  start: number;
  count: number;
}

const sub = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length3 = (a: Point3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Point3, b: Point3): Point3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Two axes across a direction: one level, one up from it.
export function acrossAxes(along: Point3): { x: Point3; z: Point3 } {
  let x: Point3;
  if (Math.abs(along[1]) >= EPSILON) {
    const scale = 1 / Math.hypot(along[1], along[0]);
    x = [along[1] * scale, -along[0] * scale, 0];
  } else {
    x = [along[1], along[0] <= 0 ? 1 : -1, 0];
  }
  const scale = 1 / (length3(along) + 1e-8);
  const z = cross(x, along);
  return { x, z: [z[0] * scale, z[1] * scale, z[2] * scale] };
}

// How far the wave and the arc bend the bolt at `t` along it: none at the
// ends, most in the middle.
const envelope = (t: number): number => 1 - (t - 0.5) * (t - 0.5) * 4;

export class LightningBolt {
  private joints: Joint[] = [];
  private jointsReady = false;
  private off = false;
  private reversePulse = false;
  private waveAngle = 0;
  private waveSpin = 0;
  private wavePhase = 0;
  private arcAngle = 0;
  private arcSpin = 0;
  private flickerTimer = 0;
  private pulsePosition = 0;
  private textureRandom = 0;
  private textureOffset = 0;
  private from: Point3 = [0, 0, 0];
  private to: Point3 = [0, 0, 0];

  constructor(readonly chain: SpellChain, private readonly random: Random = Math.random) {
    this.reset();
  }

  private between(min: number, max: number): number {
    return (max - min) * this.random() + min;
  }

  // -1 to 1.
  private signed(): number {
    return this.random() * 2 - 1;
  }

  private reset(): void {
    const chain = this.chain;
    this.jointsReady = false;
    this.off = false;
    this.waveAngle = this.between(chain.minWaveAngle, chain.maxWaveAngle);
    this.waveSpin = this.between(chain.minWaveSpin, chain.maxWaveSpin);
    this.wavePhase = chain.flags & FIXED_WAVE_PHASE ? chain.wavePhase : this.random() * Math.PI * 2;
    this.arcAngle = this.between(chain.minArcAngle, chain.maxArcAngle);
    this.arcSpin = this.between(chain.minArcSpin, chain.maxArcSpin);
    this.flickerTimer = this.between(chain.minFlickerOn, chain.maxFlickerOn);
    this.pulsePosition = 0;
    if (chain.pulseSpeed < 0) this.reversePulse = true;
    this.textureRandom = this.random();
  }

  private randomizeJoint(joint: Joint, radius: number): void {
    const z = this.signed();
    joint.position = [this.signed() * radius, 0, radius * z];
    const speed = this.signed();
    joint.velocity = [this.signed() * this.chain.jointMoveSpeed, 0, this.chain.jointMoveSpeed * speed];
    joint.jumpTimer = this.jointsReady
      ? this.random() * this.chain.maxJointJump
      : this.between(this.chain.minJointJump, this.chain.maxJointJump);
  }

  private updateJointCount(length: number, radius: number): void {
    const chain = this.chain;
    let count = (chain.flags & FIXED_JOINT_COUNT ? chain.jointCount : Math.floor(length / chain.segmentLength) + 2) + 1;
    count = Number.isFinite(count) ? Math.min(MAX_JOINTS, Math.max(2, count)) : MAX_JOINTS;
    const kept = this.jointsReady ? Math.min(this.joints.length, count) : 0;
    this.joints.length = kept;
    for (let index = kept; index < count; index += 1) {
      const joint: Joint = { position: [0, 0, 0], smoothed: null, velocity: [0, 0, 0], jumpTimer: 0 };
      this.randomizeJoint(joint, radius);
      this.joints.push(joint);
    }
    this.jointsReady = true;
  }

  get jointCount(): number {
    return this.joints.length;
  }

  // Moves the bolt's ends and steps it on by `seconds`: its flicker, the
  // scroll of its texture, its joints, wave, arc, and pulse.
  update(seconds: number, from: Point3, to: Point3): void {
    const chain = this.chain;
    this.from = from;
    this.to = to;
    this.flickerTimer -= seconds;
    if (this.off) {
      if (this.flickerTimer > 0) return;
      this.reset();
    } else if (chain.flags & FLICKER && this.flickerTimer <= 0) {
      this.flickerTimer = this.between(chain.minFlickerOff, chain.maxFlickerOff);
      this.off = true;
    }
    this.textureOffset = chain.scrollSpeed !== 0 ? (chain.scrollSpeed * seconds + this.textureOffset) % 1 : 0;
    const length = Math.min(MAX_LENGTH, length3(sub(to, from)));
    const radius = chain.noise * length + chain.jointOffsetRadius;
    this.updateJointCount(length, radius);
    for (let index = 1; index < this.joints.length; index += 1) {
      const joint = this.joints[index];
      joint.jumpTimer -= seconds;
      if (chain.flags & JOINT_JUMPS && joint.jumpTimer < 0) this.randomizeJoint(joint, radius);
      else for (let axis = 0; axis < 3; axis += 1) joint.position[axis] += joint.velocity[axis] * seconds;
    }
    this.waveAngle += this.waveSpin * seconds;
    this.wavePhase -= chain.waveSpeed * seconds;
    this.arcAngle += this.arcSpin * seconds;
    if (!(chain.flags & PULSE)) return;
    this.pulsePosition += chain.pulseSpeed * seconds;
    if (!this.reversePulse && !(chain.flags & PULSE_REPEATS)) return;
    const pulseLength = chain.pulseFadeLength * 2 + chain.pulseOnLength;
    if (this.pulsePosition - pulseLength >= length) {
      this.reset();
      this.reversePulse = false;
    } else if (this.pulsePosition < 0) {
      this.reset();
      this.reversePulse = false;
      this.pulsePosition = pulseLength + length;
    }
  }

  // A joint's point: `base` plus `along` times `t`, plus its offset across
  // the axes, smoothed towards where it was.
  private jointPoint(base: Point3, along: Point3, axes: { x: Point3; z: Point3 }, t: number, joint: Joint, scale: number): Point3 {
    const smoothness = this.chain.jointSmoothness;
    const smooth: Point3 = joint.smoothed
      ? [0, 1, 2].map((axis) => joint.smoothed![axis] * smoothness + joint.position[axis] * (1 - smoothness)) as Point3
      : [...joint.position];
    joint.smoothed = smooth;
    return [0, 1, 2].map((axis) => (axes.x[axis] * smooth[0] + axes.z[axis] * smooth[2]) * scale + along[axis] * t + base[axis]) as Point3;
  }

  private buildPoints(): Point3[] {
    const last = this.joints.length - 1;
    const points: Point3[] = new Array(last + 1);
    points[0] = this.from;
    points[last] = this.to;
    const along = sub(this.to, this.from);
    const axes = acrossAxes(along);
    for (let index = 1; index < last; index += 1) points[index] = this.jointPoint(this.from, along, axes, index / last, this.joints[index], 1);
    return points;
  }

  // Major joints placed off the whole line, minor joints off the line
  // between major ones, and the rest off the line between minor ones.
  private buildPointsUsingHierarchy(): Point3[] {
    const chain = this.chain;
    const last = this.joints.length - 1;
    const points: Point3[] = new Array(last + 1);
    points[0] = this.from;
    points[last] = this.to;
    const minorStep = Math.max(1, chain.jointsPerMinorJoint);
    const majorStep = Math.max(1, minorStep * chain.minorJointsPerMajorJoint);
    const beam = sub(this.to, this.from);
    let axes = acrossAxes(beam);
    for (let index = majorStep; index < last; index += majorStep) {
      points[index] = this.jointPoint(this.from, beam, axes, index / last, this.joints[index], chain.majorJointScale);
    }
    let next = Math.min(majorStep, last);
    let base = points[0];
    let along = sub(points[next], base);
    axes = acrossAxes(along);
    let step = minorStep / next;
    let t = step;
    if (minorStep < last) {
      for (let index = minorStep; index < last; index += minorStep) {
        if (index === next) {
          next = Math.min(index + majorStep, last);
          base = points[index];
          along = sub(points[next], base);
          axes = acrossAxes(along);
          step = minorStep / (next - index);
          t = step;
        } else {
          points[index] = this.jointPoint(base, along, axes, t, this.joints[index], chain.minorJointScale);
          t += step;
        }
      }
      next = minorStep;
    } else {
      next = last;
    }
    base = points[0];
    along = sub(points[next], base);
    axes = acrossAxes(along);
    step = 1 / next;
    t = step;
    for (let index = 1; index < last; index += 1) {
      if (index === next) {
        next = Math.min(index + minorStep, last);
        base = points[index];
        along = sub(points[next], base);
        axes = acrossAxes(along);
        step = 1 / (next - index);
        t = step;
      } else {
        points[index] = this.jointPoint(base, along, axes, t, this.joints[index], 1);
        t += step;
      }
    }
    return points;
  }

  // The strip to draw now, turned across `viewDirection` (the way the
  // camera looks), or null if the bolt is flickered off or its pulse shows
  // none of it.
  build(viewDirection: Point3): BoltStrip | null {
    const chain = this.chain;
    if (this.off || this.joints.length < 2) return null;
    const points = chain.flags & JOINT_HIERARCHY ? this.buildPointsUsingHierarchy() : this.buildPoints();
    const pointCount = points.length;
    const beam = sub(this.to, this.from);
    const length = length3(beam);
    const axes = acrossAxes(beam);
    const offsetAt = (height: number, angle: number): Point3 =>
      [0, 1, 2].map((axis) => (axes.z[axis] * Math.cos(angle) + axes.x[axis] * Math.sin(angle)) * height) as Point3;
    const waveOffset = chain.waveHeight !== 0 && !(chain.flags & HELICAL_WAVE) ? offsetAt(chain.waveHeight, this.waveAngle) : null;
    const arcOffset = chain.arcHeight !== 0 ? offsetAt(chain.arcHeight, this.arcAngle) : null;
    const bend = (point: Point3, t: number): Point3 => {
      const bent: Point3 = [...point];
      const shape = envelope(t);
      if (chain.waveHeight !== 0) {
        const angle = t * chain.waveFrequency * length + this.wavePhase;
        if (chain.flags & HELICAL_WAVE) {
          const height = shape * chain.waveHeight;
          for (let axis = 0; axis < 3; axis += 1) {
            bent[axis] += axes.x[axis] * Math.cos(angle) * height + axes.z[axis] * Math.sin(angle) * height;
          }
        } else {
          const amount = shape * Math.sin(angle);
          for (let axis = 0; axis < 3; axis += 1) bent[axis] += waveOffset![axis] * amount;
        }
      }
      if (arcOffset) for (let axis = 0; axis < 3; axis += 1) bent[axis] += arcOffset[axis] * shape;
      return bent;
    };

    const vertexCount = pointCount * 2;
    const positions = new Float32Array(vertexCount * 3);
    const set = (vertex: number, point: Point3) => positions.set(point, vertex * 3);
    const add = (vertex: number, point: Point3) => {
      for (let axis = 0; axis < 3; axis += 1) positions[vertex * 3 + axis] += point[axis];
    };
    const width = chain.width;
    const step = 1 / (pointCount - 1);
    if (!(chain.flags & FLAT_STRIP)) {
      // Each joint's pair sits across the average of its two segments.
      let previous = points[0];
      let t = step;
      for (let vertex = 0; vertex < vertexCount - 2; vertex += 2) {
        const point = bend(points[(vertex + 2) >> 1], t);
        const normal = cross(sub(point, previous), viewDirection);
        const normalLength = length3(normal);
        const offset: Point3 = normalLength > 0.001
          ? [normal[0] / normalLength * width, normal[1] / normalLength * width, normal[2] / normalLength * width]
          : [normal[0] * width, normal[1] * width, normal[2] * width];
        add(vertex, [(offset[0] + previous[0]) / 2, (offset[1] + previous[1]) / 2, (offset[2] + previous[2]) / 2]);
        add(vertex + 1, [(previous[0] - offset[0]) / 2, (previous[1] - offset[1]) / 2, (previous[2] - offset[2]) / 2]);
        set(vertex + 2, [(offset[0] + point[0]) / 2, (offset[1] + point[1]) / 2, (offset[2] + point[2]) / 2]);
        set(vertex + 3, [(point[0] - offset[0]) / 2, (point[1] - offset[1]) / 2, (point[2] - offset[2]) / 2]);
        previous = point;
        t += step;
      }
    } else {
      // One flat strip across the whole bolt.
      const normal = cross(beam, viewDirection);
      const normalLength = length3(normal);
      const offset: Point3 = normalLength > 0.001
        ? [normal[0] / normalLength * width, normal[1] / normalLength * width, normal[2] / normalLength * width]
        : [normal[0] * width, normal[1] * width, normal[2] * width];
      let t = 0;
      for (let vertex = 0; vertex < vertexCount; vertex += 2) {
        const point = bend(points[vertex >> 1], t);
        set(vertex, [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]]);
        set(vertex + 1, [point[0] - offset[0], point[1] - offset[1], point[2] - offset[2]]);
        t += step;
      }
    }
    // Pinched to a point at each end.
    set(0, points[0]);
    set(1, points[0]);
    set(vertexCount - 2, points[pointCount - 1]);
    set(vertexCount - 1, points[pointCount - 1]);

    const { alphas, start, count } = this.pulseAlphas(vertexCount, length, pointCount);
    if (count <= 2) return null;

    // Texture: u along the bolt, scaled to its length and scrolled.
    const textureScale = chain.flags & TEXTURE_BY_LENGTH ? length / chain.textureLength : 1;
    let textureOffset = this.textureRandom + this.textureOffset;
    if (chain.flags & TEXTURE_BY_LENGTH && chain.flags & TEXTURE_FROM_END) textureOffset += length / chain.textureLength;
    const uvs = new Float32Array(vertexCount * 2);
    const textureStep = 1 / (vertexCount - 2);
    for (let vertex = 0; vertex < vertexCount; vertex += 2) {
      const u = vertex * textureStep * textureScale - textureOffset;
      uvs.set([u, 0, u, 1], vertex * 2);
    }
    uvs.set([-textureOffset, 0.5, -textureOffset, 0.5], 0);
    uvs.set([textureScale - textureOffset, 0.5, textureScale - textureOffset, 0.5], (vertexCount - 2) * 2);
    return { positions, uvs, alphas, start, count };
  }

  // Each vertex's opacity: the chain's own, or with a pulse, only along the
  // stretch of the bolt the pulse lights, fading in and out at its ends.
  private pulseAlphas(vertexCount: number, length: number, pointCount: number): { alphas: Float32Array; start: number; count: number } {
    const chain = this.chain;
    const alphas = new Float32Array(vertexCount).fill(chain.alpha);
    if (!(chain.flags & PULSE)) return { alphas, start: 0, count: vertexCount };
    const step = length / (pointCount - 1);
    const fadeOutEnd = this.pulsePosition - chain.pulseFadeLength;
    const fadeInEnd = fadeOutEnd - chain.pulseOnLength;
    const fadeInStart = fadeInEnd - chain.pulseFadeLength;
    let start = 0;
    let position = 0;
    let vertex = 0;
    for (; vertex < vertexCount; vertex += 2) {
      let alpha: number;
      if (position < fadeInStart) {
        alpha = 0;
        start = vertex;
      } else if (position < fadeInEnd) {
        alpha = chain.alpha * (position - fadeInStart) / (fadeInEnd - fadeInStart);
      } else if (fadeOutEnd > position) {
        alpha = chain.alpha;
      } else if (position >= this.pulsePosition) {
        alphas[vertex] = 0;
        alphas[vertex + 1] = 0;
        return { alphas, start, count: vertex + 1 - start };
      } else {
        alpha = chain.alpha * (this.pulsePosition - position) / (this.pulsePosition - fadeOutEnd);
      }
      alphas[vertex] = alpha;
      alphas[vertex + 1] = alpha;
      position += step;
    }
    return { alphas, start, count: vertex - start };
  }
}
