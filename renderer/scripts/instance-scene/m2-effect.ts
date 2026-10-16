import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  CustomBlending,
  DoubleSide,
  Euler,
  DynamicDrawUsage,
  AdditiveBlending,
  Group,
  LoopOnce,
  LoopRepeat,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  MultiplyBlending,
  NormalBlending,
  type Object3D,
  OneFactor,
  Quaternion,
  RepeatWrapping,
  SrcColorFactor,
  type Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import {
  cellUv,
  type EffectBlend,
  emitCount,
  evalLifeCurve,
  evalTrack,
  type ExportedTrack,
  type LifeCurve,
  materialBlend,
  particleBlend,
  quaternionAngleZ,
  spawnParticle,
  type TrackClock,
  type Vec3,
} from '../utils/m2-tracks';

// Plays one of the client's spell effect models (built by
// scripts/scene/effect-model.mjs): its animated geometry, with billboards,
// colours, and scrolling textures, and its particle emitters and ribbons,
// simulated here. Positions are in the layer's server coordinates (Z up).

interface ExportedEmitter {
  flags: number;
  position: number[];
  bone: number;
  bonePivot: number[];
  textureMaterial: string | null;
  blendingType: number;
  emitterType: number;
  rows: number;
  columns: number;
  emissionSpeed: ExportedTrack | null;
  speedVariation: ExportedTrack | null;
  verticalRange: ExportedTrack | null;
  horizontalRange: ExportedTrack | null;
  gravity: ExportedTrack | null;
  lifespan: ExportedTrack | null;
  lifespanVariation: number;
  emissionRate: ExportedTrack | null;
  emissionRateVariation: number;
  emissionAreaWidth: ExportedTrack | null;
  emissionAreaLength: ExportedTrack | null;
  zSource: ExportedTrack | null;
  enabled: ExportedTrack | null;
  color: LifeCurve;
  alpha: LifeCurve;
  scale: LifeCurve;
  scaleVary: number[];
  headCell: LifeCurve;
  tailCell: LifeCurve;
  tailLength: number;
  twinkleSpeed: number;
  twinklePercent: number;
  twinkleScale: number[];
  drag: number;
  baseSpin: number;
  baseSpinVariation: number;
  spin: number;
  spinVariation: number;
  wind: number[];
  splinePoints: number[];
}

interface ExportedRibbon {
  bone: number;
  bonePivot: number[];
  position: number[];
  textureMaterial: string | null;
  blend: number;
  color: ExportedTrack | null;
  alpha: ExportedTrack | null;
  heightAbove: ExportedTrack | null;
  heightBelow: ExportedTrack | null;
  visibility: ExportedTrack | null;
  edgesPerSecond: number;
  edgeLifetime: number;
  gravity: number;
}

interface ExportedEffect {
  loops: number[];
  clips: Record<string, number>;
  globalClips: Record<string, number>;
  emitters: ExportedEmitter[];
  ribbons: ExportedRibbon[];
}

export interface EffectTemplate {
  scene: Object3D;
  animations: AnimationClip[];
  effect: ExportedEffect;
  textures: Map<string, Texture>;
}

// Particle emitter flags (wowdev.wiki).
const FLAG_VELOCITY_ORIENT = 0x4;
const FLAG_WORLD_SPACE = 0x10;
const FLAG_CLAMP_TAIL_TO_AGE = 0x400;
const FLAG_XY_QUAD = 0x1000;
const FLAG_HEAD = 0x20000;
const FLAG_TAIL = 0x40000;
const FLAG_RANDOM_FLIPBOOK_START = 0x200000;
// Effect models the client turns from how they are authored, by model name
// (lower case), as quaternions (x, y, z, w) in model space. Found by comparing
// with the client; the data gives no rule for them.
const MODEL_TURNS: Record<string, [number, number, number, number]> = {
  // Its ice shard is authored upright; in flight it points at the target
  // (a quarter turn about Y brings +Z to +X, the flight direction).
  frostbolt: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
};
const MAX_PARTICLES_PER_EMITTER = 400;
const MAX_RIBBON_EDGES = 64;
const EFFECT_RENDER_ORDER = 4;

const loader = new GLTFLoader();

