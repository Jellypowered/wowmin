import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Bone,
  Box3,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  LoopOnce,
  LoopRepeat,
  type Frustum,
  type Material,
  Matrix4,
  Quaternion,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  Object3D,
  RingGeometry,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
  DetachedBindMode,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { LightColors } from '../utils/map-light';
import { type EffectBlend, m2MaterialLight } from '../utils/m2-tracks';
import { blendFactors } from './m2-blend';
import type { Point3, StrikeKind } from '../utils/spell-events';
import type { EffectScales } from '../utils/spell-kits';
import {
  chooseUnitStance,
  getMoveTimeScale,
  getStanceClips,
  getStrikeInterval,
  isItemShown,
  type UnitCombatStyle,
  type UnitStance,
  type UnitWeapons,
} from '../utils/unit-animation';
import { threeToServer, useServerAxes } from './iso-camera';
import { LIT_SUM_FUNCTION, pointLightFunction, pointLights } from './point-lights';

// A pet's model scale above this is a giant's (see UnitModelPose.pet).
const PET_OVERSIZED_DISPLAY_SCALE = 2;

// How a unit's spells' kits change its model: a colour it is multiplied by
// (0xRRGGBB, null for none) and how see-through it is (1 opaque); and its
// own light, where it is not the map's as every unit outdoors shares it
// (indoors, the building's on the floor under it; outdoors, in the
// ground's shadow or still easing towards the map's).
export interface UnitLook {
  color: number | null;
  alpha: number;
  light?: UnitLight;
  // Its animation held still (a kit's freeze): at this time into its loop
  // (ms), or where it is when null.
  freeze?: { atMs: number | null } | null;
}

// A unit's own light, and how far its light's direction leans from the
// indoor light's towards the sun's (0 to 1: 1 outdoors, between on a
// transition face).
export interface UnitLight extends LightColors {
  outdoor: number;
}

// The map's light as the client lights models: the ambient plus the direct
// light (each channel at most 1) times N.L, the sum at most 1, in the
// client's (gamma) colour space and then made linear (litColor in
// map-light.ts).
// The scene view sets these each frame; w is 1 while the client's light is
// in use (else the scene's own three.js lights light the models).
export const clientLight = {
  ambient: new Vector4(),
  direct: new Vector4(),
  // Towards the light, in view space: the sun outdoors, the fixed indoor
  // light indoors.
  sun: new Vector3(0, 1, 0),
  indoor: new Vector3(0, 1, 0),
};

// The client's light on a lit model material: the uniforms come from the
// material (shared ones, or a unit's own), and the props' point
// lights join the sum indoors and out. The scene's three.js ambient and sun
// are dark while it is on.
const CLIENT_LIGHT_DECLARATIONS = `
uniform vec4 wowLightAmbient;
uniform vec4 wowLightDirect;
uniform vec3 wowLightDirection;
uniform vec3 wowSunDirection;
uniform vec4 wowPointPosition[${pointLights.positions.length}];
uniform vec4 wowPointColor[${pointLights.colors.length}];
uniform float wowPointCount;
${pointLightFunction('wowPointLight', 'wowPointPosition', 'wowPointColor', 'wowPointCount')}${LIT_SUM_FUNCTION}`;
// The direct light's w is how far its direction leans towards the sun's
// (1 outdoors, where they are the same; a unit's own share indoors).
const CLIENT_LIGHT_FRAGMENT = `
if (wowLightAmbient.w > 0.5) {
  vec3 wowTowards = mix(wowLightDirection, wowSunDirection, wowLightDirect.w);
  wowTowards = dot(wowTowards, wowTowards) > 1e-6 ? normalize(wowTowards) : wowLightDirection;
  vec3 wowLight = wowLitSum(wowLightAmbient.rgb, wowLightDirect.rgb, dot(normal, wowTowards), wowPointLight(-vViewPosition, normal));
  reflectedLight.indirectDiffuse += diffuseColor.rgb * pow(wowLight, vec3(2.2));
}
`;
interface ClientLightUniforms {
  wowLightAmbient: { value: Vector4 };
  wowLightDirect: { value: Vector4 };
  wowLightDirection: { value: Vector3 };
  wowSunDirection: { value: Vector3 };
  wowPointPosition: { value: Vector4[] };
  wowPointColor: { value: Vector4[] };
  wowPointCount: { value: number };
}
const sharedLightUniforms = (): ClientLightUniforms => ({
  wowLightAmbient: { value: clientLight.ambient },
  wowLightDirect: { value: clientLight.direct },
  wowLightDirection: { value: clientLight.sun },
  wowSunDirection: { value: clientLight.sun },
  wowPointPosition: { value: pointLights.positions },
  wowPointColor: { value: pointLights.colors },
  wowPointCount: pointLights.count,
});
function injectClientLight(this: Material, shader: WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, this.userData.wowLight as ClientLightUniforms);
  shader.fragmentShader = CLIENT_LIGHT_DECLARATIONS + shader.fragmentShader
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${CLIENT_LIGHT_FRAGMENT}`);
}

// One unit to draw, in server coordinates.
export interface UnitModelPose {
  id: string;
  url: string;
  x: number;
  y: number;
  z: number;
  orientation: number;
  scale: number;
  // A player's pet: a model scaled up for a giant (a tamed boss worg's 6.5)
  // is drawn at the pet's own scale, as servers that normalise pets do.
  pet?: boolean;
  alive: boolean;
  inCombat: boolean;
  // How it fights when in combat, or null if it just stands.
  style: UnitCombatStyle | null;
  weapons: UnitWeapons;
  // 0 weapons sheathed, 1 melee weapons drawn, 2 ranged weapon drawn.
  sheathState: number;
  marker: UnitMarkerStyle;
  // A real attack that starts now, from the combat events.
  strike?: StrikeKind | null;
  // Recent attacks came from real events, so no made-up timed strikes.
  eventDriven?: boolean;
  // Animations the spell's kits name: a loop while casting or channelling,
  // and a one-off as a spell fires or lands or a cast begins (clip names,
  // the first the model has winning; skipped if it has none).
  kitLoop?: string[] | null;
  kitOnce?: string[] | null;
  // A mounted player's mount model: the mount moves and wears the ring, and
  // the rider sits on its saddle. On foot until the mount's model is ready.
  mountUrl?: string | null;
  // Seated: set by the layer for a rider on a mount, or for a passenger in a
  // vehicle's open seat.
  riding?: boolean;
  // In the air: a flying mount flies (or hovers when still).
  flying?: boolean;
  // Sitting on the ground or in a chair (eating, drinking, resting).
  sitting?: boolean;
  // The WMO group the unit stands in (-1 or absent for none), for its
  // indoor light.
  wmoGroupId?: number;
}

// A unit's own copy of a shared material, keeping the client's light on
// a lit one.
function copyMaterial(material: Material): Material {
  const copy = material.clone();
  if (!material.userData.wowLight) return copy;
  copy.userData.wowLight = sharedLightUniforms();
  copy.userData.wowOwnLight = { ambient: new Vector4(), direct: new Vector4() };
  copy.onBeforeCompile = injectClientLight;
  return copy;
}


// The id a rider's mount is drawn under.
const mountUnitId = (riderId: string): string => `${riderId}#mount`;

