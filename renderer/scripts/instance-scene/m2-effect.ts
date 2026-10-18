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
  OrthographicCamera,
  Quaternion,
  RepeatWrapping,
  type Skeleton,
  SkinnedMesh,
  SrcColorFactor,
  type Texture,
  Vector3,
  ZeroFactor,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import {
  cameraDistanceFor,
  cellUvInto,
  distanceThinning,
  type EffectBlend,
  emitCount,
  evalLifeCurveInto,
  evalTrack,
  evalTrackInto,
  type ExportedTrack,
  type LifeCurve,
  materialBlend,
  particleBlend,
  particleSteps,
  signedRandom,
  type SpawnParams,
  spawnParticle,
  TWINKLE_TABLE,
  twinkleEntry,
  type TrackClock,
  uvMatrix,
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
// Particles left in the world start on the ground under them.
const FLAG_GROUND = 0x2000;
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
// Quads an emitter's batch holds before it first grows.
const PARTICLE_BATCH_START = 32;
// The client's least ribbon lifetime (seconds), and heights without a track.
const MIN_RIBBON_LIFETIME = 0.25;
const DEFAULT_RIBBON_HEIGHT = 10;
const EFFECT_RENDER_ORDER = 4;
// The longest frame an effect catches up on (seconds); a longer gap (a
// hidden tab) isn't replayed.
const MAX_FRAME_SECONDS = 1;

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
  // Shared by every instance and its particles, and never disposed: set
  // up once for scrolling, its matrix left alone (instances whose texture
  // scrolls draw with a copy of their own).
  for (const texture of textures.values()) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.matrixAutoUpdate = false;
    texture.matrix.identity();
    texture.needsUpdate = true;
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

// A copy of a texture sharing its image. Copying marks the image changed,
// which would upload it again; it hasn't, so its version is kept.
function copyTexture(texture: Texture): Texture {
  const version = texture.source.version;
  const copy = texture.clone();
  copy.source.version = version;
  return copy;
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
// It holds `capacity` quads to start with and grows, up to `maxCapacity`,
// as `begin` asks.
class QuadBatch {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private positions!: Float32Array;
  private uvs!: Float32Array;
  private colors!: Float32Array;
  count = 0;

  constructor(capacity: number, private readonly maxCapacity: number, texture: Texture | null, blend: EffectBlend) {
    const material = new MeshBasicMaterial({ map: texture, vertexColors: true, side: DoubleSide, forceSinglePass: true });
    applyBlend(material, blend);
    this.mesh = new Mesh(this.geometryFor(Math.min(capacity, maxCapacity)), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = EFFECT_RENDER_ORDER;
  }

  private geometryFor(capacity: number): BufferGeometry {
    this.positions = new Float32Array(capacity * 12);
    this.uvs = new Float32Array(capacity * 8);
    this.colors = new Float32Array(capacity * 16);
    const indices = new Uint16Array(capacity * 6);
    for (let quad = 0; quad < capacity; quad += 1) {
      const at = quad * 6;
      const corner = quad * 4;
      indices[at] = corner;
      indices[at + 1] = corner + 1;
      indices[at + 2] = corner + 2;
      indices[at + 3] = corner;
      indices[at + 4] = corner + 2;
      indices[at + 5] = corner + 3;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute('uv', new BufferAttribute(this.uvs, 2).setUsage(DynamicDrawUsage));
    geometry.setAttribute('color', new BufferAttribute(this.colors, 4).setUsage(DynamicDrawUsage));
    geometry.setIndex(new BufferAttribute(indices, 1));
    return geometry;
  }

  get capacity(): number {
    return this.positions.length / 12;
  }

  // Starts the frame's quads, with room for `quads` of them: a full batch
  // doubles (at least to that many, at most to its greatest), in new
  // buffers, since every frame writes its quads afresh.
  begin(quads = 0): void {
    this.count = 0;
    if (quads <= this.capacity || this.capacity >= this.maxCapacity) return;
    const old = this.mesh.geometry;
    this.mesh.geometry = this.geometryFor(Math.min(this.maxCapacity, Math.max(quads, this.capacity * 2)));
    old.dispose();
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
  // Where its model goes this frame, rewritten each frame.
  placement: EffectPlacement | null;
  // How far towards the camera it is this frame (sorted emitters).
  depth: number;
}

interface EmitterState {
  def: ExportedEmitter;
  joint: Object3D | null;
  particles: Particle[];
  carry: number;
  batch: QuadBatch;
  // Where its frame's origin is (layer) and was last frame, if it has one
  // yet, and what follows from its moving: the way it moved, the velocity
  // particles inherit, and the follow offset for each step.
  origin: Vec3;
  lastOrigin: Vec3;
  hasOrigin: boolean;
  moved: Vec3;
  parentVelocity: Vec3;
  inheritTimer: number;
  stepFollow: Vec3;
  // Whether a burst emitter has fired since it last showed.
  burstFired: boolean;
  // Its frame this frame (layer coordinates), and the frame's linear part
  // (a child emitter's is its parent's).
  frame: Matrix4;
  frameLinear: Matrix3;
  // Its tracks' values this frame: lifespan, whether it is enabled, its
  // rate, gravity, and how it lets particles go.
  lifeBase: number;
  enabled: boolean;
  baseRate: number;
  gravity: number;
  spawnParams: SpawnParams;
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
  // Its pose this frame and last (once it has one), swapped each frame.
  pose: RibbonPose;
  last: RibbonPose;
  hasLast: boolean;
  started: boolean;
  batches: QuadBatch[];
}

interface AnimatedMaterial {
  material: MeshBasicMaterial;
  // Whether its map is its own copy, for its UV tracks to move.
  ownsMap: boolean;
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

// Vector helpers writing into `out`, which may be one of their inputs.
const transformPointInto = (out: Vec3, matrix: Matrix4, point: Vec3): Vec3 => {
  const e = matrix.elements;
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
  out[0] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
  out[1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
  out[2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
  return out;
};
// A direction through a matrix's linear part, scale and all.
const linearInto = (out: Vec3, matrix: Matrix3, direction: Vec3): Vec3 => {
  const e = matrix.elements;
  const x = direction[0];
  const y = direction[1];
  const z = direction[2];
  out[0] = e[0] * x + e[3] * y + e[6] * z;
  out[1] = e[1] * x + e[4] * y + e[7] * z;
  out[2] = e[2] * x + e[5] * y + e[8] * z;
  return out;
};
const addInto = (out: Vec3, a: Vec3, b: Vec3, scale = 1): Vec3 => {
  out[0] = a[0] + b[0] * scale;
  out[1] = a[1] + b[1] * scale;
  out[2] = a[2] + b[2] * scale;
  return out;
};
const scaleInto = (out: Vec3, v: Vec3, scale: number): Vec3 => {
  out[0] = v[0] * scale;
  out[1] = v[1] * scale;
  out[2] = v[2] * scale;
  return out;
};
const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const normalizeInto = (out: Vec3, v: Vec3): Vec3 => {
  const size = length(v) || 1;
  out[0] = v[0] / size;
  out[1] = v[1] / size;
  out[2] = v[2] / size;
  return out;
};
// A quad's corners round `center`, `width` along `right` and `height` along
// `up` each way, in order round it.
const quadInto = (corners: Vec3[], center: Vec3, right: Vec3, width: number, up: Vec3, height: number): Vec3[] => {
  for (let axis = 0; axis < 3; axis += 1) {
    const c = center[axis];
    const r = right[axis];
    const u = up[axis];
    corners[0][axis] = c + r * -width + u * -height;
    corners[1][axis] = c + r * width + u * -height;
    corners[2][axis] = c + r * width + u * height;
    corners[3][axis] = c + r * -width + u * height;
  }
  return corners;
};
const WHITE: readonly number[] = [1, 1, 1];
const WHITE_BYTES: readonly number[] = [255, 255, 255];
const ZERO: Vec3 = [0, 0, 0];
const X_AXIS: Vec3 = [1, 0, 0];
const Y_AXIS: Vec3 = [0, 1, 0];
const Z_AXIS: Vec3 = [0, 0, 1];
// Scratch for the particle and ribbon loops; never held across a call that
// may update another instance (a model particle's).
const curveScratch = [0, 0, 0, 0];
const valueScratch = [0];
const uvScratch: [number, number, number, number] = [0, 0, 0, 0];
const colorScratch: [number, number, number, number] = [0, 0, 0, 0];
const cornerScratch: Vec3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const centerScratch: Vec3 = [0, 0, 0];
const velocityScratch: Vec3 = [0, 0, 0];
const rightScratch: Vec3 = [0, 0, 0];
const upScratch: Vec3 = [0, 0, 0];
const planeXScratch: Vec3 = [0, 0, 0];
const planeYScratch: Vec3 = [0, 0, 0];
const acrossScratch: Vec3 = [0, 0, 0];
const endScratch: Vec3 = [0, 0, 0];
const atScratch: Vec3 = [0, 0, 0];
const beforeScratch: Vec3 = [0, 0, 0];
const fromScratch: Vec3 = [0, 0, 0];
const childMovedScratch: Vec3 = [0, 0, 0];
const ribbonScratch = { startBelow: [0, 0, 0] as Vec3, startAbove: [0, 0, 0] as Vec3, endBelow: [0, 0, 0] as Vec3, endAbove: [0, 0, 0] as Vec3,
  startTangent: [0, 0, 0] as Vec3, endTangent: [0, 0, 0] as Vec3 };
const billboardA = new Vector3();
const billboardB = new Vector3();
const billboardC = new Vector3();

// A one-number track's value, or `fallback`.
const trackValue = (track: ExportedTrack | null, clock: TrackClock, fallback: number): number =>
  (evalTrackInto(track, 1, clock, valueScratch) ? valueScratch[0] : fallback);
const byDepth = (a: Particle, b: Particle): number => a.depth - b.depth;
// A particle's colour and opacity `fraction` through its life, by its
// emitter's curves, as bytes made 0 to 1 (opacity to the byte by
// `toByte`: model particles floor it, quads round it).
function particleColorInto(out: [number, number, number, number], def: ExportedEmitter, fraction: number,
  toByte: (value: number) => number): [number, number, number, number] {
  const color = evalLifeCurveInto(def.color, 3, fraction, curveScratch) ? curveScratch : WHITE_BYTES;
  out[0] = Math.round(color[0]) / 255;
  out[1] = Math.round(color[1]) / 255;
  out[2] = Math.round(color[2]) / 255;
  const alpha = evalLifeCurveInto(def.alpha, 1, fraction, curveScratch) ? curveScratch[0] : 1;
  out[3] = Math.min(1, Math.max(0, toByte(alpha * 255) / 255));
  return out;
}
// How long a particle of the emitter lives (seconds), by its life seed.
const particleLife = (emitter: EmitterState, lifeSeed: number): number =>
  Math.max(MIN_LIFE, emitter.lifeBase + lifeSeed * emitter.def.lifespanVariation);
// The most edges a ribbon keeps: as many as it lays in a lifetime, and two.
const ribbonRate = (def: ExportedRibbon): number => Math.ceil(def.edgesPerSecond);
const ribbonLifetime = (def: ExportedRibbon): number => Math.max(MIN_RIBBON_LIFETIME, def.edgeLifetime);
const ribbonEdgeLimit = (def: ExportedRibbon): number => Math.ceil(ribbonRate(def) * ribbonLifetime(def)) + 2;
const newPose = (): RibbonPose => ({ position: [0, 0, 0], forward: [0, 0, 0], up: [0, 0, 0] });

// The camera's directions in the layer's coordinates, for billboards.
// What an emitter's particles are let go into this frame: the share of its
// rate it lets go for its distance, and the ground.
interface Surroundings {
  thinning: number;
  ground: EffectView['ground'];
}

export interface EffectView {
  right: Vec3;
  up: Vec3;
  toCamera: Vec3;
  // How far a point (layer coordinates) is from the camera, in yards. An
  // orthographic view puts everything as far as the client's camera would
  // stand to show as much.
  distance: (point: Vec3) => number;
  // The height of the ground below a point (layer coordinates), or null if
  // there's none near.
  ground: ((point: Vec3) => number | null) | null;
}

export function getEffectView(camera: Camera, layer: Object3D, ground: EffectView['ground'] = null): EffectView {
  const inverse = tempQuaternion.copy(layer.getWorldQuaternion(new Quaternion())).invert();
  const direction = (x: number, y: number, z: number): Vec3 => {
    const vector = new Vector3(x, y, z).applyQuaternion(camera.quaternion).applyQuaternion(inverse);
    return [vector.x, vector.y, vector.z];
  };
  let distance: EffectView['distance'];
  if (camera instanceof OrthographicCamera) {
    const standing = cameraDistanceFor((camera.top - camera.bottom) / camera.zoom);
    distance = () => standing;
  } else {
    const { x, y, z } = layer.worldToLocal(camera.getWorldPosition(new Vector3()));
    distance = (point) => Math.hypot(point[0] - x, point[1] - y, point[2] - z);
  }
  return { right: direction(1, 0, 0), up: direction(0, 1, 0), toCamera: direction(0, 0, 1), distance, ground };
}

export class EffectInstance {
  // Placed in the layer; the model hangs under it.
  readonly root = new Group();
  // Particles and ribbons, in layer coordinates.
  readonly particles = new Group();
  private readonly model: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly emitters: EmitterState[];
  // The emitters and their child emitters.
  private readonly everyEmitter: EmitterState[];
  private readonly ribbons: RibbonState[];
  private readonly billboards: Object3D[] = [];
  // Its copy's skeletons, each with a bone texture to free.
  private readonly skeletons = new Set<Skeleton>();
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
  private readonly tint: [number, number, number, number] = [1, 1, 1, 1];

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
      if (object instanceof SkinnedMesh) this.skeletons.add(object.skeleton);
    });
    const emitterState = (def: ExportedEmitter, child: boolean): EmitterState => {
      // A head and a tail for each particle, at most.
      const batch = new QuadBatch(PARTICLE_BATCH_START, MAX_PARTICLES_PER_EMITTER * 2, def.textureMaterial ? template.textures.get(def.textureMaterial) ?? null : null,
        particleBlend(def.blendingType));
      batch.mesh.renderOrder = EFFECT_RENDER_ORDER + (def.priorityPlane ?? 0) / 1000;
      this.particles.add(batch.mesh);
      const childDefs = child || def.childEmitters === undefined ? [] : template.particleModels[def.childEmitters]?.effect.emitters ?? [];
      return {
        def, joint: child ? null : joints.get(def.bone) ?? null, particles: [], carry: 0, batch,
        origin: [0, 0, 0], lastOrigin: [0, 0, 0], hasOrigin: false, moved: [0, 0, 0], parentVelocity: [0, 0, 0], inheritTimer: 0,
        stepFollow: [0, 0, 0], burstFired: false, frame: new Matrix4(), frameLinear: new Matrix3(),
        lifeBase: 1, enabled: false, baseRate: 0, gravity: 0,
        spawnParams: {
          emitterType: def.emitterType, areaWidth: 0, areaLength: 0, verticalRange: 0, horizontalRange: 0, speed: 0, speedVariation: 0, zSource: 0,
          upward: def.emitterType === 2 && Boolean(def.flags & FLAG_UPWARD), splinePoints: def.splinePoints,
        },
        model: def.particleModel === undefined ? null : template.particleModels[def.particleModel] ?? null,
        children: childDefs.map((childDef) => emitterState(childDef, true)),
        child,
      };
    };
    this.emitters = template.effect.emitters.map((def) => emitterState(def, false));
    this.everyEmitter = this.emitters.flatMap((emitter) => [emitter, ...emitter.children]);
    this.ribbons = template.effect.ribbons.map((def) => {
      const passes = def.passes?.length ? def.passes : [{ textureMaterial: def.textureMaterial, blend: def.blend }];
      // As many segments as it keeps edges (one to the live head).
      const segments = Math.min(MAX_RIBBON_EDGES, ribbonEdgeLimit(def) + 1);
      const batches = passes.map((pass) => {
        const batch = new QuadBatch(segments, segments, pass.textureMaterial ? template.textures.get(pass.textureMaterial) ?? null : null,
          materialBlend(pass.blend));
        this.particles.add(batch.mesh);
        return batch;
      });
      return { def, joint: joints.get(def.bone) ?? null, edges: [], carry: 0, pose: newPose(), last: newPose(), hasLast: false, started: false, batches };
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
  // Impact; then it stops emitting and hides the model, and particles live
  // out (a missile's ribbons too).
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
    // Only a missile's ribbons outlast it; any other effect's go with its
    // model, as only its particles keep it alive.
    if (!this.missile) for (const ribbon of this.ribbons) ribbon.edges.length = 0;
  }

  get stopped(): boolean {
    return this.stopRequested;
  }

  // Stopped, with nothing left on screen.
  get done(): boolean {
    if (this.emitting) return false;
    for (const emitter of this.everyEmitter) if (emitter.particles.length) return false;
    for (const ribbon of this.ribbons) if (ribbon.edges.length) return false;
    return true;
  }

  update(now: number, placement: EffectPlacement, view: EffectView, layer: Object3D, budget: { left: number }): void {
    const seconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - this.lastAt) / 1000));
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

  // Draws it in this colour and opacity on top of its own.
  setTint(red: number, green: number, blue: number, alpha: number): void {
    const tint = this.tint;
    tint[0] = red;
    tint[1] = green;
    tint[2] = blue;
    tint[3] = alpha;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const emitter of this.everyEmitter) {
      emitter.batch.dispose();
      for (const particle of emitter.particles) particle.model?.dispose();
    }
    for (const ribbon of this.ribbons) for (const batch of ribbon.batches) batch.dispose();
    // Maps are the template's (or copies sharing its image), so stay.
    for (const animated of this.materials) animated.material.dispose();
    for (const skeleton of this.skeletons) skeleton.dispose();
    this.root.removeFromParent();
    this.particles.removeFromParent();
  }

  private adoptMaterial(mesh: Mesh): void {
    mesh.frustumCulled = false;
    mesh.renderOrder = EFFECT_RENDER_ORDER;
    const source = mesh.material as Material;
    const extras = source.userData;
    const texture = typeof extras.wowTexture === 'string' ? this.template.textures.get(extras.wowTexture) : undefined;
    // A texture that scrolls needs a copy of its own for its matrix; the
    // copy shares the template's image (and so its GPU texture).
    const ownsMap = Boolean(texture && (extras.wowUvTranslation || extras.wowUvRotation || extras.wowUvScaling));
    const map = texture ? (ownsMap ? copyTexture(texture) : texture) : null;
    const material = new MeshBasicMaterial({ map, side: DoubleSide, forceSinglePass: true });
    applyBlend(material, typeof extras.wowBlendMode === 'number' ? materialBlend(extras.wowBlendMode) : geometryBlend(extras.wowBlend));
    mesh.material = material;
    this.materials.push({
      material,
      ownsMap,
      color: extras.wowColor ?? null,
      alpha: extras.wowAlpha ?? null,
      weight: extras.wowWeight ?? null,
      uvTranslation: extras.wowUvTranslation ?? null,
      uvRotation: extras.wowUvRotation ?? null,
      uvScaling: extras.wowUvScaling ?? null,
    });
  }

  private animateMaterials(clock: TrackClock): void {
    const tint = this.tint;
    for (const animated of this.materials) {
      const color = evalTrackInto(animated.color, 3, clock, curveScratch) ? curveScratch : WHITE;
      animated.material.color.setRGB(color[0] * tint[0], color[1] * tint[1], color[2] * tint[2]);
      const alpha = trackValue(animated.alpha, clock, 1) * trackValue(animated.weight, clock, 1) * tint[3];
      animated.material.opacity = Math.min(1, Math.max(0, alpha));
      const map = animated.material.map;
      if (!map || !animated.ownsMap) continue;
      map.matrix.set(...uvMatrix(evalTrack(animated.uvTranslation, 3, clock, [0, 0, 0]), evalTrack(animated.uvRotation, 4, clock, [0, 0, 0, 1]),
        evalTrack(animated.uvScaling, 3, clock, [1, 1, 1])));
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
    // The screen's direction for (right, up), made a unit world axis.
    const fromScreenInto = (out: Vector3, right: number, up: number): Vector3 => {
      const size = Math.hypot(right, up) || 1;
      return out.copy(screenRight).multiplyScalar(right / size).addScaledVector(screenUp, up / size);
    };
    for (const bone of this.billboards) {
      const flags = bone.userData.wowBillboard as number;
      bone.parent?.getWorldQuaternion(tempParent);
      if (flags & BILLBOARD_SPHERICAL || !(flags & (BILLBOARD_LOCK_X | BILLBOARD_LOCK_Y | BILLBOARD_LOCK_Z))) {
        bone.quaternion.copy(tempParent.invert().multiply(facing).multiply(bone.quaternion));
      } else {
        // The bone's axes as animated, in the world.
        const turn = tempQuaternion.copy(tempParent).multiply(bone.quaternion);
        const a = billboardA.set(1, 0, 0).applyQuaternion(turn);
        const b = billboardB.set(0, 1, 0).applyQuaternion(turn);
        const c = billboardC.set(0, 0, 1).applyQuaternion(turn);
        // The locked axis's (right, up) on screen.
        if (flags & BILLBOARD_LOCK_X) {
          fromScreenInto(b, a.dot(screenUp), -a.dot(screenRight));
          c.crossVectors(a, b);
        } else if (flags & BILLBOARD_LOCK_Y) {
          fromScreenInto(a, -b.dot(screenUp), b.dot(screenRight));
          c.crossVectors(a, b);
        } else {
          fromScreenInto(b, c.dot(screenUp), -c.dot(screenRight));
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
    const frameLinear = emitter.frameLinear.setFromMatrix4(frame);
    const origin = transformPointInto(emitter.origin, frame, ZERO);
    const lastOrigin = emitter.hasOrigin ? emitter.lastOrigin : origin;
    const moved = emitter.moved;
    for (let axis = 0; axis < 3; axis += 1) moved[axis] = origin[axis] - lastOrigin[axis];
    scaleInto(emitter.lastOrigin, origin, 1);
    emitter.hasOrigin = true;
    // The frame's scale along its X.
    const frameScale = Math.hypot(frameLinear.elements[0], frameLinear.elements[1], frameLinear.elements[2]);
    this.prepareEmitter(emitter, clock);
    for (const child of emitter.children) {
      child.frameLinear.copy(frameLinear);
      this.prepareEmitter(child, clock);
    }

    // What follows from the emitter moving: particles it leaves follow it
    // by a share that grows with its speed, and new ones inherit its speed.
    let share = 0;
    if (flags & FLAG_FOLLOW && seconds > 0) {
      const [speed1, scale1, speed2, scale2] = [def.followSpeed1 ?? 0, def.followScale1 ?? 0, def.followSpeed2 ?? 0, def.followScale2 ?? 0];
      const slope = Math.abs(speed2 - speed1) < 2.3841858e-7 ? 0 : (scale2 - scale1) / (speed2 - speed1);
      const intercept = Math.abs(speed2 - speed1) < 2.3841858e-7 ? 0 : scale1 - speed1 * slope;
      share = Math.min(1, Math.max(0, (length(moved) / seconds) * slope + intercept));
    }
    if (flags & FLAG_INHERIT_VELOCITY) {
      emitter.inheritTimer += seconds;
      if (emitter.inheritTimer > INHERIT_VELOCITY_STEP) {
        const scale = emitter.particles.length ? (def.inheritVelocityScale ?? 0) / (emitter.inheritTimer * 30) : 0;
        for (let axis = 0; axis < 3; axis += 1) emitter.parentVelocity[axis] = moved[axis] * scale;
        emitter.inheritTimer = 0;
      }
    }

    // A long frame goes in steps, the following shared between them; the
    // emitter lets fewer go the further it is from the camera, and its
    // child emitters as many fewer.
    const steps = particleSteps(seconds, emitter.lifeBase);
    const stepFollow = emitter.stepFollow;
    for (let axis = 0; axis < 3; axis += 1) stepFollow[axis] = (moved[axis] * share) / steps.length;
    const around: Surroundings = { thinning: distanceThinning(view.distance(origin)), ground: view.ground };
    for (const step of steps) {
      this.spawn(emitter, this.birthCount(emitter, step, around.thinning), frame, moved, step, around.ground, budget);
      this.moveParticles(emitter, step, origin, stepFollow, frame, around, budget);
      // Its child emitters' particles, born at its own (as they move).
      for (const child of emitter.children) this.moveParticles(child, step, null, ZERO, frame, around, budget);
    }
    budget.left -= emitter.particles.length;
    for (const child of emitter.children) budget.left -= child.particles.length;
    if (emitter.model) this.drawParticleModels(emitter, frame, frameScale, view, budget);
    else this.drawParticles(emitter, frame, frameScale, view);
    for (const child of emitter.children) this.drawParticles(child, frame, frameScale, view);
  }

  // The emitter's tracks' values this frame.
  private prepareEmitter(emitter: EmitterState, clock: TrackClock): void {
    const def = emitter.def;
    emitter.lifeBase = trackValue(def.lifespan, clock, 1);
    emitter.enabled = trackValue(def.enabled, clock, 1) !== 0;
    emitter.baseRate = trackValue(def.emissionRate, clock, 0);
    emitter.gravity = -(evalTrackInto(def.gravity, 3, clock, curveScratch) ? curveScratch[2] : 0);
    const spawn = emitter.spawnParams;
    spawn.areaWidth = trackValue(def.emissionAreaWidth, clock, 0);
    spawn.areaLength = trackValue(def.emissionAreaLength, clock, 0);
    spawn.verticalRange = trackValue(def.verticalRange, clock, 0);
    spawn.horizontalRange = trackValue(def.horizontalRange, clock, 0);
    spawn.speed = trackValue(def.emissionSpeed, clock, 0);
    spawn.speedVariation = trackValue(def.speedVariation, clock, 0);
    spawn.zSource = trackValue(def.zSource, clock, 0);
  }

  // How many particles an emitter lets go this step, its rate scaled by
  // `thinning`. A burst emitter lets its rate's worth go at once as it
  // shows; the rest emit at their rate (with its variation), carrying the
  // remainder.
  private birthCount(emitter: EmitterState, seconds: number, thinning: number): number {
    const def = emitter.def;
    const visible = this.emitting && emitter.enabled;
    const base = visible ? emitter.baseRate : 0;
    const rate = (base + signedRandom() * def.emissionRateVariation) * thinning;
    if (def.flags & FLAG_BURST) {
      const fired = emitter.burstFired;
      emitter.burstFired = visible && base > 0;
      return visible && base > 0 && !fired ? Math.max(0, Math.floor(rate)) : 0;
    }
    if (!visible) return 0;
    const { count, carry } = emitCount(emitter.carry, rate, seconds);
    emitter.carry = carry;
    return count;
  }

  // New particles from the emitter's frame (layer coordinates), `moved` the
  // way it came this frame, those flagged so put on `ground`.
  private spawn(emitter: EmitterState, births: number, frame: Matrix4, moved: Vec3, seconds: number,
    ground: EffectView['ground'], budget: { left: number }): void {
    const room = Math.min(births, MAX_PARTICLES_PER_EMITTER - emitter.particles.length, Math.max(0, budget.left));
    if (room <= 0) return;
    const def = emitter.def;
    const flags = def.flags;
    const local = isLocal(emitter);
    const cells = Math.max(1, def.rows * def.columns);
    for (let index = 0; index < room; index += 1) {
      // Its position and velocity are its own from here, changed in place.
      const { position, velocity } = spawnParticle(emitter.spawnParams);
      const age = Math.random() * seconds;
      const lifeSeed = signedRandom();
      if (!local) {
        transformPointInto(position, frame, position);
        linearInto(velocity, emitter.frameLinear, velocity);
        // Spread along the way the emitter came this frame.
        if (flags & FLAG_SPREAD_ALONG_PATH) addInto(position, position, moved, Math.random() - 1);
        // On the ground, lifted by its size then.
        const height = flags & FLAG_GROUND && ground ? ground(position) : null;
        if (height !== null) {
          const sized = evalLifeCurveInto(def.scale, 2, age / particleLife(emitter, lifeSeed), curveScratch);
          position[2] = height + (sized ? Math.max(curveScratch[0], curveScratch[1]) : 1);
        }
      }
      if (flags & FLAG_INHERIT_VELOCITY) addInto(velocity, velocity, emitter.parentVelocity, 1 + signedRandom() * emitter.spawnParams.speedVariation);
      const scaleX = 1 + signedRandom() * (def.scaleVary?.[0] ?? 0);
      const model = emitter.model ? this.spawnModel(emitter, frame, local, flags) : null;
      emitter.particles.push({
        position, velocity, age, lifeSeed,
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
        placement: model ? { position: [0, 0, 0], yaw: 0, quaternion: [0, 0, 0, 1], scale: 1, stretch: [1, 1, 1] } : null,
        depth: 0,
      });
    }
    budget.left -= room;
  }

  // Moves an emitter's particles and drops the dead, keeping their order:
  // wind while it blows, following the emitter, then their own speed,
  // gravity down its frame's Z, and drag. Each that lives lets its child
  // emitters' particles go from where it is (in its surroundings), turned
  // as the emitter's frame (`frame`) is, as it moved and heading as it
  // heads. `origin` is the emitter's (null for a child's particles, which
  // never die heading outward).
  private moveParticles(emitter: EmitterState, seconds: number, origin: Vec3 | null, follow: Vec3,
    frame: Matrix4, around: Surroundings, budget: { left: number }): void {
    const def = emitter.def;
    const flags = def.flags;
    const local = isLocal(emitter);
    const gravity = emitter.gravity;
    const wind = (def.wind ?? ZERO) as Vec3;
    const windTime = def.windTime ?? 0;
    const drag = Math.min(1, def.drag * seconds);
    const killOutward = Boolean(origin && def.emitterType === 2 && flags & FLAG_KILL_OUTWARD);
    const children = emitter.children;
    const particles = emitter.particles;
    let kept = 0;
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index];
      const position = particle.position;
      const velocity = particle.velocity;
      beforeScratch[0] = position[0];
      beforeScratch[1] = position[1];
      beforeScratch[2] = position[2];
      particle.age += seconds;
      let alive = particle.age < particleLife(emitter, particle.lifeSeed);
      if (alive) {
        if (particle.orientation) this.tumble(particle, seconds);
        if (windTime > particle.age) addInto(velocity, velocity, wind, seconds);
        if (flags & FLAG_FOLLOW && particle.age > seconds * 2) addInto(position, position, follow);
        const stepX = velocity[0] * seconds;
        const stepY = velocity[1] * seconds;
        const stepZ = velocity[2] * seconds;
        position[0] += stepX;
        position[1] += stepY;
        position[2] += stepZ;
        position[2] -= gravity * seconds * seconds * 0.5;
        velocity[2] -= gravity * seconds;
        if (drag) {
          velocity[0] *= 1 - drag;
          velocity[1] *= 1 - drag;
          velocity[2] *= 1 - drag;
        }
        // A sphere's particles flagged so die as they head outward.
        if (killOutward) {
          const from = local ? ZERO : origin!;
          if ((position[0] - from[0]) * stepX + (position[1] - from[1]) * stepY + (position[2] - from[2]) * stepZ > 0) alive = false;
        }
      }
      if (!alive) {
        particle.model?.dispose();
        continue;
      }
      if (children.length) {
        const at = local ? transformPointInto(atScratch, frame, position) : position;
        const from = local ? transformPointInto(fromScratch, frame, beforeScratch) : beforeScratch;
        for (let axis = 0; axis < 3; axis += 1) childMovedScratch[axis] = at[axis] - from[axis];
        const childFrame = childFrameScratch.copy(frame).setPosition(at[0], at[1], at[2]);
        for (const child of children) {
          if (local) linearInto(child.parentVelocity, emitter.frameLinear, velocity);
          else scaleInto(child.parentVelocity, velocity, 1);
          this.spawn(child, this.birthCount(child, seconds, around.thinning), childFrame, childMovedScratch, seconds, around.ground, budget);
        }
      }
      particles[kept] = particle;
      kept += 1;
    }
    particles.length = kept;
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
  private drawParticleModels(emitter: EmitterState, frame: Matrix4, frameScale: number, view: EffectView, budget: { left: number }): void {
    const def = emitter.def;
    const flags = def.flags;
    const local = Boolean(flags & FLAG_LOCAL);
    const twinkleBase = def.twinkleScale?.[0] ?? 1;
    const twinkleSpan = (def.twinkleScale?.[1] ?? 1) - twinkleBase;
    const twinkles = def.twinklePercent < 1 || twinkleSpan !== 0;
    const layer = this.particles.parent ?? this.particles;
    for (const particle of emitter.particles) {
      const model = particle.model;
      const placement = particle.placement;
      if (!model || !particle.orientation || !placement) continue;
      const entry = twinkles ? twinkleEntry(particle.age, def.twinkleSpeed, particle.twinkle) : TWINKLE_TABLE[0];
      const shown = !(def.twinklePercent < 1 && def.twinklePercent < entry);
      model.root.visible = shown;
      model.particles.visible = shown;
      if (!shown) continue;
      const fraction = particle.age / particleLife(emitter, particle.lifeSeed);
      const [red, green, blue, alpha] = particleColorInto(colorScratch, def, fraction, Math.floor);
      model.setTint(red, green, blue, alpha);
      const scaled = evalLifeCurveInto(def.scale, 2, fraction, curveScratch);
      const sizeScale = (twinkleSpan * entry + twinkleBase) * (!local && flags & FLAG_MODEL_SCALE ? frameScale : 1);
      const sx = (scaled ? curveScratch[0] : 1) * sizeScale;
      const sy = (scaled ? curveScratch[1] : 1) * sizeScale;
      particleMatrix.compose(particlePosition.fromArray(particle.position), particle.orientation, particleScale.set(sx, sy, (sx + sy) / 2));
      if (local) particleMatrix.premultiply(frame);
      particleMatrix.decompose(particlePosition, particleTurn, particleScale);
      particlePosition.toArray(placement.position);
      particleTurn.toArray(placement.quaternion!);
      particleScale.toArray(placement.stretch!);
      model.update(this.lastAt, placement, view, layer, budget);
    }
  }

  // Each particle as the client builds it: a quad facing the screen (or
  // lying in the XY plane), turned by its spin or stretched along its way,
  // and a tail behind it, sized by its scale curve and variation and
  // twinkle, coloured by its curves.
  private drawParticles(emitter: EmitterState, frame: Matrix4, frameScale: number, view: EffectView): void {
    const def = emitter.def;
    const flags = def.flags;
    const local = Boolean(flags & FLAG_LOCAL);
    const batch = emitter.batch;
    const head = Boolean(flags & FLAG_HEAD);
    const tail = Boolean(flags & FLAG_TAIL);
    const particles = emitter.particles;
    batch.begin(particles.length * ((head ? 1 : 0) + (tail ? 1 : 0)));
    if (!head && !tail) {
      batch.end();
      return;
    }
    const frameLinear = emitter.frameLinear;
    const viewRight = view.right;
    const viewUp = view.up;
    if (flags & FLAG_SORT) {
      const toCamera = view.toCamera;
      for (const particle of particles) {
        const center = local ? transformPointInto(centerScratch, frame, particle.position) : particle.position;
        particle.depth = center[0] * toCamera[0] + center[1] * toCamera[1] + center[2] * toCamera[2];
      }
      particles.sort(byDepth);
    }
    const twinkleBase = def.twinkleScale?.[0] ?? 1;
    const twinkleSpan = (def.twinkleScale?.[1] ?? 1) - twinkleBase;
    const twinkles = def.twinklePercent < 1 || twinkleSpan !== 0;
    const spins = def.spin !== 0 || def.spinVariation !== 0;
    // The XY plane: the layer's for particles left in the world, the
    // emitter's (unscaled) for those that move with it.
    const planeX = local ? normalizeInto(planeXScratch, linearInto(planeXScratch, frameLinear, X_AXIS)) : X_AXIS;
    const planeY = local ? normalizeInto(planeYScratch, linearInto(planeYScratch, frameLinear, Y_AXIS)) : Y_AXIS;
    const color = colorScratch;
    for (const particle of particles) {
      const entry = twinkles ? twinkleEntry(particle.age, def.twinkleSpeed, particle.twinkle) : TWINKLE_TABLE[0];
      if (def.twinklePercent < 1 && def.twinklePercent < entry) continue;
      const fraction = particle.age / particleLife(emitter, particle.lifeSeed);
      particleColorInto(color, def, fraction, Math.round);
      const scaled = evalLifeCurveInto(def.scale, 2, fraction, curveScratch);
      const sizeScale = (twinkleSpan * entry + twinkleBase) * (flags & FLAG_MODEL_SCALE ? frameScale : 1);
      const sx = (scaled ? curveScratch[0] : 1) * particle.scaleX * sizeScale;
      const sy = (scaled ? curveScratch[1] : 1) * particle.scaleY * sizeScale;
      const center = local ? transformPointInto(centerScratch, frame, particle.position) : particle.position;
      const velocity = local ? linearInto(velocityScratch, frameLinear, particle.velocity) : particle.velocity;
      if (head) {
        const cell = def.headCell.t.length ? (evalLifeCurveInto(def.headCell, 1, fraction, curveScratch) ? curveScratch[0] : 0) : particle.cell;
        const uv = cellUvInto(cell, def.rows, def.columns, uvScratch);
        let right = viewRight;
        let up = viewUp;
        let width = sx;
        const speedSquared = velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2];
        if (flags & FLAG_VELOCITY_ORIENT && speedSquared > 2.3841858e-7) {
          // Along the way it goes on screen, longer the more of its speed
          // shows there.
          const fx = -(velocity[0] * viewRight[0] + velocity[1] * viewRight[1] + velocity[2] * viewRight[2]);
          const fy = -(velocity[0] * viewUp[0] + velocity[1] * viewUp[1] + velocity[2] * viewUp[2]);
          const flat = Math.hypot(fx, fy);
          if (flat > 2.3841858e-7) {
            width = (flat / Math.sqrt(speedSquared)) * sx;
            for (let axis = 0; axis < 3; axis += 1) {
              rightScratch[axis] = viewRight[axis] * fx / flat + viewUp[axis] * (fy / flat);
              upScratch[axis] = viewUp[axis] * fx / flat + viewRight[axis] * (-fy / flat);
            }
            right = rightScratch;
            up = upScratch;
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
            for (let axis = 0; axis < 3; axis += 1) {
              const r = right[axis];
              const u = up[axis];
              rightScratch[axis] = r * cos + u * sin;
              upScratch[axis] = u * cos + r * -sin;
            }
            right = rightScratch;
            up = upScratch;
          }
        }
        batch.add(quadInto(cornerScratch, center, right, width, up, sy), uv, color);
      }
      if (tail) {
        const cell = evalLifeCurveInto(def.tailCell, 1, fraction, curveScratch) ? curveScratch[0] : 0;
        const uv = cellUvInto(cell, def.rows, def.columns, uvScratch);
        const time = flags & FLAG_CLAMP_TAIL_TO_AGE ? Math.min(def.tailLength, particle.age) : def.tailLength;
        const backX = -velocity[0] * time;
        const backY = -velocity[1] * time;
        const backZ = -velocity[2] * time;
        const fx = backX * viewRight[0] + backY * viewRight[1] + backZ * viewRight[2];
        const fy = backX * viewUp[0] + backY * viewUp[1] + backZ * viewUp[2];
        const flatSquared = fx * fx + fy * fy;
        if (flatSquared < MIN_TAIL_SQUARED) {
          batch.add(quadInto(cornerScratch, center, viewRight, sx, viewUp, sy), uv, color);
          continue;
        }
        // A strip from the particle back along its way, as wide as its size
        // across that way on screen.
        const inverse = 1 / Math.sqrt(flatSquared);
        for (let axis = 0; axis < 3; axis += 1) acrossScratch[axis] = viewRight[axis] * -fy * sy * inverse + viewUp[axis] * (fx * sx * inverse);
        endScratch[0] = center[0] + backX;
        endScratch[1] = center[1] + backY;
        endScratch[2] = center[2] + backZ;
        const [a, b, c, d] = cornerScratch;
        addInto(a, center, acrossScratch);
        addInto(b, center, acrossScratch, -1);
        addInto(c, endScratch, acrossScratch);
        addInto(d, endScratch, acrossScratch, -1);
        batch.addTail(a, b, c, d, uv, color);
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
    const frameLinear = tempMatrix3.setFromMatrix4(frame);
    const pose = ribbon.pose;
    transformPointInto(pose.position, frame, ZERO);
    linearInto(pose.forward, frameLinear, Z_AXIS);
    linearInto(pose.up, frameLinear, Y_AXIS);
    const last = ribbon.hasLast ? ribbon.last : pose;
    const rate = ribbonRate(def);
    const lifetime = ribbonLifetime(def);
    let dt = seconds;
    if (!ribbon.started && rate > 0) dt = 1 / rate + 0.0001;
    ribbon.started = true;
    dt = Math.min(lifetime, Math.max(0, dt));
    const edges = ribbon.edges;
    let kept = 0;
    for (let index = 0; index < edges.length; index += 1) {
      if (edges[index].age + dt > lifetime) continue;
      edges[kept] = edges[index];
      kept += 1;
    }
    edges.length = kept;

    const above = trackValue(def.heightAbove, clock, DEFAULT_RIBBON_HEIGHT);
    const below = trackValue(def.heightBelow, clock, DEFAULT_RIBBON_HEIGHT);
    // New edges keep this frame's colour.
    const [r, g, b] = evalTrack(def.color, 3, clock, [1, 1, 1]);
    const alpha = trackValue(def.alpha, clock, 1);
    const color: [number, number, number, number] = [r, g, b, Math.min(1, Math.max(0, alpha))];
    // The curve from the last pose to this one, its ends leaving along each
    // pose's forward.
    const distance = Math.hypot(pose.position[0] - last.position[0], pose.position[1] - last.position[1], pose.position[2] - last.position[2]);
    const { startBelow, startAbove, endBelow, endAbove, startTangent, endTangent } = ribbonScratch;
    addInto(startBelow, last.position, last.up, -below);
    addInto(startAbove, last.position, last.up, above);
    addInto(endBelow, pose.position, pose.up, -below);
    addInto(endAbove, pose.position, pose.up, above);
    scaleInto(startTangent, last.forward, distance);
    scaleInto(endTangent, pose.forward, distance);
    const along = (from: Vec3, to: Vec3, t: number): Vec3 => [0, 1, 2].map((axis) =>
      (to[axis] - (1 - t) * endTangent[axis]) * t + (startTangent[axis] * t + from[axis]) * (1 - t)) as Vec3;
    const visible = trackValue(def.visibility, clock, 1) !== 0;
    const live = this.emitting && visible;
    if (live) {
      const target = dt * rate + ribbon.carry;
      if (target >= 1) {
        const scale = 1 / (target - ribbon.carry);
        const steps = Math.floor(target - 1) + 1;
        for (let step = 0; step < steps; step += 1) {
          const t = (step + 1 - ribbon.carry) * scale;
          edges.push({ below: along(startBelow, endBelow, t), above: along(startAbove, endAbove, t), age: -t * dt, color });
        }
      }
      ribbon.carry = target - Math.floor(target);
      const capacity = ribbonEdgeLimit(def);
      if (edges.length > capacity) edges.splice(0, edges.length - capacity);
    }
    for (const edge of edges) {
      const drop = (edge.age * 2 + dt) * def.gravity * dt;
      edge.below[2] += drop;
      edge.above[2] += drop;
      edge.age += dt;
    }
    // This pose is next frame's last.
    ribbon.pose = ribbon.last;
    ribbon.last = pose;
    ribbon.hasLast = true;

    // The texture slot's cell: u along by age, the lower edge at its top;
    // the edges in turn, then the live head.
    const columns = Math.max(1, def.columns);
    const rows = Math.max(1, def.rows);
    const slot = Math.max(0, Math.round(trackValue(def.textureSlot, clock, 0)));
    const slotU = (slot % columns) / columns;
    const slotV = Math.floor(slot / columns) / rows;
    const u = (age: number) => slotU + (age / lifetime) / columns;
    for (const batch of ribbon.batches) {
      batch.begin();
      for (let index = 0; index < edges.length - 1; index += 1) {
        const from = edges[index];
        const to = edges[index + 1];
        batch.addRibbonSegment(from.below, from.above, to.below, to.above, u(from.age), u(to.age), slotV, slotV + 1 / rows, from.color, to.color);
      }
      const newest = edges[edges.length - 1];
      if (live && newest) {
        batch.addRibbonSegment(newest.below, newest.above, endBelow, endAbove, u(newest.age), u(0), slotV, slotV + 1 / rows, newest.color, color);
      }
      batch.end();
    }
  }
}
