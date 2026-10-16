import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type BlendingDstFactor,
  type BlendingSrcFactor,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  Euler,
  DynamicDrawUsage,
  AdditiveBlending,
  Group,
  LoopOnce,
  LoopRepeat,
  type Material,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  NormalBlending,
  type Object3D,
  OneFactor,
  Quaternion,
  RepeatWrapping,
  SrcColorFactor,
  type Texture,
  Vector3,
  ZeroFactor,
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
  signedRandom,
  spawnParticle,
  TWINKLE_TABLE,
  twinkleEntry,
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
  inheritVelocityScale?: number;
  drag: number;
  baseSpin: number;
  baseSpinVariation: number;
  spin: number;
  spinVariation: number;
  wind: number[];
  windTime?: number;
  followSpeed1?: number;
  followScale1?: number;
  followSpeed2?: number;
  followScale2?: number;
  priorityPlane?: number;
  splinePoints: number[];
  // Low and high rates (radians a second) a model particle tumbles about
  // X, Y, Z: [low x, y, z, high x, y, z].
  tumble?: number[];
  // The model each particle is drawn as, by index into the template's
  // particle models, in place of a quad.
  particleModel?: number;
  // The model (by the same index) whose emitters let particles go from
  // each of this one's.
  childEmitters?: number;
}

interface ExportedRibbon {
  bone: number;
  bonePivot: number[];
  position: number[];
  textureMaterial: string | null;
  blend: number;
  // Each texture with its material's blend, drawn as a pass of its own.
  passes?: Array<{ textureMaterial: string | null; blend: number }>;
  color: ExportedTrack | null;
  alpha: ExportedTrack | null;
  heightAbove: ExportedTrack | null;
  heightBelow: ExportedTrack | null;
  textureSlot: ExportedTrack | null;
  visibility: ExportedTrack | null;
  edgesPerSecond: number;
  edgeLifetime: number;
  gravity: number;
  rows: number;
  columns: number;
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
  // The models its particles are drawn as.
  particleModels: EffectTemplate[];
}

// Particle emitter flags, as the client reads them.
const FLAG_SORT = 0x2;
const FLAG_VELOCITY_ORIENT = 0x4;
// Particles stay in the emitter's frame and move with it; without, they are
// left in the world where they were born.
const FLAG_LOCAL = 0x10;
const FLAG_MODEL_SCALE = 0x20;
const FLAG_INHERIT_VELOCITY = 0x40;
const FLAG_KILL_OUTWARD = 0x80;
const FLAG_UPWARD = 0x100;
const FLAG_RANDOM_SPIN_SIGN = 0x200;
const FLAG_CLAMP_TAIL_TO_AGE = 0x400;
const FLAG_SPREAD_ALONG_PATH = 0x800;
const FLAG_XY_QUAD = 0x1000;
const FLAG_FOLLOW = 0x4000;
const FLAG_BURST = 0x8000;
const FLAG_RANDOM_CELL = 0x10000;
const FLAG_HEAD = 0x20000;
const FLAG_TAIL = 0x40000;
const FLAG_SCALE_XY = 0x80000;
// The emitter's frame is its bone's turned a quarter about Z: its +X along
// the bone's +Y.
const EMITTER_TURN = new Matrix4().makeRotationZ(Math.PI / 2);
const MIN_LIFE = 0.001;
const MIN_SCALE_VARIATION = 0.0001;
// Inherited velocity is resampled at most this often (seconds).
const INHERIT_VELOCITY_STEP = 1 / 30;
// A tail shorter than this on screen (yards, squared) draws as a plain quad.
const MIN_TAIL_SQUARED = 0.00077160494;
// Effect models the client turns from how they are authored, by model name
// (lower case), as quaternions (x, y, z, w) in model space. Found by comparing
// with the client; the data gives no rule for them.
const MODEL_TURNS: Record<string, [number, number, number, number]> = {
  // Its ice shard is authored upright; in flight it points at the target
  // (a quarter turn about Y brings +Z to +X, the flight direction).
  frostbolt: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
};
const MAX_PARTICLES_PER_EMITTER = 400;
const MAX_RIBBON_EDGES = 256;
// The client's least ribbon lifetime (seconds), and heights without a track.
const MIN_RIBBON_LIFETIME = 0.25;
const DEFAULT_RIBBON_HEIGHT = 10;
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

const effectOf = (root: Object3D | undefined): ExportedEffect =>
  (root?.userData.wowEffect ?? { loops: [], clips: {}, globalClips: {}, emitters: [], ribbons: [] }) as ExportedEffect;

// The effect, and the models its particles are drawn as: roots of their own
// beside it, their textures and clips prefixed `p<index>:`.
export async function loadEffectTemplate(url: string): Promise<EffectTemplate> {
  const gltf = await loader.loadAsync(url);
  const textures = new Map<string, Texture>();
  const materials = (await gltf.parser.getDependencies('material')) as MeshStandardMaterial[];
  for (const material of materials) {
    if (/^(p\d+:)?texture\d+$/.test(material.name) && material.map) textures.set(material.name, material.map);
  }
  const particleModels: EffectTemplate[] = [];
  for (const root of [...gltf.scene.children]) {
    const index = root.userData.wowParticleModel;
    if (typeof index !== 'number') continue;
    const prefix = `p${index}:`;
    root.removeFromParent();
    const scene = new Group();
    scene.name = String(root.userData.name ?? root.name).replace(prefix, '');
    scene.add(root);
    const animations = gltf.animations.filter((clip) => clip.name.startsWith(prefix)).map((clip) => {
      const own = clip.clone();
      own.name = clip.name.slice(prefix.length);
      return own;
    });
    particleModels[index] = { scene, animations, effect: effectOf(root), textures, particleModels: [] };
  }
  const animations = gltf.animations.filter((clip) => !/^p\d+:/.test(clip.name));
  return { scene: gltf.scene, animations, effect: effectOf(gltf.scene.children[0]), textures, particleModels };
}