// Points on a unit WowMin's own drawing uses (its glows, plates, a rider's
// saddle), by the M2 attachments that can serve each, the first the model
// has winning: 22/21 the spell hands, 1/2 the hands, 15 the chest, 11 the
// helm (20 the head), 17 the mouth (breath), 18 the name point above the
// head, and 0 a mount's saddle (a character's shield otherwise; only mounts'
// is used). The client's own art asks for attachments by ID instead.
type UnitPointRole = 'handRight' | 'handLeft' | 'chest' | 'head' | 'breath' | 'overhead' | 'mount';
const ROLE_ATTACHMENTS: Record<UnitPointRole, number[]> = {
  handRight: [22, 1], handLeft: [21, 2], chest: [15], head: [11, 20], breath: [17, 11, 20], overhead: [18, 11], mount: [0],
};

// The ring on the floor under a model, with a pointer the way it faces.
export interface UnitMarkerStyle {
  color: string;
  inCombat: boolean;
  selected: boolean;
  // Drawn as an arc inside the ring; null for none (players, full health).
  healthPct: number | null;
  // Scenery gets no ring or pointer at all.
  hidden?: boolean;
}

interface ModelTemplate {
  state: 'loading' | 'ready' | 'failed';
  scene?: Object3D;
  clips?: Map<string, AnimationClip>;
  // The clips' names, for choosing stance clips.
  clipNames?: ReadonlySet<string>;
  speeds?: Record<string, number>;
  // When (seconds in) each cast clip lets a spell's missile go.
  releases?: Record<string, number>;
  // How the client sizes spell effects on the model.
  effectScales?: EffectScales;
  // Floor ring radius in model units, from the model's footprint.
  radius?: number;
  // Standing height in model units (times the display scale).
  height?: number;
  // The model's own display scale (its top node's).
  displayScale?: number;
}

interface UnitMarker {
  group: Group;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  pointer: Mesh<BufferGeometry, MeshBasicMaterial>;
  combat: Mesh<RingGeometry, MeshBasicMaterial>;
  selected: Mesh<RingGeometry, MeshBasicMaterial>;
  health: Mesh<RingGeometry, MeshBasicMaterial>;
  radius: number;
  healthShown: number | null;
  // The ring's colour as last set, so it is parsed only on a change.
  color: string | null;
}

// A rigid model (helm, weapon) the converter hangs on a bone. Bones live
// outside the scene graph (see UnitInstance.skeleton), so the item is drawn
// under the model and follows its bone by hand.
interface BoneAttachment {
  object: Object3D;
  // Its parent in the skeleton, and its matrix relative to that parent.
  parent: Object3D;
  local: Matrix4;
}

interface UnitInstance {
  url: string;
  root: Group;
  // The bones, kept out of the scene graph so three.js doesn't walk and
  // update them every frame: they move in the skinned mesh's own space
  // (the mesh binds them detached), and the unit's root places the model.
  // Posed only on frames the animation budget lets the unit animate.
  skeleton: Object3D;
  // The skeleton's space within the model's top node.
  skeletonToTop: Matrix4;
  top: Object3D;
  attachments: BoneAttachment[];
  // Animation time not yet applied to the mixer (seconds), and when the
  // unit next animates if it is not among the nearest.
  pending: number;
  nextPoseAt: number;
  // Posed this frame, so its bone matrices go to the GPU.
  posed: boolean;
  // A fixed random 0 to 1 that spreads reduced-rate units over frames.
  phase: number;
  mixer: AnimationMixer;
  template: ModelTemplate;
  loop: AnimationAction | null;
  loopName: string | null;
  strike: AnimationAction | null;
  stance: UnitStance | null;
  nextStrikeAt: number;
  jitter: number;
  // Smoothed ground speed from successive positions.
  lastX: number;
  lastY: number;
  lastAt: number;
  speed: number;
  seenAlive: boolean;
  sheathState: number | null;
  // Item models tagged drawn or sheathed by the converter.
  sheathItems: Object3D[];
  marker: UnitMarker;
  model: Object3D;
  // The converter's effect points on its skeleton: attachments by M2 ID,
  // and spell release events by name ('$CSL').
  effectAttachments: Map<number, Object3D>;
  effectEvents: Map<string, Object3D>;
  // Its drawn weapons' blades (bottom and top), for swing trails.
  blades: Array<{ item: Object3D; bottom: Object3D; top: Object3D }>;
  // Whether a kit holds its animation still.
  frozen: boolean;
  // How its spells change its model (UnitLook), as a key, and the shared
  // materials swapped out for changed copies, by mesh.
  look: string;
  changed: Map<Mesh, Material | Material[]>;
  // Whether it was last seen sitting, or null before its first pose.
  sitting: boolean | null;
}