// Effect templates by URL, each loaded once: the template, null if it could
// not be loaded, or undefined while loading. `onLoaded` runs when a load
// finishes; a failure is logged as `warnAs` (e.g. 'spell effect') if given.
export class EffectTemplateCache {
  private readonly templates = new Map<string, EffectTemplate | null | 'loading'>();

  constructor(private readonly onLoaded: () => void, private readonly warnAs: string | null = null) {}

  get(url: string): EffectTemplate | null | undefined {
    const known = this.templates.get(url);
    if (known === 'loading') return undefined;
    if (known !== undefined) return known;
    this.templates.set(url, 'loading');
    loadEffectTemplate(url)
      .then((template) => this.templates.set(url, template))
      .catch((error) => {
        if (this.warnAs) console.warn(`Could not load ${this.warnAs} ${url}`, error);
        this.templates.set(url, null);
      })
      .finally(() => this.onLoaded());
    return undefined;
  }
}

export async function loadEffectTemplate(url: string): Promise<EffectTemplate> {
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene.children[0];
  const effect = (root?.userData.wowEffect ?? { loops: [], clips: {}, globalClips: {}, emitters: [], ribbons: [] }) as ExportedEffect;
  const textures = new Map<string, Texture>();
  const materials = (await gltf.parser.getDependencies('material')) as MeshStandardMaterial[];
  for (const material of materials) {
    if (/^texture\d+$/.test(material.name) && material.map) textures.set(material.name, material.map);
  }
  return { scene: gltf.scene, animations: gltf.animations, effect, textures };
}

// Batch blend names from the converter (M2_BLEND in unit-model.mjs).
function geometryBlend(name: unknown): EffectBlend {
  switch (name) {
    case 'opaque': return 'opaque';
    case 'alphaKey': return 'alphaKey';
    case 'add': return 'add';
    case 'mod': case 'mod2x': return 'mod';
    default: return 'alpha';
  }
}

function applyBlend(material: MeshBasicMaterial, blend: EffectBlend): void {
  material.transparent = blend !== 'opaque' && blend !== 'alphaKey';
  material.depthWrite = blend === 'opaque' || blend === 'alphaKey';
  material.alphaTest = blend === 'alphaKey' ? 0.5 : 0;
  switch (blend) {
    case 'add':
      material.blending = AdditiveBlending;
      break;
    case 'addColor':
      material.blending = CustomBlending;
      material.blendSrc = SrcColorFactor;
      material.blendDst = OneFactor;
      break;
    case 'mod':
      material.blending = MultiplyBlending;
      material.premultipliedAlpha = true;
      break;
    default:
      material.blending = NormalBlending;
  }
}

// A dynamic batch of quads: four vertices each, with position, uv, colour.
class QuadBatch {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly colors: Float32Array;
  count = 0;