// Batch blend names from the converter (M2_BLEND in unit-model.mjs).
function geometryBlend(name: unknown): EffectBlend {
  switch (name) {
    case 'opaque': return 'opaque';
    case 'alphaKey': return 'alphaKey';
    case 'add': return 'add';
    case 'mod': return 'mod';
    case 'mod2x': return 'mod2x';
    default: return 'alpha';
  }
}

// The client's blends: alpha keyed at 224/255 (and the rest at 1/255, so
// fully clear texels never draw), depth written only by the opaque ones.
const ALPHA_KEY_REFERENCE = 224 / 255;
const ALPHA_REFERENCE = 1 / 255;

function applyBlend(material: MeshBasicMaterial, blend: EffectBlend): void {
  material.transparent = blend !== 'opaque' && blend !== 'alphaKey';
  material.depthWrite = blend === 'opaque' || blend === 'alphaKey';
  material.alphaTest = blend === 'opaque' ? 0 : blend === 'alphaKey' ? ALPHA_KEY_REFERENCE : ALPHA_REFERENCE;
  const custom = (source: BlendingSrcFactor, destination: BlendingDstFactor) => {
    material.blending = CustomBlending;
    material.blendSrc = source;
    material.blendDst = destination;
  };
  switch (blend) {
    case 'add':
      material.blending = AdditiveBlending;
      break;
    case 'addColor':
      custom(OneFactor, OneFactor);
      break;
    case 'mod':
      custom(DstColorFactor, ZeroFactor);
      break;
    case 'mod2x':
      custom(DstColorFactor, SrcColorFactor);
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

  // A particle's tail: (a, b) across its head, (c, d) across its end, the
  // cell's u running from head to end.
  addTail(a: Vec3, b: Vec3, c: Vec3, d: Vec3, uv: [number, number, number, number], color: [number, number, number, number]): void {
    if (this.count >= this.capacity) return;
    const quad = this.count;
    this.setVertex(quad, 0, a, color);
    this.setVertex(quad, 1, c, color);
    this.setVertex(quad, 2, d, color);
    this.setVertex(quad, 3, b, color);
    const [u0, v0, u1, v1] = uv;
    this.setUvs(quad, u0, v0, u1, v0, u1, v1, u0, v1);
    this.count += 1;
  }

  // A ribbon's segment between two edges (lower and upper points), u along
  // and v across (lower edge at v0), each edge in its own colour.
  addRibbonSegment(fromBelow: Vec3, fromAbove: Vec3, toBelow: Vec3, toAbove: Vec3, u0: number, u1: number, v0: number, v1: number,
    fromColor: [number, number, number, number], toColor: [number, number, number, number]): void {
    if (this.count >= this.capacity) return;
    const quad = this.count;
    this.setVertex(quad, 0, fromBelow, fromColor);
    this.setVertex(quad, 1, toBelow, toColor);
    this.setVertex(quad, 2, toAbove, toColor);
    this.setVertex(quad, 3, fromAbove, fromColor);
    this.setUvs(quad, u0, v0, u1, v0, u1, v1, u0, v1);
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
  // Layer coordinates for particles left in the world, else the emitter's
  // own (FLAG_LOCAL).
  position: Vec3;
  velocity: Vec3;
  age: number;
  // In [-1, 1): how its life varies.
  lifeSeed: number;
  // Its own random draws: scale variation, cell, spin, spin's sign, and
  // twinkle offset.
  scaleX: number;
  scaleY: number;
  cell: number;
  spin: number;
  spinRate: number;
  spinSign: number;
  twinkle: number;
  // Drawn as a model: the model, its turn (in the layer, or the emitter's
  // frame for particles that move with it), and its tumble (radians a
  // second about its own axes).
  model: EffectInstance | null;
  orientation: Quaternion | null;
  tumble: Vec3;
}

interface EmitterState {
  def: ExportedEmitter;
  joint: Object3D | null;
  particles: Particle[];
  carry: number;
  batch: QuadBatch;
  // Where its frame's origin was last frame (layer), and what follows from
  // its moving: the velocity particles inherit, and the follow offset.
  lastOrigin: Vec3 | null;
  parentVelocity: Vec3;
  inheritTimer: number;
  // Whether a burst emitter has fired since it last showed.
  burstFired: boolean;
  // Its frame this frame (layer coordinates).
  frame: Matrix4;
  // The model its particles are drawn as, if they are.
  model: EffectTemplate | null;
  // Emitters letting particles go from each of its own, and whether it is
  // one (its particles are always left in the world).
  children: EmitterState[];
  child: boolean;
}

const isLocal = (emitter: EmitterState): boolean => !emitter.child && Boolean(emitter.def.flags & FLAG_LOCAL);

// A ribbon's edge (layer coordinates): its lower and upper points, age, and
// the colour it was laid down in.
interface RibbonEdge {
  below: Vec3;
  above: Vec3;
  age: number;
  color: [number, number, number, number];
}

// The ribbon's pose as it moves: where it is, its forward (local Z) and up
// (local Y), scale and all.
interface RibbonPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

interface RibbonState {
  def: ExportedRibbon;
  joint: Object3D | null;
  // Oldest first.
  edges: RibbonEdge[];
  carry: number;
  last: RibbonPose | null;
  started: boolean;
  batches: QuadBatch[];
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
  // Its whole turn in the layer (x, y, z, w), for an effect riding on an
  // attachment, in place of yaw and pitch.
  quaternion?: [number, number, number, number] | null;
  // A further turn in the model's own frame (radians), as a missile's
  // motion script gives it.
  turn?: { yaw: number; pitch: number; roll: number } | null;
  scale: number;
  // A scale along each of its own axes on top, as a model particle has.
  stretch?: Vec3;
}

// A missile's clips: Fly loops in flight at `rate` (its speed against the
// clip's own), and Impact plays as it lands.
export interface MissileClips {
  rate: number;
}

type Phase = 'Birth' | 'Stand' | 'Hold' | 'Decay' | 'Fly' | 'Impact';
const scriptTurn = new Quaternion();
const scriptEuler = new Euler();

const tempMatrix = new Matrix4();
const particleMatrix = new Matrix4();
const childFrameScratch = new Matrix4();
const ribbonFrame = new Matrix4();
const particleScale = new Vector3();
const particlePosition = new Vector3();
const particleTurn = new Quaternion();
const tumbleTurn = new Quaternion();
const tumbleAxis = new Vector3();
const tempVector = new Vector3();
const tempMatrix3 = new Matrix3();
const tempQuaternion = new Quaternion();
const tempParent = new Quaternion();
const basis = new Matrix4();
const emitterScratch = new Matrix4();
const pivotScratch = new Matrix4();
const facingScratch = new Quaternion();
const facingLocked = new Quaternion();
const billboardRight = new Vector3();
// Bone billboard flags.
const BILLBOARD_SPHERICAL = 0x8;
const BILLBOARD_LOCK_X = 0x10;
const BILLBOARD_LOCK_Y = 0x20;
const BILLBOARD_LOCK_Z = 0x40;
const layerQuaternionScratch = new Quaternion();
const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();

const transformPoint = (matrix: Matrix4, point: number[]): Vec3 => {
  tempVector.set(point[0], point[1], point[2]).applyMatrix4(matrix);
  return [tempVector.x, tempVector.y, tempVector.z];
};
// A direction through a matrix's linear part, scale and all.
const linear = (matrix: Matrix4, direction: Vec3): Vec3 => {
  tempVector.set(direction[0], direction[1], direction[2]).applyMatrix3(tempMatrix3.setFromMatrix4(matrix));
  return [tempVector.x, tempVector.y, tempVector.z];
};
const add = (a: Vec3, b: Vec3, scale = 1): Vec3 => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const normalize = (v: Vec3): Vec3 => {
  const size = length(v) || 1;
  return [v[0] / size, v[1] / size, v[2] / size];
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
  // loops Fly instead, where it has one, and ends with Impact. A lasting
  // area's model plays Birth first, where it has one, then holds.
  private phase: Phase = 'Stand';
  private phaseAt: number;
  private emitting = true;
  private stopRequested = false;
  // Colour and opacity it is drawn in on top of its own, as a model
  // particle is by its particle's.
  private tint: [number, number, number, number] = [1, 1, 1, 1];

  constructor(private readonly template: EffectTemplate, now: number, private readonly loop: boolean,
    private readonly missile: MissileClips | null = null, birth = false) {
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
    this.enterPhase(missile && this.clips.Fly ? 'Fly' : birth && loop && this.clips.Birth ? 'Birth' : 'Stand', now);
    const joints = new Map<number, Object3D>();
    this.model.traverse((object) => {
      const match = /bone(\d+)$/.exec(object.name);
      if (match) joints.set(Number(match[1]), object);
      if (object.userData.wowBillboard) {
        object.userData.restQuaternion = object.quaternion.clone();
        this.billboards.push(object);
      }
      if (object instanceof Mesh) this.adoptMaterial(object);
    });
    const emitterState = (def: ExportedEmitter, child: boolean): EmitterState => {
      // A head and a tail for each particle.
      const batch = new QuadBatch(MAX_PARTICLES_PER_EMITTER * 2, def.textureMaterial ? template.textures.get(def.textureMaterial) ?? null : null,
        particleBlend(def.blendingType));
      batch.mesh.renderOrder = EFFECT_RENDER_ORDER + (def.priorityPlane ?? 0) / 1000;
      this.particles.add(batch.mesh);
      const childDefs = child || def.childEmitters === undefined ? [] : template.particleModels[def.childEmitters]?.effect.emitters ?? [];
      return {
        def, joint: child ? null : joints.get(def.bone) ?? null, particles: [], carry: 0, batch,
        lastOrigin: null, parentVelocity: [0, 0, 0], inheritTimer: 0, burstFired: false, frame: new Matrix4(),
        model: def.particleModel === undefined ? null : template.particleModels[def.particleModel] ?? null,
        children: childDefs.map((childDef) => emitterState(childDef, true)),
        child,
      };
    };
    this.emitters = template.effect.emitters.map((def) => emitterState(def, false));
    this.ribbons = template.effect.ribbons.map((def) => {
      const passes = def.passes?.length ? def.passes : [{ textureMaterial: def.textureMaterial, blend: def.blend }];
      const batches = passes.map((pass) => {
        const batch = new QuadBatch(MAX_RIBBON_EDGES, pass.textureMaterial ? template.textures.get(pass.textureMaterial) ?? null : null,
          materialBlend(pass.blend));
        this.particles.add(batch.mesh);
        return batch;
      });
      return { def, joint: joints.get(def.bone) ?? null, edges: [], carry: 0, last: null, started: false, batches };
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
    return !this.emitting && this.allEmitters().every((emitter) => !emitter.particles.length)
      && this.ribbons.every((ribbon) => ribbon.edges.length < 1);
  }

  update(now: number, placement: EffectPlacement, view: EffectView, layer: Object3D, budget: { left: number }): void {
    const seconds = Math.min(0.1, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    const elapsed = now - this.startAt;
    const phaseLength = this.clips[this.phase] ?? this.duration;
    if (this.phase === 'Stand' && this.loop && this.clips.Hold && now - this.phaseAt >= phaseLength) this.enterPhase('Hold', now);
    if (this.phase === 'Birth' && now - this.phaseAt >= phaseLength) this.enterPhase(this.clips.Hold ? 'Hold' : 'Stand', now);
    if ((this.phase === 'Decay' || this.phase === 'Impact') && this.emitting && now - this.phaseAt >= phaseLength) this.finish();
    const inPhase = (now - this.phaseAt) * this.rate(this.phase);
    const length = Math.max(1, this.clips[this.phase] ?? this.duration);
    const clock: TrackClock = {
      clip: this.phase,
      timeMs: this.repeats(this.phase) ? inPhase % length : Math.min(inPhase, length),
      elapsedMs: elapsed,
      loops: this.loops,
    };
    this.root.position.set(...placement.position);
    if (placement.quaternion) this.root.quaternion.set(...placement.quaternion);
    else this.root.rotation.set(0, -(placement.pitch ?? 0), placement.yaw, 'ZYX');
    if (placement.turn) {
      scriptEuler.set(placement.turn.roll, placement.turn.pitch, placement.turn.yaw, 'ZYX');
      this.root.quaternion.multiply(scriptTurn.setFromEuler(scriptEuler));
    }
    this.root.scale.setScalar(placement.scale);
    if (placement.stretch) this.root.scale.multiply(particleScale.fromArray(placement.stretch));
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

  private allEmitters(): EmitterState[] {
    return this.emitters.flatMap((emitter) => [emitter, ...emitter.children]);
  }

  // Draws it in this colour and opacity on top of its own.
  setTint(tint: [number, number, number, number]): void {
    this.tint = tint;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const emitter of this.allEmitters()) {
      emitter.batch.dispose();
      for (const particle of emitter.particles) particle.model?.dispose();
    }
    for (const ribbon of this.ribbons) for (const batch of ribbon.batches) batch.dispose();
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
    applyBlend(material, typeof extras.wowBlendMode === 'number' ? materialBlend(extras.wowBlendMode) : geometryBlend(extras.wowBlend));
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
      const [tr, tg, tb, ta] = this.tint;
      animated.material.color.setRGB(r * tr, g * tg, b * tb);
      const alpha = evalTrack(animated.alpha, 1, clock, [1])[0] * evalTrack(animated.weight, 1, clock, [1])[0] * ta;
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

  // Billboarded bones face the camera. A spherical one (0x8) keeps its
  // animated spin with its +X towards the camera and +Z up the screen; one
  // locked about an axis (0x10 X, 0x20 Y, 0x40 Z) keeps that axis as it is
  // and turns the others about it as far towards the camera as they go, as
  // the client does.
  private faceBillboards(layer: Object3D, view: EffectView): void {
    if (!this.billboards.length) return;
    const layerQuaternion = layer.getWorldQuaternion(layerQuaternionScratch);
    const toCamera = axisX.fromArray(view.toCamera).applyQuaternion(layerQuaternion);
    const screenUp = axisZ.fromArray(view.up).applyQuaternion(layerQuaternion);
    const screenRight = billboardRight.fromArray(view.right).applyQuaternion(layerQuaternion);
    basis.makeBasis(toCamera, axisY.crossVectors(screenUp, toCamera), screenUp);
    const facing = facingScratch.setFromRotationMatrix(basis);
    // A world axis's (right, up) on screen.
    const onScreen = (axis: Vector3): [number, number] => [axis.dot(screenRight), axis.dot(screenUp)];
    // The screen's direction for (right, up), made a unit world axis.
    const fromScreen = (right: number, up: number): Vector3 => {
      const size = Math.hypot(right, up) || 1;
      return new Vector3().addScaledVector(screenRight, right / size).addScaledVector(screenUp, up / size);
    };
    for (const bone of this.billboards) {
      const flags = bone.userData.wowBillboard as number;
      bone.parent?.getWorldQuaternion(tempParent);
      if (flags & BILLBOARD_SPHERICAL || !(flags & (BILLBOARD_LOCK_X | BILLBOARD_LOCK_Y | BILLBOARD_LOCK_Z))) {
        bone.quaternion.copy(tempParent.invert().multiply(facing).multiply(bone.quaternion));
      } else {
        // The bone's axes as animated, in the world.
        const turn = tempQuaternion.copy(tempParent).multiply(bone.quaternion);
        const a = new Vector3(1, 0, 0).applyQuaternion(turn);
        const b = new Vector3(0, 1, 0).applyQuaternion(turn);
        const c = new Vector3(0, 0, 1).applyQuaternion(turn);
        if (flags & BILLBOARD_LOCK_X) {
          const [r, u] = onScreen(a);
          b.copy(fromScreen(u, -r));
          c.crossVectors(a, b);
        } else if (flags & BILLBOARD_LOCK_Y) {
          const [r, u] = onScreen(b);
          a.copy(fromScreen(-u, r));
          c.crossVectors(a, b);
        } else {
          const [r, u] = onScreen(c);
          b.copy(fromScreen(u, -r));
          a.crossVectors(b, c);
        }
        basis.makeBasis(a.normalize(), b.normalize(), c.normalize());
        bone.quaternion.copy(tempParent.invert().multiply(facingLocked.setFromRotationMatrix(basis)));
      }
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
    const flags = def.flags;
    // The emitter's frame (layer coordinates): its bone at its position,
    // turned a quarter about Z.
    const frame = emitter.frame.copy(this.emitterMatrix(emitter.joint, def.bonePivot, layerInverse))
      .multiply(pivotScratch.makeTranslation(def.position[0], def.position[1], def.position[2])).multiply(EMITTER_TURN);
    const origin = transformPoint(frame, [0, 0, 0]);
    const lastOrigin = emitter.lastOrigin ?? origin;
    emitter.lastOrigin = origin;
    const moved: Vec3 = [origin[0] - lastOrigin[0], origin[1] - lastOrigin[1], origin[2] - lastOrigin[2]];
    const frameScale = length(linear(frame, [1, 0, 0]));

    // What follows from the emitter moving: particles it leaves follow it
    // by a share that grows with its speed, and new ones inherit its speed.
    let follow: Vec3 = [0, 0, 0];
    if (flags & FLAG_FOLLOW && seconds > 0) {
      const [speed1, scale1, speed2, scale2] = [def.followSpeed1 ?? 0, def.followScale1 ?? 0, def.followSpeed2 ?? 0, def.followScale2 ?? 0];
      const slope = Math.abs(speed2 - speed1) < 2.3841858e-7 ? 0 : (scale2 - scale1) / (speed2 - speed1);
      const intercept = Math.abs(speed2 - speed1) < 2.3841858e-7 ? 0 : scale1 - speed1 * slope;
      const share = Math.min(1, Math.max(0, (length(moved) / seconds) * slope + intercept));
      follow = [moved[0] * share, moved[1] * share, moved[2] * share];
    }
    if (flags & FLAG_INHERIT_VELOCITY) {
      emitter.inheritTimer += seconds;
      if (emitter.inheritTimer > INHERIT_VELOCITY_STEP) {
        const scale = emitter.particles.length ? (def.inheritVelocityScale ?? 0) / (emitter.inheritTimer * 30) : 0;
        emitter.parentVelocity = [moved[0] * scale, moved[1] * scale, moved[2] * scale];
        emitter.inheritTimer = 0;
      }
    }

    this.spawn(emitter, this.birthCount(emitter, clock, seconds), frame, moved, clock, seconds, budget);
    this.moveParticles(emitter, clock, seconds, origin, follow, frame, budget);
    const lifeOf = this.lifeOf(emitter, clock);
    if (emitter.model) this.drawParticleModels(emitter, frame, frameScale, view, lifeOf, budget);
    else this.drawParticles(emitter, frame, frameScale, view, lifeOf);
    // Its child emitters' particles, born at its own (as they move).
    for (const child of emitter.children) {
      this.moveParticles(child, clock, seconds, null, [0, 0, 0], frame, budget);
      this.drawParticles(child, frame, frameScale, view, this.lifeOf(child, clock));
    }
  }

  // How many particles an emitter lets go this frame. A burst emitter lets
  // its rate's worth go at once as it shows; the rest emit at their rate
  // (with its variation), carrying the remainder.
  private birthCount(emitter: EmitterState, clock: TrackClock, seconds: number): number {
    const def = emitter.def;
    const visible = this.emitting && evalTrack(def.enabled, 1, clock, [1])[0] !== 0;
    const rate = visible ? evalTrack(def.emissionRate, 1, clock, [0])[0] : 0;
    if (def.flags & FLAG_BURST) {
      const fired = emitter.burstFired;
      emitter.burstFired = visible && rate > 0;
      return visible && rate > 0 && !fired ? Math.floor(rate) : 0;
    }
    if (!visible) return 0;
    const { count, carry } = emitCount(emitter.carry, rate + signedRandom() * def.emissionRateVariation, seconds);
    emitter.carry = carry;
    return count;
  }

  private lifeOf(emitter: EmitterState, clock: TrackClock): (particle: Particle) => number {
    const lifeBase = evalTrack(emitter.def.lifespan, 1, clock, [1])[0];
    return (particle) => Math.max(MIN_LIFE, lifeBase + particle.lifeSeed * emitter.def.lifespanVariation);
  }

  // New particles from the emitter's frame (layer coordinates), `moved` the
  // way it came this frame.
  private spawn(emitter: EmitterState, births: number, frame: Matrix4, moved: Vec3, clock: TrackClock, seconds: number,
    budget: { left: number }): void {
    const room = Math.min(births, MAX_PARTICLES_PER_EMITTER - emitter.particles.length, Math.max(0, budget.left));
    if (room <= 0) return;
    const def = emitter.def;
    const flags = def.flags;
    const local = isLocal(emitter);
    const value = (track: ExportedTrack | null) => evalTrack(track, 1, clock, [0])[0];
    const spawn = {
      emitterType: def.emitterType,
      areaWidth: value(def.emissionAreaWidth),
      areaLength: value(def.emissionAreaLength),
      verticalRange: value(def.verticalRange),
      horizontalRange: value(def.horizontalRange),
      speed: value(def.emissionSpeed),
      speedVariation: value(def.speedVariation),
      zSource: value(def.zSource),
      upward: def.emitterType === 2 && Boolean(flags & FLAG_UPWARD),
      splinePoints: def.splinePoints,
    };
    const cells = Math.max(1, def.rows * def.columns);
    for (let index = 0; index < room; index += 1) {
      const born = spawnParticle(spawn);
      let position = born.position;
      let velocity = born.velocity;
      if (!local) {
        position = transformPoint(frame, position);
        velocity = linear(frame, velocity);
        // Spread along the way the emitter came this frame.
        if (flags & FLAG_SPREAD_ALONG_PATH) position = add(position, moved, Math.random() - 1);
      }
      if (flags & FLAG_INHERIT_VELOCITY) velocity = add(velocity, emitter.parentVelocity, 1 + signedRandom() * spawn.speedVariation);
      const scaleX = 1 + signedRandom() * (def.scaleVary?.[0] ?? 0);
      const model = emitter.model ? this.spawnModel(emitter, frame, local, flags) : null;
      emitter.particles.push({
        position, velocity, age: Math.random() * seconds, lifeSeed: signedRandom(),
        scaleX: Math.max(MIN_SCALE_VARIATION, scaleX),
        scaleY: Math.max(MIN_SCALE_VARIATION, flags & FLAG_SCALE_XY ? 1 + signedRandom() * (def.scaleVary?.[1] ?? 0) : scaleX),
        cell: flags & FLAG_RANDOM_CELL && cells > 1 ? Math.floor(Math.random() * cells) : 0,
        // The spin rate is the record's second spin field, as the client
        // reads it, varied by the first.
        spin: def.baseSpin + signedRandom() * def.baseSpinVariation,
        spinRate: def.spinVariation + signedRandom() * def.spin,
        spinSign: flags & FLAG_RANDOM_SPIN_SIGN && Math.random() < 0.5 ? -1 : 1,
        twinkle: Math.floor(Math.random() * 128),
        model: model?.instance ?? null,
        orientation: model?.orientation ?? null,
        tumble: model?.tumble ?? [0, 0, 0],
      });
    }
    budget.left -= room;
  }

  // Moves an emitter's particles and drops the dead: wind while it blows,
  // following the emitter, then their own speed, gravity down its frame's
  // Z, and drag. Each that lives lets its child emitters' particles go from
  // where it is, turned as the emitter's frame (`frame`) is, as it moved
  // and heading as it heads. `origin` is the emitter's (null for a child's
  // particles, which never die heading outward).
  private moveParticles(emitter: EmitterState, clock: TrackClock, seconds: number, origin: Vec3 | null, follow: Vec3,
    frame: Matrix4, budget: { left: number }): void {
    const def = emitter.def;
    const flags = def.flags;
    const local = isLocal(emitter);
    const gravity = -(evalTrack(def.gravity, 3, clock, [0, 0, 0])[2] ?? 0);
    const wind = (def.wind ?? [0, 0, 0]) as Vec3;
    const windTime = def.windTime ?? 0;
    const drag = Math.min(1, def.drag * seconds);
    const lifeOf = this.lifeOf(emitter, clock);
    const alive = (particle: Particle) => {
      particle.age += seconds;
      if (particle.age >= lifeOf(particle)) return false;
      if (particle.orientation) this.tumble(particle, seconds);
      if (windTime > particle.age) particle.velocity = add(particle.velocity, wind, seconds);
      if (flags & FLAG_FOLLOW && particle.age > seconds * 2) particle.position = add(particle.position, follow);
      const step: Vec3 = [particle.velocity[0] * seconds, particle.velocity[1] * seconds, particle.velocity[2] * seconds];
      particle.position = add(particle.position, step);
      particle.position[2] -= gravity * seconds * seconds * 0.5;
      particle.velocity[2] -= gravity * seconds;
      if (drag) particle.velocity = [0, 1, 2].map((axis) => particle.velocity[axis] * (1 - drag)) as Vec3;
      // A sphere's particles flagged so die as they head outward.
      if (origin && def.emitterType === 2 && flags & FLAG_KILL_OUTWARD) {
        const from = local ? particle.position : [particle.position[0] - origin[0], particle.position[1] - origin[1], particle.position[2] - origin[2]];
        if (from[0] * step[0] + from[1] * step[1] + from[2] * step[2] > 0) return false;
      }
      return true;
    };
    emitter.particles = emitter.particles.filter((particle) => {
      const before = particle.position;
      if (!alive(particle)) {
        particle.model?.dispose();
        return false;
      }
      for (const child of emitter.children) {
        const at = local ? transformPoint(frame, particle.position) : particle.position;
        const from = local ? transformPoint(frame, before) : before;
        child.parentVelocity = local ? linear(frame, particle.velocity) : particle.velocity;
        const childFrame = childFrameScratch.copy(frame).setPosition(at[0], at[1], at[2]);
        this.spawn(child, this.birthCount(child, clock, seconds), childFrame, [at[0] - from[0], at[1] - from[1], at[2] - from[2]],
          clock, seconds, budget);
      }
      return true;
    });
    budget.left -= emitter.particles.length;
  }

  // A model particle's model, turned as the emitter's frame is as it is
  // born (unless it moves with the emitter), and its tumble: about X by
  // its low rate and a share of the span, about Y and Z by one to two
  // spans, as the client draws them; each turned either way where the
  // emitter's spins take random signs.
  private spawnModel(emitter: EmitterState, frame: Matrix4, local: boolean, flags: number):
    { instance: EffectInstance; orientation: Quaternion; tumble: Vec3 } {
    const instance = new EffectInstance(emitter.model as EffectTemplate, this.lastAt, true);
    this.particles.add(instance.root, instance.particles);
    const orientation = new Quaternion();
    if (!local) frame.decompose(particlePosition, orientation, particleScale);
    const [lowX, lowY, lowZ, highX, highY, highZ] = emitter.def.tumble ?? [0, 0, 0, 0, 0, 0];
    const tumble: Vec3 = [
      Math.random() * (highX - lowX) + lowX,
      (Math.random() + 1) * (highY - lowY),
      (Math.random() + 1) * (highZ - lowZ),
    ];
    if (flags & FLAG_RANDOM_SPIN_SIGN) for (let axis = 0; axis < 3; axis += 1) if (Math.random() < 0.5) tumble[axis] = -tumble[axis];
    return { instance, orientation, tumble };
  }

  private tumble(particle: Particle, seconds: number): void {
    const speed = length(particle.tumble);
    if (speed <= 0.0001 || !particle.orientation) return;
    tumbleAxis.set(particle.tumble[0] / speed, particle.tumble[1] / speed, particle.tumble[2] / speed);
    particle.orientation.multiply(tumbleTurn.setFromAxisAngle(tumbleAxis, speed * seconds));
  }

  // Each particle as its model, as the client places them: turned, scaled
  // by its scale curve and twinkle (and the emitter's scale where flagged),
  // its depth by the mean of the two, tinted by its colour and opacity
  // curves; hidden while it twinkles off.
  private drawParticleModels(emitter: EmitterState, frame: Matrix4, frameScale: number, view: EffectView,
    lifeOf: (particle: Particle) => number, budget: { left: number }): void {
    const def = emitter.def;
    const flags = def.flags;
    const local = Boolean(flags & FLAG_LOCAL);
    const twinkleBase = def.twinkleScale?.[0] ?? 1;
    const twinkleSpan = (def.twinkleScale?.[1] ?? 1) - twinkleBase;
    const twinkles = def.twinklePercent < 1 || twinkleSpan !== 0;
    const layer = this.particles.parent ?? this.particles;
    for (const particle of emitter.particles) {
      const model = particle.model;
      if (!model || !particle.orientation) continue;
      const entry = twinkles ? twinkleEntry(particle.age, def.twinkleSpeed, particle.twinkle) : TWINKLE_TABLE[0];
      const shown = !(def.twinklePercent < 1 && def.twinklePercent < entry);
      model.root.visible = shown;
      model.particles.visible = shown;
      if (!shown) continue;
      const fraction = particle.age / lifeOf(particle);
      const [r, g, b] = evalLifeCurve(def.color, 3, fraction, [255, 255, 255]).map(Math.round);
      const [alpha] = evalLifeCurve(def.alpha, 1, fraction, [1]);
      model.setTint([r / 255, g / 255, b / 255, Math.min(1, Math.max(0, Math.floor(alpha * 255) / 255))]);
      const [curveX, curveY] = evalLifeCurve(def.scale, 2, fraction, [1, 1]);
      const sizeScale = (twinkleSpan * entry + twinkleBase) * (!local && flags & FLAG_MODEL_SCALE ? frameScale : 1);
      const sx = curveX * sizeScale;
      const sy = (curveY ?? curveX) * sizeScale;
      particleMatrix.compose(particlePosition.fromArray(particle.position), particle.orientation, particleScale.set(sx, sy, (sx + sy) / 2));
      if (local) particleMatrix.premultiply(frame);
      particleMatrix.decompose(particlePosition, particleTurn, particleScale);
      model.update(this.lastAt, {
        position: [particlePosition.x, particlePosition.y, particlePosition.z],
        yaw: 0,
        quaternion: [particleTurn.x, particleTurn.y, particleTurn.z, particleTurn.w],
        scale: 1,
        stretch: [particleScale.x, particleScale.y, particleScale.z],
      }, view, layer, budget);
    }
  }

  // Each particle as the client builds it: a quad facing the screen (or
  // lying in the XY plane), turned by its spin or stretched along its way,
  // and a tail behind it, sized by its scale curve and variation and
  // twinkle, coloured by its curves.
  private drawParticles(emitter: EmitterState, frame: Matrix4, frameScale: number, view: EffectView, lifeOf: (particle: Particle) => number): void {
    const def = emitter.def;
    const flags = def.flags;
    const local = Boolean(flags & FLAG_LOCAL);
    const batch = emitter.batch;
    batch.begin();
    const head = Boolean(flags & FLAG_HEAD);
    const tail = Boolean(flags & FLAG_TAIL);
    if (!head && !tail) {
      batch.end();
      return;
    }
    const centerOf = (particle: Particle) => (local ? transformPoint(frame, particle.position) : particle.position);
    const velocityOf = (particle: Particle) => (local ? linear(frame, particle.velocity) : particle.velocity);
    let particles = emitter.particles;
    if (flags & FLAG_SORT) {
      const depth = (particle: Particle) => {
        const center = centerOf(particle);
        return center[0] * view.toCamera[0] + center[1] * view.toCamera[1] + center[2] * view.toCamera[2];
      };
      particles = [...particles].sort((a, b) => depth(a) - depth(b));
    }
    const twinkleBase = def.twinkleScale?.[0] ?? 1;
    const twinkleSpan = (def.twinkleScale?.[1] ?? 1) - twinkleBase;
    const twinkles = def.twinklePercent < 1 || twinkleSpan !== 0;
    const spins = def.spin !== 0 || def.spinVariation !== 0;
    // The XY plane: the layer's for particles left in the world, the
    // emitter's (unscaled) for those that move with it.
    const planeX: Vec3 = local ? normalize(linear(frame, [1, 0, 0])) : [1, 0, 0];
    const planeY: Vec3 = local ? normalize(linear(frame, [0, 1, 0])) : [0, 1, 0];
    const screen = (vector: Vec3): [number, number] => [
      vector[0] * view.right[0] + vector[1] * view.right[1] + vector[2] * view.right[2],
      vector[0] * view.up[0] + vector[1] * view.up[1] + vector[2] * view.up[2],
    ];
    for (const particle of particles) {
      const entry = twinkles ? twinkleEntry(particle.age, def.twinkleSpeed, particle.twinkle) : TWINKLE_TABLE[0];
      if (def.twinklePercent < 1 && def.twinklePercent < entry) continue;
      const fraction = particle.age / lifeOf(particle);
      const [r, g, b] = evalLifeCurve(def.color, 3, fraction, [255, 255, 255]).map(Math.round);
      const [alpha] = evalLifeCurve(def.alpha, 1, fraction, [1]);
      const color: [number, number, number, number] = [r / 255, g / 255, b / 255, Math.min(1, Math.max(0, Math.round(alpha * 255) / 255))];
      const [curveX, curveY] = evalLifeCurve(def.scale, 2, fraction, [1, 1]);
      const sizeScale = (twinkleSpan * entry + twinkleBase) * (flags & FLAG_MODEL_SCALE ? frameScale : 1);
      const sx = curveX * particle.scaleX * sizeScale;
      const sy = (curveY ?? curveX) * particle.scaleY * sizeScale;
      const center = centerOf(particle);
      if (head) {
        const cell = def.headCell.t.length ? evalLifeCurve(def.headCell, 1, fraction, [0])[0] : particle.cell;
        const uv = cellUv(cell, def.rows, def.columns);
        const velocity = velocityOf(particle);
        let right = view.right as Vec3;
        let up = view.up as Vec3;
        let width = sx;
        if (flags & FLAG_VELOCITY_ORIENT && length(velocity) ** 2 > 2.3841858e-7) {
          // Along the way it goes on screen, longer the more of its speed
          // shows there.
          const back: Vec3 = [-velocity[0], -velocity[1], -velocity[2]];
          const [fx, fy] = screen(back);
          const flat = Math.hypot(fx, fy);
          if (flat > 2.3841858e-7) {
            width = (flat / length(back)) * sx;
            right = add([view.right[0] * fx / flat, view.right[1] * fx / flat, view.right[2] * fx / flat], view.up as Vec3, fy / flat);
            up = add([view.up[0] * fx / flat, view.up[1] * fx / flat, view.up[2] * fx / flat], view.right as Vec3, -fy / flat);
          }
        } else {
          if (flags & FLAG_XY_QUAD) {
            right = planeX;
            up = planeY;
          }
          if (spins) {
            const angle = (particle.age * particle.spinRate + particle.spin) * particle.spinSign;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const turnedRight = add([right[0] * cos, right[1] * cos, right[2] * cos], up, sin);
            up = add([up[0] * cos, up[1] * cos, up[2] * cos], right, -sin);
            right = turnedRight;
          }
        }
        batch.add([
          add(add(center, right, -width), up, -sy),
          add(add(center, right, width), up, -sy),
          add(add(center, right, width), up, sy),
          add(add(center, right, -width), up, sy),
        ], uv, color);
      }
      if (tail) {
        const cell = evalLifeCurve(def.tailCell, 1, fraction, [0])[0];
        const uv = cellUv(cell, def.rows, def.columns);
        const time = flags & FLAG_CLAMP_TAIL_TO_AGE ? Math.min(def.tailLength, particle.age) : def.tailLength;
        const velocity = velocityOf(particle);
        const back: Vec3 = [-velocity[0] * time, -velocity[1] * time, -velocity[2] * time];
        const [fx, fy] = screen(back);
        const flatSquared = fx * fx + fy * fy;
        if (flatSquared < MIN_TAIL_SQUARED) {
          batch.add([
            add(add(center, view.right as Vec3, -sx), view.up as Vec3, -sy),
            add(add(center, view.right as Vec3, sx), view.up as Vec3, -sy),
            add(add(center, view.right as Vec3, sx), view.up as Vec3, sy),
            add(add(center, view.right as Vec3, -sx), view.up as Vec3, sy),
          ], uv, color);
          continue;
        }
        // A strip from the particle back along its way, as wide as its size
        // across that way on screen.
        const inverse = 1 / Math.sqrt(flatSquared);
        const across = add([view.right[0] * -fy * sy * inverse, view.right[1] * -fy * sy * inverse, view.right[2] * -fy * sy * inverse],
          view.up as Vec3, fx * sx * inverse);
        const end = add(center, back);
        batch.addTail(add(center, across), add(center, across, -1), add(end, across), add(end, across, -1), uv, color);
      }
    }
    batch.end();
  }

  // A ribbon as the client lays one: each frame, edges along a curve from
  // where it was to where it is (as many as its rate gives, each its own age
  // and colour), and a live edge at its head; each edge as wide as the
  // heights above and below along the bone's Y; edges sinking (or rising) by
  // gravity as they age, and dropped past their lifetime; the texture's cell
  // (by the texture slot) running along by age.
  private updateRibbon(ribbon: RibbonState, clock: TrackClock, seconds: number, layerInverse: Matrix4): void {
    const def = ribbon.def;
    const frame = ribbonFrame.copy(this.emitterMatrix(ribbon.joint, def.bonePivot, layerInverse))
      .multiply(pivotScratch.makeTranslation(def.position[0], def.position[1], def.position[2]));
    const pose: RibbonPose = { position: transformPoint(frame, [0, 0, 0]), forward: linear(frame, [0, 0, 1]), up: linear(frame, [0, 1, 0]) };
    const last = ribbon.last ?? pose;
    ribbon.last = pose;
    const rate = Math.ceil(def.edgesPerSecond);
    const lifetime = Math.max(MIN_RIBBON_LIFETIME, def.edgeLifetime);
    let dt = seconds;
    if (!ribbon.started && rate > 0) dt = 1 / rate + 0.0001;
    ribbon.started = true;
    dt = Math.min(lifetime, Math.max(0, dt));
    ribbon.edges = ribbon.edges.filter((edge) => edge.age + dt <= lifetime);

    const above = evalTrack(def.heightAbove, 1, clock, [DEFAULT_RIBBON_HEIGHT])[0];
    const below = evalTrack(def.heightBelow, 1, clock, [DEFAULT_RIBBON_HEIGHT])[0];
    const [r, g, b] = evalTrack(def.color, 3, clock, [1, 1, 1]);
    const [alpha] = evalTrack(def.alpha, 1, clock, [1]);
    const color: [number, number, number, number] = [r, g, b, Math.min(1, Math.max(0, alpha))];
    // The curve from the last pose to this one, its ends leaving along each
    // pose's forward.
    const distance = length([pose.position[0] - last.position[0], pose.position[1] - last.position[1], pose.position[2] - last.position[2]]);
    const startBelow = add(last.position, last.up, -below);
    const startAbove = add(last.position, last.up, above);
    const endBelow = add(pose.position, pose.up, -below);
    const endAbove = add(pose.position, pose.up, above);
    const startTangent: Vec3 = [last.forward[0] * distance, last.forward[1] * distance, last.forward[2] * distance];
    const endTangent: Vec3 = [pose.forward[0] * distance, pose.forward[1] * distance, pose.forward[2] * distance];
    const along = (from: Vec3, to: Vec3, t: number): Vec3 => [0, 1, 2].map((axis) =>
      (to[axis] - (1 - t) * endTangent[axis]) * t + (startTangent[axis] * t + from[axis]) * (1 - t)) as Vec3;
    const visible = evalTrack(def.visibility, 1, clock, [1])[0] !== 0;
    const live = this.emitting && visible;
    if (live) {
      const target = dt * rate + ribbon.carry;
      if (target >= 1) {
        const scale = 1 / (target - ribbon.carry);
        const steps = Math.floor(target - 1) + 1;
        for (let step = 0; step < steps; step += 1) {
          const t = (step + 1 - ribbon.carry) * scale;
          ribbon.edges.push({ below: along(startBelow, endBelow, t), above: along(startAbove, endAbove, t), age: -t * dt, color });
        }
      }
      ribbon.carry = target - Math.floor(target);
      const capacity = Math.ceil(rate * lifetime) + 2;
      if (ribbon.edges.length > capacity) ribbon.edges.splice(0, ribbon.edges.length - capacity);
    }
    for (const edge of ribbon.edges) {
      const drop = (edge.age * 2 + dt) * def.gravity * dt;
      edge.below[2] += drop;
      edge.above[2] += drop;
      edge.age += dt;
    }

    // The texture slot's cell: u along by age, the lower edge at its top.
    const columns = Math.max(1, def.columns);
    const rows = Math.max(1, def.rows);
    const slot = Math.max(0, Math.round(evalTrack(def.textureSlot, 1, clock, [0])[0]));
    const slotU = (slot % columns) / columns;
    const slotV = Math.floor(slot / columns) / rows;
    const points = live ? [...ribbon.edges, { below: endBelow, above: endAbove, age: 0, color }] : ribbon.edges;
    for (const batch of ribbon.batches) {
      batch.begin();
      for (let index = 0; index < points.length - 1; index += 1) {
        const from = points[index];
        const to = points[index + 1];
        batch.addRibbonSegment(from.below, from.above, to.below, to.above,
          slotU + (from.age / lifetime) / columns, slotU + (to.age / lifetime) / columns, slotV, slotV + 1 / rows, from.color, to.color);
      }
      batch.end();
    }
  }
}