const CROSSFADE_SECONDS = 0.2;
// A rider's seated pose (AnimationData 91).
const RIDING_CLIP = 'Mount';
// A flying mount in the air, moving faster than this, else hovering.
const FLY_CLIP = 'Fly';
const HOVER_CLIP = 'Hover';
const FLY_MOVING_SPEED = 1;
// Sitting on the ground, and sitting down and getting up (AnimationData 96-98).
const SIT_CLIP = 'SitGround';
const SIT_DOWN_CLIP = 'SitGroundDown';
const SIT_UP_CLIP = 'SitGroundUp';
const NO_WEAPONS: UnitWeapons = { mainHandType: 0, mainHandSubclass: 0, offHandType: 0, rangedSubclass: 0 };
const SPEED_SMOOTHING = 0.25;
// The longest step the mixers advance in one frame, so a stalled tab doesn't
// jump animations.
const MAX_STEP_SECONDS = 0.1;
// Animation budget: the units nearest the view's centre animate every frame,
// the rest about ten times a second (spread so they don't all land on one
// frame); units out of view are hidden and not animated. Positions move
// every frame either way.
const FULL_RATE_UNITS = 48;
const REDUCED_RATE_MS = 100;
// The most animation time a hidden unit catches up on when it comes back.
const MAX_PENDING_SECONDS = 1;
// Floor rings: drawn after the scene without depth testing, so the floor
// never hides them, and before the models, which stand on them.
const MARKER_RENDER_ORDER = 1;
const MODEL_RENDER_ORDER = 2;
const MARKER_LIFT = 0.05;
const MARKER_MIN_RADIUS = 0.6;
const MARKER_MAX_RADIUS = 8;
const COMBAT_COLOR = '#ef4444';
const SELECTED_COLOR = '#fbbf24';

// Floor ring radius for a model: a little under half its widest footprint.
function getMarkerRadius(sizeX: number, sizeY: number, displayScale: number): number {
  const radius = Math.max(sizeX, sizeY) * 0.45;
  return Math.min(MARKER_MAX_RADIUS, Math.max(MARKER_MIN_RADIUS, radius)) * (displayScale || 1);
}