  constructor(capacity: number, texture: Texture | null, blend: EffectBlend) {
    this.positions = new Float32Array(capacity * 12);
    this.uvs = new Float32Array(capacity * 8);
    this.colors = new Float32Array(capacity * 16);
    const indices = new Uint16Array(capacity * 6);
    for (let quad = 0; quad < capacity; quad += 1) {
      indices.set([quad * 4, quad * 4 + 1, quad * 4 + 2, quad * 4, quad * 4 + 2, quad * 4 + 3], quad * 6);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute('uv', new BufferAttribute(this.uvs, 2).setUsage(DynamicDrawUsage));
    geometry.setAttribute('color', new BufferAttribute(this.colors, 4).setUsage(DynamicDrawUsage));
    geometry.setIndex(new BufferAttribute(indices, 1));
    const material = new MeshBasicMaterial({ map: texture, vertexColors: true, side: DoubleSide, forceSinglePass: true });
    applyBlend(material, blend);
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = EFFECT_RENDER_ORDER;
  }

  get capacity(): number {
    return this.positions.length / 12;
  }

  begin(): void {
    this.count = 0;
  }

  // Corners in order round the quad, with their uvs, in one colour.
  add(corners: Vec3[], uv: [number, number, number, number], color: [number, number, number, number]): void {
    if (this.count >= this.capacity) return;
    const quad = this.count;
    for (let corner = 0; corner < 4; corner += 1) this.setVertex(quad, corner, corners[corner], color);
    const [u0, v0, u1, v1] = uv;
    this.setUvs(quad, u0, v1, u1, v1, u1, v0, u0, v0);
    this.count += 1;
  }

  // Two pairs of edge points: a strip segment from (a, b) to (c, d).
  addSegment(a: Vec3, b: Vec3, c: Vec3, d: Vec3, u0: number, u1: number, color: [number, number, number, number]): void {
    if (this.count >= this.capacity) return;
    const quad = this.count;
    this.setVertex(quad, 0, a, color);
    this.setVertex(quad, 1, c, color);
    this.setVertex(quad, 2, d, color);
    this.setVertex(quad, 3, b, color);
    this.setUvs(quad, u0, 0, u1, 0, u1, 1, u0, 1);
    this.count += 1;
  }

  private setVertex(quad: number, corner: number, [x, y, z]: Vec3, [r, g, b, a]: [number, number, number, number]): void {
    const position = quad * 12 + corner * 3;
    this.positions[position] = x;
    this.positions[position + 1] = y;
    this.positions[position + 2] = z;
    const color = quad * 16 + corner * 4;
    this.colors[color] = r;
    this.colors[color + 1] = g;
    this.colors[color + 2] = b;
    this.colors[color + 3] = a;
  }

  // Each corner's (u, v), in the corners' order.
  private setUvs(quad: number, ua: number, va: number, ub: number, vb: number, uc: number, vc: number, ud: number, vd: number): void {
    const uvs = this.uvs;
    const start = quad * 8;
    uvs[start] = ua; uvs[start + 1] = va; uvs[start + 2] = ub; uvs[start + 3] = vb;
    uvs[start + 4] = uc; uvs[start + 5] = vc; uvs[start + 6] = ud; uvs[start + 7] = vd;
  }

  end(): void {
    const geometry = this.mesh.geometry;
    geometry.setDrawRange(0, this.count * 6);
    this.mesh.visible = this.count > 0;
    // Only the quads written this frame go to the GPU; nothing when empty.
    if (this.count) {
      for (const name of ['position', 'uv', 'color']) {
        const attribute = geometry.getAttribute(name) as BufferAttribute;
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, this.count * 4 * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

interface Particle {
  // Layer coordinates for world-space emitters, else the emitter's own.
  position: Vec3;
  velocity: Vec3;
  age: number;
  life: number;
  seed: number;
  spin: number;
  spinSpeed: number;
  scale: number;
  cellOffset: number;
}

interface EmitterState {
  def: ExportedEmitter;
  joint: Object3D | null;
  particles: Particle[];
  carry: number;
  batch: QuadBatch;
}

interface RibbonEdge {
  position: Vec3;
  up: Vec3;
  age: number;
}

interface RibbonState {
  def: ExportedRibbon;
  joint: Object3D | null;
  edges: RibbonEdge[];
  carry: number;
  batch: QuadBatch;
}

interface AnimatedMaterial {
  material: MeshBasicMaterial;
  color: ExportedTrack | null;
  alpha: ExportedTrack | null;
  weight: ExportedTrack | null;
  uvTranslation: ExportedTrack | null;
  uvRotation: ExportedTrack | null;
  uvScaling: ExportedTrack | null;
}

// Where an instance is and which way it faces, in layer coordinates.
export interface EffectPlacement {
  position: Vec3;
  yaw: number;
  pitch?: number;
  // A further turn in the model's own frame (radians), as a missile's
  // motion script gives it.
  turn?: { yaw: number; pitch: number; roll: number } | null;
  scale: number;
}

// A missile's clips: Fly loops in flight at `rate` (its speed against the
// clip's own), and Impact plays as it lands.
export interface MissileClips {
  rate: number;
}

type Phase = 'Stand' | 'Hold' | 'Decay' | 'Fly' | 'Impact';
const scriptTurn = new Quaternion();
const scriptEuler = new Euler();

const tempMatrix = new Matrix4();
const tempVector = new Vector3();
const tempQuaternion = new Quaternion();
const tempParent = new Quaternion();
const basis = new Matrix4();
const emitterScratch = new Matrix4();
const pivotScratch = new Matrix4();
const facingScratch = new Quaternion();
const layerQuaternionScratch = new Quaternion();
const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();

const transformPoint = (matrix: Matrix4, point: number[]): Vec3 => {
  tempVector.set(point[0], point[1], point[2]).applyMatrix4(matrix);
  return [tempVector.x, tempVector.y, tempVector.z];
};
const transformDirection = (matrix: Matrix4, direction: Vec3): Vec3 => {
  tempVector.set(direction[0], direction[1], direction[2]).transformDirection(matrix)
    .multiplyScalar(Math.hypot(...direction));
  return [tempVector.x, tempVector.y, tempVector.z];
};
const add = (a: Vec3, b: Vec3, scale = 1): Vec3 => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const normalize = (v: Vec3): Vec3 => {
  const size = length(v) || 1;
  return [v[0] / size, v[1] / size, v[2] / size];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const seeded = (seed: number, salt: number): number => {
  const value = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
};

// The camera's directions in the layer's coordinates, for billboards.
export interface EffectView {
  right: Vec3;
  up: Vec3;
  toCamera: Vec3;
}

export function getEffectView(camera: Camera, layer: Object3D): EffectView {
  const inverse = tempQuaternion.copy(layer.getWorldQuaternion(new Quaternion())).invert();
  const direction = (x: number, y: number, z: number): Vec3 => {
    const vector = new Vector3(x, y, z).applyQuaternion(camera.quaternion).applyQuaternion(inverse);
    return [vector.x, vector.y, vector.z];
  };
  return { right: direction(1, 0, 0), up: direction(0, 1, 0), toCamera: direction(0, 0, 1) };
}

export class EffectInstance {
  // Placed in the layer; the model hangs under it.
  readonly root = new Group();
  // Particles and ribbons, in layer coordinates.
  readonly particles = new Group();
  private readonly model: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly emitters: EmitterState[];
  private readonly ribbons: RibbonState[];
  private readonly billboards: Object3D[] = [];
  private readonly materials: AnimatedMaterial[] = [];
  private readonly loops: number[];
  private readonly clips: Record<string, number>;
  private readonly actions = new Map<string, AnimationAction>();
  private readonly startAt: number;
  private lastAt: number;
  // Stand is the start; a lasting effect then loops Hold (or Stand, if it
  // has no Hold) and ends with Decay; a one-off plays Stand once. A missile
  // loops Fly instead, where it has one, and ends with Impact.
  private phase: Phase = 'Stand';
  private phaseAt: number;
  private emitting = true;
  private stopRequested = false;
  private scale = 1;

  constructor(private readonly template: EffectTemplate, now: number, private readonly loop: boolean,
    private readonly missile: MissileClips | null = null) {
    this.model = cloneSkinned(template.scene);
    // The scene carries the model's name (the loader renames its node).
    const turn = MODEL_TURNS[template.scene.name.toLowerCase()];
    if (turn) this.model.quaternion.set(...turn);
    this.root.add(this.model);
    this.startAt = now;
    this.lastAt = now;
    this.phaseAt = now;
    this.loops = template.effect.loops ?? [];
    this.clips = template.effect.clips ?? {};
    this.mixer = new AnimationMixer(this.model);
    for (const clip of template.animations) {
      const action = this.mixer.clipAction(clip);
      if (clip.name.startsWith('global')) {
        action.setLoop(LoopRepeat, Infinity);
        action.play();
      } else {
        this.actions.set(clip.name, action);
      }
    }
    this.enterPhase(missile && this.clips.Fly ? 'Fly' : 'Stand', now);
    const joints = new Map<number, Object3D>();
    this.model.traverse((object) => {
      const match = /^bone(\d+)$/.exec(object.name);
      if (match) joints.set(Number(match[1]), object);
      if (object.userData.wowBillboard) {
        object.userData.restQuaternion = object.quaternion.clone();
        this.billboards.push(object);
      }
      if (object instanceof Mesh) this.adoptMaterial(object);
    });
    this.emitters = template.effect.emitters.map((def) => {
      const batch = new QuadBatch(MAX_PARTICLES_PER_EMITTER, def.textureMaterial ? template.textures.get(def.textureMaterial) ?? null : null,
        particleBlend(def.blendingType));
      this.particles.add(batch.mesh);
      return { def, joint: joints.get(def.bone) ?? null, particles: [], carry: 0, batch };
    });
    this.ribbons = template.effect.ribbons.map((def) => {
      const batch = new QuadBatch(MAX_RIBBON_EDGES, def.textureMaterial ? template.textures.get(def.textureMaterial) ?? null : null,
        materialBlend(def.blend));
      this.particles.add(batch.mesh);
      return { def, joint: joints.get(def.bone) ?? null, edges: [], carry: 0, batch };
    });
  }

  // How long one play of the effect lasts, in ms.
  get duration(): number {
    return this.clips.Stand ?? Object.values(this.clips)[0] ?? 1000;
  }

  // Whether the phase repeats: Hold always; Stand when a lasting effect has
  // no Hold to settle into.
  private repeats(phase: Phase): boolean {
    return phase === 'Hold' || phase === 'Fly' || (phase === 'Stand' && this.loop && !this.clips.Hold);
  }

  // How fast the phase plays: Fly at the missile's rate.
  private rate(phase: Phase): number {
    return phase === 'Fly' && this.missile ? this.missile.rate : 1;
  }

  private enterPhase(phase: Phase, now: number): void {
    this.actions.get(this.phase)?.stop();
    this.phase = phase;
    this.phaseAt = now;
    const action = this.actions.get(phase);
    if (!action) return;
    const repeat = this.repeats(phase);
    action.reset();
    action.setLoop(repeat ? LoopRepeat : LoopOnce, repeat ? Infinity : 1);
    action.timeScale = this.rate(phase);
    action.clampWhenFinished = true;
    action.play();
  }

  // Ends the effect: a lasting one plays its Decay first, a missile its
  // Impact; then it stops emitting and hides the model, and particles and
  // ribbons live out.
  stop(now = this.lastAt): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (this.missile && this.clips.Impact && this.emitting) {
      this.enterPhase('Impact', now);
      return;
    }
    if (this.loop && this.clips.Decay && this.emitting) {
      this.enterPhase('Decay', now);
      return;
    }
    this.finish();
  }

  private finish(): void {
    this.emitting = false;
    this.model.visible = false;
  }

  get stopped(): boolean {
    return this.stopRequested;
  }

  // Stopped, with nothing left on screen.
  get done(): boolean {
    return !this.emitting && this.emitters.every((emitter) => !emitter.particles.length)
      && this.ribbons.every((ribbon) => ribbon.edges.length < 2);
  }

  update(now: number, placement: EffectPlacement, view: EffectView, layer: Object3D, budget: { left: number }): void {
    const seconds = Math.min(0.1, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    const elapsed = now - this.startAt;
    const phaseLength = this.clips[this.phase] ?? this.duration;
    if (this.phase === 'Stand' && this.loop && this.clips.Hold && now - this.phaseAt >= phaseLength) this.enterPhase('Hold', now);
    if ((this.phase === 'Decay' || this.phase === 'Impact') && this.emitting && now - this.phaseAt >= phaseLength) this.finish();
    const inPhase = (now - this.phaseAt) * this.rate(this.phase);
    const length = Math.max(1, this.clips[this.phase] ?? this.duration);
    const clock: TrackClock = {
      clip: this.phase,
      timeMs: this.repeats(this.phase) ? inPhase % length : Math.min(inPhase, length),
      elapsedMs: elapsed,
      loops: this.loops,
    };
    this.scale = placement.scale;
    this.root.position.set(...placement.position);
    this.root.rotation.set(0, -(placement.pitch ?? 0), placement.yaw, 'ZYX');
    if (placement.turn) {
      scriptEuler.set(placement.turn.roll, placement.turn.pitch, placement.turn.yaw, 'ZYX');
      this.root.quaternion.multiply(scriptTurn.setFromEuler(scriptEuler));
    }
    this.root.scale.setScalar(placement.scale);
    // The mixer sets animated rotations; the rest start from their pose, so
    // billboard turns never pile up.
    for (const bone of this.billboards) bone.quaternion.copy(bone.userData.restQuaternion as Quaternion);
    this.mixer.update(seconds);
    this.root.updateMatrixWorld(true);
    this.faceBillboards(layer, view);
    this.animateMaterials(clock);

    const layerInverse = tempMatrix.copy(layer.matrixWorld).invert();
    for (const emitter of this.emitters) this.updateEmitter(emitter, clock, seconds, layerInverse, view, budget);
    for (const ribbon of this.ribbons) this.updateRibbon(ribbon, clock, seconds, layerInverse);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const emitter of this.emitters) emitter.batch.dispose();
    for (const ribbon of this.ribbons) ribbon.batch.dispose();
    for (const animated of this.materials) {
      animated.material.map?.dispose();
      animated.material.dispose();
    }
    this.root.removeFromParent();
    this.particles.removeFromParent();
  }

  private adoptMaterial(mesh: Mesh): void {
    mesh.frustumCulled = false;
    mesh.renderOrder = EFFECT_RENDER_ORDER;
    const source = mesh.material as Material;
    const extras = source.userData;
    const texture = typeof extras.wowTexture === 'string' ? this.template.textures.get(extras.wowTexture) : undefined;
    const map = texture ? texture.clone() : null;
    if (map) {
      map.wrapS = RepeatWrapping;
      map.wrapT = RepeatWrapping;
      map.center.set(0.5, 0.5);
      map.needsUpdate = true;
    }
    const material = new MeshBasicMaterial({ map, side: DoubleSide, forceSinglePass: true });
    applyBlend(material, geometryBlend(extras.wowBlend));
    mesh.material = material;
    this.materials.push({
      material,
      color: extras.wowColor ?? null,
      alpha: extras.wowAlpha ?? null,
      weight: extras.wowWeight ?? null,
      uvTranslation: extras.wowUvTranslation ?? null,
      uvRotation: extras.wowUvRotation ?? null,
      uvScaling: extras.wowUvScaling ?? null,
    });
  }

  private animateMaterials(clock: TrackClock): void {
    for (const animated of this.materials) {
      const [r, g, b] = evalTrack(animated.color, 3, clock, [1, 1, 1]);
      animated.material.color.setRGB(r, g, b);
      const alpha = evalTrack(animated.alpha, 1, clock, [1])[0] * evalTrack(animated.weight, 1, clock, [1])[0];
      animated.material.opacity = Math.min(1, Math.max(0, alpha));
      const map = animated.material.map;
      if (!map) continue;
      const [x, y] = evalTrack(animated.uvTranslation, 3, clock, [0, 0, 0]);
      const [sx, sy] = evalTrack(animated.uvScaling, 3, clock, [1, 1, 1]);
      map.offset.set(x, y);
      map.repeat.set(sx || 1, sy || 1);
      map.rotation = animated.uvRotation ? quaternionAngleZ(evalTrack(animated.uvRotation, 4, clock, [0, 0, 0, 1])) : 0;
    }
  }

  // Billboarded bones keep their animated spin but face the camera: their +X
  // towards it, +Z up the screen.
  private faceBillboards(layer: Object3D, view: EffectView): void {
    if (!this.billboards.length) return;
    const layerQuaternion = layer.getWorldQuaternion(layerQuaternionScratch);
    const x = axisX.fromArray(view.toCamera).applyQuaternion(layerQuaternion);
    const z = axisZ.fromArray(view.up).applyQuaternion(layerQuaternion);
    const y = axisY.crossVectors(z, x);
    basis.makeBasis(x, y, z);
    const facing = facingScratch.setFromRotationMatrix(basis);
    for (const bone of this.billboards) {
      bone.parent?.getWorldQuaternion(tempParent);
      bone.quaternion.copy(tempParent.invert().multiply(facing).multiply(bone.quaternion));
      bone.updateMatrixWorld(true);
    }
  }

  // The emitter's matrix in layer coordinates: its bone, less the pivot.
  // A shared scratch matrix, valid until the next call.
  private emitterMatrix(joint: Object3D | null, pivot: number[], layerInverse: Matrix4): Matrix4 {
    const matrix = emitterScratch.copy(layerInverse).multiply(joint ? joint.matrixWorld : this.root.matrixWorld);
    if (joint) matrix.multiply(pivotScratch.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
    return matrix;
  }

  private updateEmitter(emitter: EmitterState, clock: TrackClock, seconds: number, layerInverse: Matrix4, view: EffectView,
    budget: { left: number }): void {
    const def = emitter.def;
    const matrix = this.emitterMatrix(emitter.joint, def.bonePivot, layerInverse);
    const worldSpace = Boolean(def.flags & FLAG_WORLD_SPACE);
    const value = (track: ExportedTrack | null, fallback = 0) => evalTrack(track, 1, clock, [fallback])[0];

    if (this.emitting && value(def.enabled, 1) !== 0) {
      const rate = value(def.emissionRate) + Math.random() * def.emissionRateVariation;
      const { count, carry } = emitCount(emitter.carry, rate, seconds);
      emitter.carry = carry;
      const room = Math.min(count, MAX_PARTICLES_PER_EMITTER - emitter.particles.length, Math.max(0, budget.left));
      const life = value(def.lifespan, 1);
      const spawn = {
        emitterType: def.emitterType,
        areaLength: value(def.emissionAreaLength),
        areaWidth: value(def.emissionAreaWidth),
        verticalRange: value(def.verticalRange),
        horizontalRange: value(def.horizontalRange),
        speed: value(def.emissionSpeed),
        speedVariation: value(def.speedVariation),
        zSource: value(def.zSource),
        splinePoints: def.splinePoints,
      };
      for (let index = 0; index < room; index += 1) {
        const born = spawnParticle(spawn);
        let position = add(born.position, def.position as Vec3);
        let velocity = born.velocity;
        if (worldSpace) {
          position = transformPoint(matrix, position);
          velocity = transformDirection(matrix, velocity);
        }
        const seed = Math.random();
        const cells = Math.max(1, def.rows * def.columns);
        emitter.particles.push({
          position,
          velocity,
          age: 0,
          life: Math.max(0.01, life + (Math.random() * 2 - 1) * def.lifespanVariation),
          seed,
          spin: def.baseSpin + seeded(seed, 1) * def.baseSpinVariation,
          spinSpeed: def.spin + seeded(seed, 2) * def.spinVariation,
          scale: 1 + seeded(seed, 3) * (def.scaleVary?.[0] ?? 0),
          cellOffset: def.flags & FLAG_RANDOM_FLIPBOOK_START ? Math.floor(((seeded(seed, 4) + 1) / 2) * cells) : 0,
        });
      }
      budget.left -= room;
    } else {
      emitter.carry = 0;
    }

    // Gravity pulls down the layer's Z for particles left in the world, and
    // down the emitter's own Z for those that move with it.
    const gravity = evalTrack(def.gravity, 3, clock, [0, 0, 0]) as Vec3;
    const drag = def.drag > 0 ? Math.exp(-def.drag * seconds) : 1;
    const wind = (def.wind ?? [0, 0, 0]) as Vec3;
    emitter.particles = emitter.particles.filter((particle) => {
      particle.age += seconds;
      if (particle.age >= particle.life) return false;
      particle.velocity = add(particle.velocity, gravity, seconds);
      particle.velocity = [particle.velocity[0] * drag, particle.velocity[1] * drag, particle.velocity[2] * drag];
      particle.position = add(add(particle.position, particle.velocity, seconds), wind, seconds);
      return true;
    });
    budget.left -= emitter.particles.length;

    const batch = emitter.batch;
    batch.begin();
    const scale = this.scale;
    const xAxis = normalize(transformDirection(matrix, [1, 0, 0]));
    const yAxis = normalize(transformDirection(matrix, [0, 1, 0]));
    const tail = Boolean(def.flags & FLAG_TAIL) && !(def.flags & FLAG_HEAD);
    for (const particle of emitter.particles) {
      const fraction = particle.age / particle.life;
      if (def.twinklePercent > 0 && def.twinklePercent < 1 && def.twinkleSpeed > 0) {
        const phase = (particle.age * def.twinkleSpeed + particle.seed) % 1;
        if (phase > def.twinklePercent) continue;
      }
      const [r, g, b] = evalLifeCurve(def.color, 3, fraction, [255, 255, 255]);
      const [alpha] = evalLifeCurve(def.alpha, 1, fraction, [1]);
      const [sx, sy] = evalLifeCurve(def.scale, 2, fraction, [1, 1]);
      const cell = (tail ? evalLifeCurve(def.tailCell, 1, fraction, [0]) : evalLifeCurve(def.headCell, 1, fraction, [0]))[0]
        + particle.cellOffset;
      const uv = cellUv(cell, def.rows, def.columns);
      const color: [number, number, number, number] = [r / 255, g / 255, b / 255, Math.min(1, Math.max(0, alpha))];
      const center = worldSpace ? particle.position : transformPoint(matrix, particle.position);
      const width = sx * particle.scale * scale;
      const height = (sy || sx) * particle.scale * scale;
      if (width <= 0 && height <= 0) continue;
      if (tail) {
        const velocity = worldSpace ? particle.velocity : transformDirection(matrix, particle.velocity);
        const speed = length(velocity);
        if (speed <= 1e-4) continue;
        const along = normalize(velocity);
        const seconds = def.flags & FLAG_CLAMP_TAIL_TO_AGE ? Math.min(def.tailLength, particle.age) : def.tailLength;
        const back = add(center, along, -speed * seconds * scale);
        const across = normalize(cross(along, view.toCamera));
        batch.add([add(center, across, width), add(back, across, width), add(back, across, -width), add(center, across, -width)], uv, color);
        continue;
      }
      let right: Vec3;
      let up: Vec3;
      if (def.flags & FLAG_XY_QUAD) {
        right = xAxis;
        up = yAxis;
      } else {
        right = view.right;
        up = view.up;
        let angle = particle.spin + particle.spinSpeed * particle.age;
        if (def.flags & FLAG_VELOCITY_ORIENT) {
          const velocity = worldSpace ? particle.velocity : transformDirection(matrix, particle.velocity);
          angle = Math.atan2(-(velocity[0] * right[0] + velocity[1] * right[1] + velocity[2] * right[2]),
            velocity[0] * up[0] + velocity[1] * up[1] + velocity[2] * up[2]);
        }
        if (angle) {
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const turnedRight = add([right[0] * cos, right[1] * cos, right[2] * cos], up, sin);
          up = add([up[0] * cos, up[1] * cos, up[2] * cos], right, -sin);
          right = turnedRight;
        }
      }
      batch.add([
        add(add(center, right, -width), up, -height),
        add(add(center, right, width), up, -height),
        add(add(center, right, width), up, height),
        add(add(center, right, -width), up, height),
      ], uv, color);
    }
    batch.end();
  }

  private updateRibbon(ribbon: RibbonState, clock: TrackClock, seconds: number, layerInverse: Matrix4): void {
    const def = ribbon.def;
    const matrix = this.emitterMatrix(ribbon.joint, def.bonePivot, layerInverse);
    const head = transformPoint(matrix, def.position);
    const up = normalize(transformDirection(matrix, [0, 0, 1]));
    for (const edge of ribbon.edges) {
      edge.age += seconds;
      if (def.gravity) edge.position[2] -= def.gravity * edge.age * seconds;
    }
    const lifetime = Math.max(0.05, def.edgeLifetime);
    ribbon.edges = ribbon.edges.filter((edge) => edge.age < lifetime);
    const visible = evalTrack(def.visibility, 1, clock, [1])[0] !== 0;
    if (this.emitting && visible) {
      const { count, carry } = emitCount(ribbon.carry, def.edgesPerSecond, seconds);
      ribbon.carry = carry;
      if (count || !ribbon.edges.length) ribbon.edges.unshift({ position: head, up, age: 0 });
      if (ribbon.edges.length > MAX_RIBBON_EDGES) ribbon.edges.length = MAX_RIBBON_EDGES;
    }
    const batch = ribbon.batch;
    batch.begin();
    if (ribbon.edges.length >= 1) {
      const above = evalTrack(def.heightAbove, 1, clock, [0.5])[0] * this.scale;
      const below = evalTrack(def.heightBelow, 1, clock, [0.5])[0] * this.scale;
      const [r, g, b] = evalTrack(def.color, 3, clock, [1, 1, 1]);
      const [alpha] = evalTrack(def.alpha, 1, clock, [1]);
      const color: [number, number, number, number] = [r, g, b, Math.min(1, Math.max(0, alpha))];
      // The live head follows the bone; older edges stay where they were left.
      const points = this.emitting ? [{ position: head, up, age: 0 }, ...ribbon.edges] : ribbon.edges;
      for (let index = 0; index < points.length - 1; index += 1) {
        const from = points[index];
        const to = points[index + 1];
        batch.addSegment(
          add(from.position, from.up, above), add(from.position, from.up, -below),
          add(to.position, to.up, above), add(to.position, to.up, -below),
          from.age / lifetime, to.age / lifetime, color,
        );
      }
    }
    batch.end();
  }
}