// Merges a model's skinned parts that share a material into one mesh, so a
// character is drawn in about as many calls as it has materials rather than
// one per part. See-through parts keep their own draws (and so their
// blending order); parts whose attributes differ are left as they are.
function mergeSkinnedParts(scene: Object3D): void {
  const parents = new Set<Object3D>();
  scene.traverse((object) => {
    if (object instanceof SkinnedMesh && object.parent) parents.add(object.parent);
  });
  for (const parent of parents) {
    const groups = new Map<string, SkinnedMesh[]>();
    for (const child of parent.children) {
      if (!(child instanceof SkinnedMesh) || Array.isArray(child.material) || child.material.transparent) continue;
      const geometry = child.geometry;
      const signature = [
        child.material.uuid, child.skeleton.uuid, child.renderOrder, child.matrix.elements.join(','), Boolean(geometry.index),
        ...Object.entries(geometry.attributes as Record<string, { itemSize: number; normalized: boolean }>).map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}`).sort(),
      ].join('|');
      const group = groups.get(signature);
      if (group) group.push(child);
      else groups.set(signature, [child]);
    }
    for (const parts of groups.values()) {
      if (parts.length < 2) continue;
      const geometry = mergeGeometries(parts.map((part) => part.geometry));
      if (!geometry) continue;
      const [first] = parts;
      const merged = new SkinnedMesh(geometry, first.material);
      merged.name = first.name;
      merged.matrix.copy(first.matrix);
      merged.matrix.decompose(merged.position, merged.quaternion, merged.scale);
      merged.frustumCulled = first.frustumCulled;
      merged.renderOrder = first.renderOrder;
      merged.bind(first.skeleton, first.bindMatrix);
      for (const part of parts) {
        parent.remove(part);
        part.geometry.dispose();
      }
      parent.add(merged);
    }
  }
}

const scratchVector = new Vector3();
const scratchMatrix = new Matrix4();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const ZERO_OFFSET: Point3 = [0, 0, 0];
const tintColor = new Color();
const scratchSphere = new Sphere();

// The first of a role's attachments a unit's model has.
function rolePoint(unit: UnitInstance, role: UnitPointRole): Object3D | undefined {
  for (const id of ROLE_ATTACHMENTS[role]) {
    const point = unit.effectAttachments.get(id);
    if (point) return point;
  }
  return undefined;
}

// Takes a cloned model's bones out of the scene graph (see
// UnitInstance.skeleton): they go under a holder in the skinned mesh's own
// space, the mesh binds them detached, and the rigid items hung on bones
// move under the model's top node, to follow their bones by hand.
function detachSkeleton(model: Object3D): { top: Object3D; skeleton: Object3D; skeletonToTop: Matrix4; attachments: BoneAttachment[] } {
  const top = model.children[0] ?? model;
  const mesh = top.children.find((child): child is SkinnedMesh => child instanceof SkinnedMesh);
  // The converter leaves the mesh at the top node's origin; this keeps the
  // maths right if it ever does not.
  const skeletonToTop = mesh ? mesh.matrix.clone() : new Matrix4();
  const skeleton = new Object3D();
  skeleton.matrixAutoUpdate = false;
  skeleton.matrix.copy(skeletonToTop).invert();
  for (const child of [...top.children]) if (child instanceof Bone) skeleton.add(child);
  skeleton.updateMatrixWorld(true);
  const attachments: BoneAttachment[] = [];
  // The first node below a bone that is not a bone and holds a mesh (an
  // item with several primitives is a group of meshes, which carries the
  // item's tags), so it moves as a whole.
  const holdsMesh = (object: Object3D): boolean => object instanceof Mesh || object.children.some(holdsMesh);
  skeleton.traverse((object) => {
    if (object instanceof Bone || !(object.parent instanceof Bone) || !holdsMesh(object)) return;
    attachments.push({ object, parent: object.parent, local: object.matrix.clone() });
  });
  for (const { object } of attachments) {
    top.add(object);
    object.matrixAutoUpdate = false;
  }
  top.traverse((object) => {
    if (object instanceof SkinnedMesh) object.bindMode = DetachedBindMode;
  });
  return { top, skeleton, skeletonToTop, attachments };
}

function healthColor(fraction: number): string {
  return fraction > 0.5 ? '#22c55e' : fraction > 0.2 ? '#eab308' : '#dc2626';
}

function markerMesh<T extends BufferGeometry>(geometry: T, color: string): Mesh<T, MeshBasicMaterial> {
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, side: DoubleSide, forceSinglePass: true, depthTest: false, depthWrite: false }));
  mesh.renderOrder = MARKER_RENDER_ORDER;
  mesh.frustumCulled = false;
  return mesh;
}

// The pointer: a triangle just outside the ring, ahead of the unit (+X).
function pointerGeometry(radius: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    radius * 1.1, radius * 0.32, 0,
    radius * 1.1, -radius * 0.32, 0,
    radius * 1.55, 0, 0,
  ], 3));
  return geometry;
}

function createMarker(radius: number): UnitMarker {
  const group = new Group();
  group.position.z = MARKER_LIFT;
  const marker: UnitMarker = {
    group,
    ring: markerMesh(new RingGeometry(radius * 0.86, radius, 48), '#94a3b8'),
    pointer: markerMesh(pointerGeometry(radius), '#94a3b8'),
    combat: markerMesh(new RingGeometry(radius * 1.0, radius * 1.08, 48), COMBAT_COLOR),
    selected: markerMesh(new RingGeometry(radius * 1.14, radius * 1.22, 48), SELECTED_COLOR),
    health: markerMesh(new RingGeometry(radius * 0.7, radius * 0.8, 48), healthColor(1)),
    radius,
    healthShown: null,
    color: null,
  };
  marker.health.visible = false;
  group.add(marker.ring, marker.pointer, marker.combat, marker.selected, marker.health);
  return marker;
}

function updateMarker(marker: UnitMarker, style: UnitMarkerStyle, alive: boolean): void {
  marker.group.visible = !style.hidden;
  if (style.color !== marker.color) {
    marker.color = style.color;
    marker.ring.material.color.set(style.color);
    marker.pointer.material.color.set(style.color);
  }
  // A corpse faces nowhere in particular.
  marker.pointer.visible = alive;
  marker.combat.visible = alive && style.inCombat;
  marker.selected.visible = style.selected;
  const health = alive && style.healthPct !== null && style.healthPct < 100 ? Math.max(0, Math.round(style.healthPct)) : null;
  if (health === marker.healthShown) return;
  marker.healthShown = health;
  marker.health.visible = health !== null;
  if (health === null) return;
  marker.health.geometry.dispose();
  // Fills anticlockwise from the pointer, like a clock hand.
  marker.health.geometry = new RingGeometry(marker.radius * 0.7, marker.radius * 0.8, 48, 1, 0, Math.PI * 2 * (health / 100));
  marker.health.material.color.set(healthColor(health / 100));
}

function disposeMarker(marker: UnitMarker): void {
  for (const mesh of [marker.ring, marker.pointer, marker.combat, marker.selected, marker.health]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

// Players and creatures as animated client models, placed in server
// coordinates under a Z-up group like the scene's.
export class UnitModelLayer {
  readonly group = new Group();
  private readonly loader = new GLTFLoader();
  private readonly templates = new Map<string, ModelTemplate>();
  private readonly units = new Map<string, UnitInstance>();
  private readonly materials = new Map<string, Material>();
  private lastUpdateAt = 0;

  constructor(private readonly onLoaded: () => void) {
    useServerAxes(this.group);
  }

  get count(): number {
    return this.group.children.length;
  }

  // An effect point on a drawn unit, in server coordinates, or null if the
  // unit isn't drawn as a model or its model has no such point.
  pointOf(id: string, role: UnitPointRole): Point3 | null {
    const unit = this.units.get(id);
    const point = unit && rolePoint(unit, role);
    return unit && point ? threeToServer(this.pointWorld(unit, point, scratchVector.set(0, 0, 0))) : null;
  }

  // When (ms into the clip) a drawn unit's cast clip lets a spell's missile
  // go, or null if the unit isn't drawn, lacks the clip, or it never does.
  releaseMsOf(id: string, clip: string): number | null {
    const seconds = this.units.get(id)?.template.releases?.[clip];
    return seconds === undefined ? null : seconds * 1000;
  }

  // How the client sizes spell effects on a drawn unit's model, or null.
  effectScalesOf(id: string): EffectScales | null {
    return this.units.get(id)?.template.effectScales ?? null;
  }

  // Whether a unit is drawn as its model, so its attachments are known.
  isDrawn(id: string): boolean {
    return this.units.has(id);
  }

  // A drawn unit's attachment (M2 ID), or its release event ('$CSL'), in
  // server coordinates, `offset` (model space) from it the way the point
  // turns; null if the unit isn't drawn or its model has no such point.
  attachmentOf(id: string, attachment: number | string, offset: Point3 = ZERO_OFFSET): Point3 | null {
    const unit = this.units.get(id);
    const point = typeof attachment === 'number' ? unit?.effectAttachments.get(attachment) : unit?.effectEvents.get(attachment);
    if (!unit || !point) return null;
    return threeToServer(this.pointWorld(unit, point, scratchVector.set(offset[0], offset[1], offset[2])));
  }

  // Which way a drawn unit's attachment (M2 ID) is turned, in world space
  // (three.js axes), as an effect riding on it turns; null if the unit
  // isn't drawn or its model lacks it. Written into `out`.
  attachmentTurnOf(id: string, attachment: number, out: Quaternion): Quaternion | null {
    const unit = this.units.get(id);
    const point = unit?.effectAttachments.get(attachment);
    if (!unit || !point) return null;
    scratchMatrix.multiplyMatrices(unit.top.matrixWorld, unit.skeletonToTop).multiply(point.matrixWorld);
    scratchMatrix.decompose(scratchPosition, out, scratchScale);
    return out;
  }

  // A point in a unit's skeleton, in world space: `local` is in the point's
  // own space and is overwritten with the result.
  private pointWorld(unit: UnitInstance, point: Object3D, local: Vector3): Vector3 {
    return local.applyMatrix4(point.matrixWorld).applyMatrix4(unit.skeletonToTop).applyMatrix4(unit.top.matrixWorld);
  }

  // Which way a drawn unit faces (radians about Z), or null.
  orientationOf(id: string): number | null {
    return this.units.get(id)?.root.rotation.z ?? null;
  }

  // A drawn unit's overall scale (its display's times its own), or null.
  scaleOf(id: string): number | null {
    const unit = this.units.get(id);
    if (!unit) return null;
    return unit.root.scale.x * (unit.template.displayScale ?? 1);
  }

  // A drawn unit's standing height in yards, or null.
  heightOf(id: string): number | null {
    const unit = this.units.get(id);
    return unit?.template.height ? unit.template.height * unit.root.scale.x : null;
  }

  // Places and animates the given units; returns the IDs drawn as models.
  // Units whose model is still loading, or has none, are left to markers.
  // `view` (the last frame's camera, and the server point at the view's
  // centre) sets the animation budget; without it every unit animates.
  update(poses: UnitModelPose[], nowMs: number, view: { frustum: Frustum; centre: Point3 } | null = null): Set<string> {
    const step = this.lastUpdateAt ? Math.min(MAX_STEP_SECONDS, Math.max(0, (nowMs - this.lastUpdateAt) / 1000)) : 0;
    this.lastUpdateAt = nowMs;
    const shown = new Set<string>();
    this.group.updateWorldMatrix(true, false);
    for (const pose of poses) {
      const template = this.template(pose.url);
      if (template.state !== 'ready') continue;
      const seated = this.placeMount(pose, nowMs, shown);
      const unit = this.unitFor(seated ?? pose, template, nowMs);
      this.place(unit, seated ?? pose, nowMs);
      shown.add(pose.id);
    }
    for (const id of [...this.units.keys()]) if (!shown.has(id)) this.remove(id);
    this.animate(step, nowMs, view);
    this.group.updateMatrixWorld(true);
    return shown;
  }

  // Steps the animations the budget allows this frame (see FULL_RATE_UNITS).
  private animate(step: number, nowMs: number, view: { frustum: Frustum; centre: Point3 } | null): void {
    const candidates: Array<{ unit: UnitInstance; distance: number }> = [];
    for (const unit of this.units.values()) {
      unit.posed = false;
      unit.pending = Math.min(MAX_PENDING_SECONDS, unit.pending + step);
      const { x, y, z } = unit.root.position;
      const height = (unit.template.height ?? 2) * unit.root.scale.x;
      const reach = Math.max(height, (unit.template.radius ?? 1) * 1.6 * unit.root.scale.x);
      // Server (x, y, z) is (x, z, -y) in three.js's world.
      const inView = !view || view.frustum.intersectsSphere(scratchSphere.set(scratchVector.set(x, z + height / 2, -y), reach));
      unit.root.visible = inView;
      if (!inView || this.settled(unit)) continue;
      candidates.push({ unit, distance: view ? (x - view.centre[0]) ** 2 + (y - view.centre[1]) ** 2 + (z - view.centre[2]) ** 2 : 0 });
    }
    if (candidates.length > FULL_RATE_UNITS) candidates.sort((a, b) => a.distance - b.distance);
    candidates.forEach(({ unit }, index) => {
      if (index >= FULL_RATE_UNITS && nowMs < unit.nextPoseAt) return;
      // Spread the reduced-rate units' frames by their phase.
      unit.nextPoseAt = nowMs + REDUCED_RATE_MS * (0.75 + unit.phase * 0.5);
      unit.mixer.update(unit.pending);
      unit.pending = 0;
      this.finishStrike(unit);
      this.pose(unit);
    });
  }

  // A corpse whose death clip has played to its end holds still.
  private settled(unit: UnitInstance): boolean {
    return unit.stance === 'dead' && unit.nextPoseAt > 0 && unit.loop !== null && !unit.loop.isRunning() && !unit.strike
      && unit.loop.time >= unit.loop.getClip().duration;
  }

  // Brings the skeleton and the items on it up to the mixer's pose.
  private pose(unit: UnitInstance): void {
    unit.skeleton.updateMatrixWorld(true);
    for (const { object, parent, local } of unit.attachments) {
      object.matrix.multiplyMatrices(unit.skeletonToTop, parent.matrixWorld).multiply(local);
    }
    unit.posed = true;
  }

  private unitFor(pose: UnitModelPose, template: ModelTemplate, nowMs: number): UnitInstance {
    let unit = this.units.get(pose.id);
    if (unit && unit.url !== pose.url) {
      this.remove(pose.id);
      unit = undefined;
    }
    return unit ?? this.create(pose, template, nowMs);
  }

  // Draws a mounted pose's mount where the unit is, and returns the rider's
  // pose on its saddle; null to draw the unit on foot (not mounted, or the
  // mount's model isn't ready or has no saddle).
  private placeMount(pose: UnitModelPose, nowMs: number, shown: Set<string>): UnitModelPose | null {
    if (!pose.mountUrl) return null;
    const template = this.template(pose.mountUrl);
    if (template.state !== 'ready') return null;
    const mountPose: UnitModelPose = {
      ...pose, id: mountUnitId(pose.id), url: pose.mountUrl, scale: 1, pet: false, mountUrl: null,
      style: null, weapons: NO_WEAPONS, sheathState: 0, strike: null, eventDriven: true, kitLoop: null, kitOnce: null,
    };
    const mount = this.unitFor(mountPose, template, nowMs);
    this.place(mount, mountPose, nowMs);
    shown.add(mountPose.id);
    const saddle = rolePoint(mount, 'mount');
    if (!saddle) return null;
    // The saddle as of the mount's last pose, where the mount is now.
    mount.top.updateWorldMatrix(true, false);
    const [x, y, z] = threeToServer(this.pointWorld(mount, saddle, scratchVector.set(0, 0, 0)));
    return {
      ...pose, x, y, z, orientation: mount.root.rotation.z, riding: true,
      marker: { ...pose.marker, hidden: true },
    };
  }

  private template(url: string): ModelTemplate {
    let template = this.templates.get(url);
    if (template) return template;
    template = { state: 'loading' };
    this.templates.set(url, template);
    const loading = template;
    this.loader.load(url, (gltf) => {
      const footprint = new Box3();
      // How opaque the display draws the model (a Shadowfiend is half see-through).
      const modelAlpha = Number(gltf.scene.children[0]?.userData.wowModelAlpha ?? 1);
      gltf.scene.traverse((object) => {
        if (object instanceof Mesh) {
          object.material = this.convertMaterial(object.material as MeshStandardMaterial, modelAlpha);
          object.frustumCulled = false;
          object.renderOrder = MODEL_RENDER_ORDER;
        }
        // The body only: weapons and shoulders would widen the ring.
        if (object instanceof SkinnedMesh) {
          object.geometry.computeBoundingBox();
          footprint.union(object.geometry.boundingBox!);
        }
      });
      mergeSkinnedParts(gltf.scene);
      const root = gltf.scene.children[0];
      const displayScale = root?.scale.x ?? 1;
      loading.displayScale = displayScale;
      loading.radius = footprint.isEmpty()
        ? MARKER_MIN_RADIUS
        : getMarkerRadius(footprint.max.x - footprint.min.x, footprint.max.y - footprint.min.y, displayScale);
      loading.height = footprint.isEmpty() ? undefined : footprint.max.z * displayScale;
      const durations = (root?.userData.wowClipDurations ?? {}) as Record<string, number>;
      loading.clips = new Map(gltf.animations.map((clip) => {
        if (durations[clip.name]) clip.duration = durations[clip.name];
        return [clip.name, clip];
      }));
      loading.clipNames = new Set(loading.clips.keys());
      loading.speeds = (root?.userData.wowClipSpeeds ?? {}) as Record<string, number>;
      loading.releases = (root?.userData.wowClipReleases ?? {}) as Record<string, number>;
      loading.effectScales = root?.userData.wowEffectScales as EffectScales | undefined;
      loading.scene = gltf.scene;
      loading.state = 'ready';
      this.onLoaded();
    }, undefined, () => {
      loading.state = 'failed';
    });
    return template;
  }

  private create(pose: UnitModelPose, template: ModelTemplate, nowMs: number): UnitInstance {
    const model = cloneSkinned(template.scene!);
    const root = new Group();
    const marker = createMarker(template.radius ?? MARKER_MIN_RADIUS);
    root.add(marker.group, model);
    this.group.add(root);
    const { top, skeleton, skeletonToTop, attachments } = detachSkeleton(model);
    // The model's nodes keep their place under the root (items on bones are
    // posed by hand), so their local matrices are made once.
    model.traverse((object) => {
      if (!object.matrixAutoUpdate) return;
      object.updateMatrix();
      object.matrixAutoUpdate = false;
    });
    const jitter = Math.random();
    const unit: UnitInstance = {
      url: pose.url,
      root,
      skeleton,
      skeletonToTop,
      top,
      attachments,
      pending: 0,
      nextPoseAt: 0,
      phase: Math.random(),
      posed: false,
      mixer: new AnimationMixer(skeleton),
      template,
      loop: null,
      loopName: null,
      strike: null,
      stance: null,
      nextStrikeAt: nowMs + jitter * 1500,
      jitter,
      lastX: pose.x,
      lastY: pose.y,
      lastAt: nowMs,
      speed: 0,
      seenAlive: pose.alive,
      sheathState: null,
      sheathItems: [],
      marker,
      model,
      effectAttachments: new Map(),
      effectEvents: new Map(),
      blades: [],
      frozen: false,
      look: '',
      changed: new Map(),
      sitting: null,
    };
    model.traverse((object) => {
      if (object.userData.wowSheath) unit.sheathItems.push(object);
      // Weapons ride on the model's top node, so their blades are found here.
      if (object.userData.wowTrail === 'bottom') {
        const top = object.parent?.children.find((sibling) => sibling.userData.wowTrail === 'top');
        if (object.parent && top) unit.blades.push({ item: object.parent, bottom: object, top });
      }
    });
    skeleton.traverse((object) => {
      if (typeof object.userData.wowAttachment === 'number') unit.effectAttachments.set(object.userData.wowAttachment, object);
      if (typeof object.userData.wowEvent === 'string') unit.effectEvents.set(object.userData.wowEvent, object);
    });
    this.pose(unit);
    // The clone gives each skinned part its own copy of the skeleton; parts
    // of one skin share one again, so its bones go to the GPU once a frame.
    // That happens only on frames the unit was posed.
    const skeletons: Skeleton[] = [];
    model.traverse((object) => {
      if (!(object instanceof SkinnedMesh)) return;
      const shared = skeletons.find((skeleton) => skeleton.bones.length === object.skeleton.bones.length
        && skeleton.bones.every((bone, index) => bone === object.skeleton.bones[index]));
      if (shared) {
        object.bind(shared, object.bindMatrix);
        return;
      }
      const bones = object.skeleton;
      bones.update = () => {
        if (unit.posed) Skeleton.prototype.update.call(bones);
      };
      skeletons.push(bones);
    });
    this.units.set(pose.id, unit);
    return unit;
  }

  private remove(id: string): void {
    const unit = this.units.get(id);
    if (!unit) return;
    unit.mixer.stopAllAction();
    this.setLook(unit, null);
    disposeMarker(unit.marker);
    // Each skin's bone texture, made when it was first drawn, goes with it.
    const skeletons = new Set<Skeleton>();
    unit.model.traverse((object) => {
      if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    });
    for (const skeleton of skeletons) skeleton.dispose();
    this.group.remove(unit.root);
    this.units.delete(id);
  }

  // Places the unit and chooses its animations; animate() steps them.
  private place(unit: UnitInstance, pose: UnitModelPose, nowMs: number): void {
    unit.root.position.set(pose.x, pose.y, pose.z);
    unit.root.rotation.z = pose.orientation;
    const displayScale = unit.template.displayScale ?? 1;
    const oversized = pose.pet && displayScale > PET_OVERSIZED_DISPLAY_SCALE;
    unit.root.scale.setScalar((pose.scale || 1) / (oversized ? displayScale : 1));

    const elapsed = (nowMs - unit.lastAt) / 1000;
    if (elapsed > 0.05) {
      const instant = Math.hypot(pose.x - unit.lastX, pose.y - unit.lastY) / elapsed;
      // A jump (teleport, first sample after a gap) is not movement.
      unit.speed = instant > 60 ? 0 : unit.speed + (instant - unit.speed) * Math.min(1, SPEED_SMOOTHING * elapsed * 30);
      unit.lastX = pose.x;
      unit.lastY = pose.y;
      unit.lastAt = nowMs;
    }
    if (pose.alive) unit.seenAlive = true;
    updateMarker(unit.marker, pose.marker, pose.alive);
    if (unit.sheathState !== pose.sheathState) {
      unit.sheathState = pose.sheathState;
      for (const item of unit.sheathItems) item.visible = isItemShown(item.userData.wowItem, item.userData.wowSheath, pose.sheathState);
    }

    const clips = unit.template.clips!;
    // A rider sits still in the saddle; the mount does the moving.
    const riding = Boolean(pose.riding) && clips.has(RIDING_CLIP);
    // Sitting on the ground holds still too, getting down and up as it changes.
    const sitting = !riding && Boolean(pose.sitting) && pose.alive && clips.has(SIT_CLIP);
    const seated = riding || sitting;
    const stance = seated ? 'stand' : chooseUnitStance({ alive: pose.alive, speed: unit.speed, inCombat: pose.inCombat, style: pose.style });
    const flight = !seated && pose.flying && pose.alive && clips.has(FLY_CLIP)
      ? (unit.speed > FLY_MOVING_SPEED || !clips.has(HOVER_CLIP) ? FLY_CLIP : HOVER_CLIP) : null;
    const chosen = riding
      ? { loop: RIDING_CLIP, strike: null }
      : sitting ? { loop: SIT_CLIP, strike: null }
        : flight ? { loop: flight, strike: null } : getStanceClips(stance, pose.weapons, unit.template.clipNames!);
    // Standing or fighting, a cast or channel holds the pose its kit names.
    const still = stance !== 'walk' && stance !== 'run' && stance !== 'dead';
    const kitLoop = still && !seated ? pose.kitLoop?.find((name) => clips.has(name)) ?? null : null;
    if (kitLoop) chosen.loop = kitLoop;
    if (stance !== unit.stance || chosen.loop !== unit.loopName) {
      unit.stance = stance;
      this.playLoop(unit, chosen.loop, Boolean(chosen.holdLastFrame), pose.alive || unit.seenAlive);
    }
    // Sitting down or getting up plays once over the new loop. A unit first
    // seen seated is already down.
    if (sitting !== unit.sitting) {
      const transition = sitting ? SIT_DOWN_CLIP : SIT_UP_CLIP;
      if (unit.sitting !== null && pose.alive && clips.has(transition)) this.playStrike(unit, transition);
      unit.sitting = sitting;
    }
    if (unit.loop && (stance === 'walk' || stance === 'run') && unit.loopName) {
      unit.loop.timeScale = getMoveTimeScale(unit.speed, unit.template.speeds?.[unit.loopName]);
    }
    const fighting = stance === 'melee' || stance === 'ranged' || stance === 'cast';
    const kitOnce = still && !seated ? pose.kitOnce?.find((name) => clips.has(name)) ?? null : null;
    if (seated) {
      // No swings or casting poses in the saddle or on the ground.
    } else if (kitOnce) {
      this.playStrike(unit, kitOnce);
    } else if (pose.strike && (fighting || stance === 'stand')) {
      // A real attack: the clip for what was done, whatever the stance.
      const strike = getStanceClips(pose.strike, pose.weapons, unit.template.clipNames!).strike;
      if (strike) this.playStrike(unit, strike);
    } else if (!pose.eventDriven && !kitLoop && chosen.strike && fighting && nowMs >= unit.nextStrikeAt) {
      unit.nextStrikeAt = nowMs + getStrikeInterval(stance, unit.jitter) * 1000;
      unit.jitter = Math.random();
      this.playStrike(unit, chosen.strike);
    }
  }

  private playLoop(unit: UnitInstance, name: string | null, holdLastFrame: boolean, animateDeath: boolean): void {
    const previous = unit.loop;
    unit.loopName = name;
    unit.strike?.fadeOut(CROSSFADE_SECONDS);
    unit.strike = null;
    const clip = name ? unit.template.clips!.get(name) : undefined;
    if (!clip) {
      previous?.fadeOut(CROSSFADE_SECONDS);
      unit.loop = null;
      return;
    }
    const action = unit.mixer.clipAction(clip);
    action.reset();
    action.timeScale = 1;
    if (holdLastFrame) {
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      // Already dead when first seen: lie still rather than replay the fall.
      if (!animateDeath) action.time = clip.duration;
    } else {
      action.setLoop(LoopRepeat, Infinity);
    }
    action.play();
    if (previous && previous !== action) action.crossFadeFrom(previous, CROSSFADE_SECONDS, false);
    unit.loop = action;
  }

  private playStrike(unit: UnitInstance, name: string): void {
    const clip = unit.template.clips!.get(name);
    if (!clip || !unit.loop) return;
    const strike = unit.mixer.clipAction(clip);
    if (unit.strike && unit.strike !== strike) unit.strike.fadeOut(CROSSFADE_SECONDS);
    strike.reset();
    strike.setLoop(LoopOnce, 1);
    strike.clampWhenFinished = false;
    strike.play();
    strike.crossFadeFrom(unit.loop, CROSSFADE_SECONDS, false);
    unit.strike = strike;
  }

  // Blends a finished strike back into the ready pose.
  private finishStrike(unit: UnitInstance): void {
    const strike = unit.strike;
    if (!strike || !unit.loop || strike.time < strike.getClip().duration - CROSSFADE_SECONDS) return;
    unit.loop.reset().play();
    unit.loop.crossFadeFrom(strike, CROSSFADE_SECONDS, false);
    unit.strike = null;
  }

  // Changes units' models as their spells' kits ask (by unit ID); units
  // left out go back to their models' own look.
  setLooks(looks: ReadonlyMap<string, UnitLook>): void {
    for (const [id, unit] of this.units) {
      const look = looks.get(id) ?? null;
      this.setFreeze(unit, look?.freeze ?? null);
      this.setLook(unit, look);
    }
  }

  // Holds a unit's animation still while a kit freezes it, at the kit's
  // time into its loop where it names one.
  private setFreeze(unit: UnitInstance, freeze: { atMs: number | null } | null): void {
    if (Boolean(freeze) === unit.frozen) return;
    unit.frozen = Boolean(freeze);
    if (freeze?.atMs !== null && freeze?.atMs !== undefined && unit.loop) {
      unit.loop.time = Math.min(freeze.atMs / 1000, unit.loop.getClip().duration);
    }
    unit.mixer.timeScale = unit.frozen ? 0 : 1;
  }

  // A drawn unit's blades (bottom and top, server coordinates) of the
  // weapons it holds drawn.
  bladesOf(id: string): Array<[Point3, Point3]> {
    const unit = this.units.get(id);
    if (!unit) return [];
    return unit.blades.filter(({ item }) => item.visible).map(({ item, bottom, top }) => {
      item.updateWorldMatrix(true, true);
      return [threeToServer(scratchVector.setFromMatrixPosition(bottom.matrixWorld)), threeToServer(scratchVector.setFromMatrixPosition(top.matrixWorld))];
    });
  }

  // Multiplies the unit's materials by a colour and an opacity, on copies
  // of the shared ones, or puts the shared ones back.
  private setLook(unit: UnitInstance, look: UnitLook | null): void {
    const plain = !look || (look.color === null && look.alpha >= 1 && !look.light);
    const own = look?.light ?? null;
    const key = plain ? '' : `${look.color}|${look.alpha.toFixed(3)}|${own ? [...own.ambient, ...own.direct, own.outdoor].map((value) => value.toFixed(3)).join(',') : ''}`;
    if (unit.look === key) return;
    unit.look = key;
    if (plain) {
      for (const [mesh, original] of unit.changed) {
        for (const copy of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) copy.dispose();
        mesh.material = original;
      }
      unit.changed.clear();
      return;
    }
    tintColor.setHex(look.color ?? 0xffffff);
    unit.model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      let original = unit.changed.get(object);
      if (!original) {
        original = object.material as Material | Material[];
        unit.changed.set(object, original);
        object.material = Array.isArray(original) ? original.map(copyMaterial) : copyMaterial(original);
      }
      const originals = Array.isArray(original) ? original : [original];
      const copies = Array.isArray(object.material) ? object.material : [object.material];
      copies.forEach((copy, index) => {
        const source = originals[index];
        if (!(copy instanceof MeshLambertMaterial || copy instanceof MeshBasicMaterial)
          || !(source instanceof MeshLambertMaterial || source instanceof MeshBasicMaterial)) return;
        // A lit material takes the unit's own light, from the fixed indoor
        // direction leaning towards the sun's by its share; else the map's,
        // shared.
        const uniforms = copy.userData.wowLight as ClientLightUniforms | undefined;
        if (uniforms) {
          const values = copy.userData.wowOwnLight as { ambient: Vector4; direct: Vector4 };
          if (own) {
            values.ambient.set(...own.ambient, 1);
            values.direct.set(...own.direct, own.outdoor);
          }
          uniforms.wowLightAmbient.value = own ? values.ambient : clientLight.ambient;
          uniforms.wowLightDirect.value = own ? values.direct : clientLight.direct;
          uniforms.wowLightDirection.value = own ? clientLight.indoor : clientLight.sun;
        }
        copy.color.copy(source.color).multiply(tintColor);
        copy.opacity = source.opacity * look.alpha;
        const seeThrough = copy.opacity < 1;
        if (copy.transparent !== (source.transparent || seeThrough)) {
          copy.transparent = source.transparent || seeThrough;
          copy.needsUpdate = true;
        }
        copy.depthWrite = source.depthWrite && !seeThrough;
      });
    });
  }

  // As the client draws a model's batch (m2MaterialLight): lit by the
  // client's light, or full bright where its material is unlit or it
  // modulates the colour behind it (mod, mod2x, in white whatever their
  // colour). Models built before their materials carried flags are all lit
  // but the modulating ones.
  private convertMaterial(source: MeshStandardMaterial, modelAlpha = 1): Material {
    const cached = this.materials.get(source.uuid);
    if (cached) return cached;
    const blend = (source.userData.wowBlend ?? 'opaque') as EffectBlend;
    const rule = m2MaterialLight(blend, (source.userData.wowMaterialFlags as number | undefined) ?? 0);
    const opacity = source.opacity * modelAlpha;
    const parameters = {
      name: source.name,
      map: source.map ?? null,
      color: rule.color === null ? source.color.clone() : new Color(rule.color, rule.color, rule.color),
      opacity,
      side: source.side === DoubleSide ? DoubleSide : FrontSide,
      // One pass for both faces, as the client draws them (see scene-view.ts).
      forceSinglePass: true,
      // The model's alpha key, as it was exported (the client's 224/255).
      alphaTest: blend === 'alphaKey' ? source.alphaTest : 0,
      transparent: (blend !== 'opaque' && blend !== 'alphaKey') || opacity < 1,
      depthWrite: rule.depthWrite && opacity >= 1,
      depthTest: rule.depthTest,
      ...blendFactors(blend),
    };
    const material = rule.lit ? new MeshLambertMaterial(parameters) : new MeshBasicMaterial(parameters);
    if (rule.lit) {
      material.userData.wowLight = sharedLightUniforms();
      material.onBeforeCompile = injectClientLight;
    }
    this.materials.set(source.uuid, material);
    return material;
  }
}
