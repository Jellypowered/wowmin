import {
  AdditiveBlending,
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  type DataArrayTexture,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Frustum,
  InstancedBufferAttribute,
  InstancedMesh,
  type Intersection,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  MultiplyBlending,
  NormalBlending,
  Object3D,
  OrthographicCamera,
  PointLight,
  Raycaster,
  Scene,
  Sphere,
  SRGBColorSpace,
  type Texture,
  Uniform,
  UniformsGroup,
  Vector2,
  Vector3,
  WebGLRenderer,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

import { type FadeSettings, type FadeVolume, getSceneFade, type IsoView, MAX_FADE_VOLUMES } from '../utils/map-projection';
import {
  blendLight, type BuildingBatchLight, buildingBatchLight, CLIENT_AMBIENT_GAIN, CLIENT_DIRECT_GAIN, characterAmbientScale, floorLight, INDOOR_LIGHT_DIRECTION, indoorLight, type LightColors,
  lightAt, type MapLights, nearestObjectLights, scaleAmbient, type Rgb, sunDirection, timeOfDay,
} from '../utils/map-light';
import { PARTICLE_GROUND_DEPTH } from '../utils/m2-tracks';
import type { CombatEffectStore, Point3, UnitKey } from '../utils/spell-events';
import { applyIsoCamera, serverToThree, threeToServer } from './iso-camera';
import { ALL_SPELL_AIDS, type SpellAids, SpellEffectLayer, type UnitAnchorRole } from './spell-effects';
import { buildLayerArray, BYTE_SHADING_SCALE, createTerrainMaterial, prepareAlphaAtlas } from './terrain-material';
import { GameObjectLayer, type GameObjectPose } from './game-objects';
import { type BearerAreaCircle, SpellVisualLayer, type UnitInfo } from './spell-visual-layer';
import { clientLight, type UnitLook, type UnitModelPose, UnitModelLayer } from './unit-models';

type WowBlend = 'opaque' | 'alphaKey' | 'alpha' | 'add' | 'mod' | 'mod2x';

interface TerrainTextures {
  layers: DataArrayTexture;
  alphas: Map<string, Texture>;
}

interface LiquidExtras {
  id: number;
  kind: 'water' | 'ocean' | 'magma' | 'slime';
  frames: string[];
  // Water and ocean: the map's colour for them (sRGB, 0-1).
  color?: [number, number, number];
}

// Liquid textures animate at this many frames a second; water is see-through.
const LIQUID_FPS = 15;
const WATER_OPACITY = 0.7;
// Water without a colour from its map: a dull blue-green.
const WATER_COLOR: [number, number, number] = [0.2, 0.3, 0.3];
// Water textures are dark ripples, mostly alpha: laid over the water's colour.
const WATER_FRAGMENT = `
#ifdef USE_MAP
  vec4 ripples = texture2D(map, vMapUv);
  diffuseColor.rgb = mix(diffuseColor.rgb, ripples.rgb, ripples.a);
#endif
`;

// WMO interiors carry baked lighting in their vertex colours, which the client
// brightens; props have no baked light and are drawn slightly dimmed to sit in
// the same range. Tuned by eye against Azjol-Nerub.
const VERTEX_LIT_BRIGHTNESS = 2;
const UNLIT_BRIGHTNESS = 0.75;
// With the map's light, a building's batches as the client draws them (see
// buildingBatchLight): texture x 2 x a colour, all in the client's (gamma)
// colour space, so made linear here. The colour is the vertex colour (MOCV)
// lit by the map's ambient and sun on the older render path, or with half
// of either light added on the newer one (the building's own ambient
// indoors); transition batches mix the two by the vertex alpha. WOW_BUILDING
// is 0 unlit, 1 own, 2 lit, 3 transition. Without the map's light, the old
// look: vertex colours doubled, outdoor groups' brightened instead (and the
// vertex alpha never changes the surface's).
const BUILDING_LIGHT = { unlit: 0, own: 1, lit: 2, transition: 3 } as const satisfies Record<BuildingBatchLight, number>;
const BUILDING_LIGHT_FRAGMENT = `
vec3 wowMocv = vColor.rgb;
if (wowClientAmbientPacked.w > 0.5) {
  vec3 wowSky = clamp(wowClientAmbientPacked.rgb
    + wowClientDirectPacked.rgb * clamp(dot(normalize(vWowNormal), wowClientSunPacked.xyz), 0.0, 1.0), 0.0, 1.0);
#ifdef WOW_BUILDING_UNIFIED
  vec3 wowLit = clamp(wowSky * 0.5 + wowMocv, 0.0, 1.0);
  vec3 wowOwn = clamp(wowBuildingAmbient * 0.5 + wowMocv, 0.0, 1.0);
#else
  vec3 wowLit = clamp(wowMocv * wowSky, 0.0, 1.0);
  vec3 wowOwn = wowMocv;
#endif
#if WOW_BUILDING == 1
  vec3 wowColor = wowOwn;
#elif WOW_BUILDING == 2
  vec3 wowColor = wowLit;
#elif WOW_BUILDING == 3
#ifdef USE_COLOR_ALPHA
  vec3 wowColor = mix(wowOwn, wowLit, vColor.a);
#else
  vec3 wowColor = wowLit;
#endif
#else
  vec3 wowColor = wowMocv;
#endif
  diffuseColor.rgb *= pow(2.0 * wowColor, vec3(2.2));
} else {
#ifdef WOW_EXTERIOR_GROUP
  diffuseColor.rgb *= wowMocv + ${UNLIT_BRIGHTNESS.toFixed(2)};
#else
  diffuseColor.rgb *= wowMocv * ${VERTEX_LIT_BRIGHTNESS.toFixed(1)};
#endif
}
`;
// The map's props (not a building's) are shaded by the scene's lights, a
// little dimmed to sit with the buildings' baked light.
const PROP_BRIGHTNESS = 0.75;

// How the scene is lit: by the map's own light (Light.dbc, at the view's
// centre and the time of day), or by a fixed neutral white.
export type SceneLighting = 'client' | 'neutral';
const NEUTRAL_AMBIENT = 2.2;
const NEUTRAL_SUN = 1.6;
// With the map's light, models and terrain are lit as the client lights
// them (see clientLight in unit-models.ts): ambient plus direct times N.L,
// summed in the client's colour space.
// Towards the sun, in three.js world space, for the neutral look; the
// client's moves through the day (sunDirection).
const NEUTRAL_SUN_TOWARDS = new Vector3(0.4, 1, 0.6).normalize();
// Indoor light for units in a building: the floor's colour under them,
// sampled by a ray from this far above their feet; resampled once they
// move this far, at most this many a frame.
const INDOOR_RAY_LIFT = 1.5;
const INDOOR_RESAMPLE_DISTANCE = 0.75;
const INDOOR_SAMPLES_PER_FRAME = 6;
// Object lights (torches, braziers): the nearest this many to the view's
// centre, within this reach, light what the scene's lights do (terrain,
// shaded props, units), not the buildings, whose torches are baked into
// their vertex colours. A fixed number of lights, so shaders compile once.
const OBJECT_LIGHT_COUNT = 16;
const OBJECT_LIGHT_REACH = 120;
const OBJECT_LIGHT_INTENSITY = 6;
const BACKGROUND = 0x08111d;
// High-density displays draw at most this many pixels per CSS pixel (before
// the viewer's render scale), so a 2x screen costs about half the pixels.
const MAX_PIXEL_RATIO = 1.5;
// Untextured ground until terrain textures are drawn.
const TERRAIN_COLOR = 0x4a5a3c;
// Effect heights on units drawn without a model, or whose model lacks the
// point, as fractions of a standing height (yards).
const DEFAULT_UNIT_HEIGHT = 2;
const CHEST_HEIGHT = 0.6;
const HEAD_HEIGHT = 0.9;
// A falling model (Blizzard's ice) finds the ground as the client does: a
// ray from just above the area's middle towards a point this high over its
// landing spot stops short of any roof (at this share of the way), then a
// ray this far down from there finds the ground.
const SHARD_START_LIFT = 1 / 6;
const SHARD_SEARCH_HEIGHT = 50 / 3;
const SHARD_ROOF_SHARE = 0.95;
const SHARD_GROUND_DEPTH = 100 / 3;
// Ground heights kept for particles before starting over, and new ones
// looked up a frame (the rest of a frame's particles stay where they're born).
const GROUND_CACHE_LIMIT = 4096;
const GROUND_RAYS_PER_FRAME = 64;

// Party fade, matching getSceneFade() in map-projection.ts: each volume keeps
// its surroundings solid, fading out over the height range above and below and
// (when on) over the outer half of the horizontal reach. Faded geometry is
// dithered with a 4x4 ordered pattern rather than alpha-blended, so solid
// walls keep writing depth and need no back-to-front sorting. Positions are in
// server coordinates; three.js is Y-up, so server (x, y, z) is (x, -z, y) here.
// The reach uniforms' values when there is none (floats, so not Infinity).
const NO_REACH = 1e9;
const floorAreaColor = new Color();
const DOWN = new Vector3(0, -1, 0);
const INDOOR_TOWARDS = serverToThree(INDOOR_LIGHT_DIRECTION.map((value) => -value) as Point3).normalize();
// All fade values live in one uniform buffer shared by every scene material,
// uploaded once a frame (per-material uniform arrays were re-sent on every
// material switch). three.js r186 mislays arrays of vectors in a uniforms
// group, so the block is one Float32Array packed by hand in std140 order.
const FADE_BLOCK = 'WowFade';
const FADE_VOLUME_MAX_OFFSET = MAX_FADE_VOLUMES * 4;
const FADE_REACH_MIN_OFFSET = FADE_VOLUME_MAX_OFFSET * 2;
const FADE_REACH_MAX_OFFSET = FADE_REACH_MIN_OFFSET + 4;
const FADE_PARAMS_OFFSET = FADE_REACH_MAX_OFFSET + 4;
// Floor areas (Starfall's reach) share the block: each a centre and radius,
// and a colour; then their count.
const MAX_FLOOR_AREAS = 8;
const FLOOR_AREA_OFFSET = FADE_PARAMS_OFFSET + 4;
const FLOOR_AREA_COLOR_OFFSET = FLOOR_AREA_OFFSET + MAX_FLOOR_AREAS * 4;
const FLOOR_AREA_COUNT_OFFSET = FLOOR_AREA_COLOR_OFFSET + MAX_FLOOR_AREAS * 4;
// The sky's raw light for lit scene materials (terrain and the map's props
// take it at terrain's gains): ambient and direct colours (w 1 while on) and
// the view-space way to the sun.
const CLIENT_AMBIENT_OFFSET = FLOOR_AREA_COUNT_OFFSET + 4;
const CLIENT_DIRECT_OFFSET = CLIENT_AMBIENT_OFFSET + 4;
const CLIENT_SUN_OFFSET = CLIENT_DIRECT_OFFSET + 4;
// The view-space way to the indoor light, for a building's props.
const CLIENT_INDOOR_OFFSET = CLIENT_SUN_OFFSET + 4;
const FADE_BLOCK_FLOATS = CLIENT_INDOOR_OFFSET + 4;
// A floor area paints only surfaces facing up at least this much, within
// this many yards of its centre's height, so walls, ceilings, and other
// floors stay clear: a faint fill and a thin, lighter rim.
const FLOOR_AREA_MIN_UPWARD = 0.6;
const FLOOR_AREA_HEIGHT_REACH = 5;
const FLOOR_AREA_FILL = 0.075;
const FLOOR_AREA_RIM = 0.35;
const FLOOR_AREA_RIM_LIGHTEN = 0.35;
// Floor areas lean a little towards blue from their school's colour, so
// Starfall's reads less pink.
const FLOOR_AREA_BLUE = new Color('#60a5fa');
const FLOOR_AREA_BLUE_SHIFT = 0.35;
// A building's props carry their own light, per instance (propLight).
const FADE_VERTEX_DECLARATIONS = `varying vec3 vWowPosition;
#ifdef WOW_BUILDING
varying vec3 vWowNormal;
#endif
#ifdef WOW_PROP_LIGHT
attribute vec2 wowPropKind;
attribute vec4 wowPropDirect;
varying vec2 vWowPropKind;
varying vec4 vWowPropDirect;
#endif
`;
const FADE_VERTEX = `
#ifdef WOW_BUILDING
vWowNormal = normalize(normalMatrix * normal);
#endif
#ifdef WOW_PROP_LIGHT
vWowPropKind = wowPropKind;
vWowPropDirect = wowPropDirect;
#endif
vec4 wowLocal = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
wowLocal = instanceMatrix * wowLocal;
#endif
vec4 wowWorld = modelMatrix * wowLocal;
vWowPosition = vec3(wowWorld.x, -wowWorld.z, wowWorld.y);
`;
const FADE_FRAGMENT_DECLARATIONS = `
#define WOW_MAX_VOLUMES ${MAX_FADE_VOLUMES}
layout(std140) uniform ${FADE_BLOCK} {
  vec4 wowVolumeMinPacked[WOW_MAX_VOLUMES];
  vec4 wowVolumeMaxPacked[WOW_MAX_VOLUMES];
  vec4 wowReachMinPacked;
  vec4 wowReachMaxPacked;
  // Height range, horizontal range, volume count.
  vec4 wowFadeParams;
  vec4 wowFloorAreaPacked[${MAX_FLOOR_AREAS}];
  vec4 wowFloorAreaColorPacked[${MAX_FLOOR_AREAS}];
  vec4 wowFloorAreaCountPacked;
  vec4 wowClientAmbientPacked;
  vec4 wowClientDirectPacked;
  vec4 wowClientSunPacked;
  vec4 wowClientIndoorPacked;
};
#define wowReachMin wowReachMinPacked.xyz
#define wowReachMax wowReachMaxPacked.xyz
#define wowHeightRange wowFadeParams.x
#define wowHorizontalRange wowFadeParams.y
#define wowVolumeCount int(wowFadeParams.z)
varying vec3 vWowPosition;
#ifdef WOW_PROP_LIGHT
varying vec2 vWowPropKind;
varying vec4 vWowPropDirect;
#endif
#ifdef WOW_BUILDING
varying vec3 vWowNormal;
uniform vec3 wowBuildingAmbient;
#endif
float wowBayer4(vec2 position) {
  const float pattern[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  ivec2 cell = ivec2(mod(position, 4.0));
  return (pattern[cell.x + cell.y * 4] + 0.5) / 16.0;
}
// Floor areas' light on this surface: none on walls, nor on floors well
// above or below an area. The rim is about a pixel and a half wide.
vec3 wowFloorAreas() {
  int count = int(wowFloorAreaCountPacked.x);
  if (count == 0) return vec3(0.0);
  vec3 normal = normalize(cross(dFdx(vWowPosition), dFdy(vWowPosition)));
  float pixel = max(length(fwidth(vWowPosition.xy)), 1e-4) * 0.7;
  if (abs(normal.z) < ${FLOOR_AREA_MIN_UPWARD.toFixed(2)}) return vec3(0.0);
  vec3 light = vec3(0.0);
  for (int index = 0; index < ${MAX_FLOOR_AREAS}; index++) {
    if (index >= count) break;
    vec4 area = wowFloorAreaPacked[index];
    if (abs(vWowPosition.z - area.z) > ${FLOOR_AREA_HEIGHT_REACH.toFixed(1)}) continue;
    float edge = length(vWowPosition.xy - area.xy) - area.w;
    float inside = 1.0 - smoothstep(-pixel, pixel, edge);
    float rim = 1.0 - smoothstep(0.75 * pixel, 1.5 * pixel, abs(edge + pixel));
    vec3 color = wowFloorAreaColorPacked[index].rgb;
    light += color * inside * ${FLOOR_AREA_FILL.toFixed(2)} + mix(color, vec3(1.0), ${FLOOR_AREA_RIM_LIGHTEN.toFixed(2)}) * rim * ${FLOOR_AREA_RIM.toFixed(2)};
  }
  return light;
}
float wowVolumeFade(int index) {
  vec3 outside = max(max(wowVolumeMinPacked[index].xyz - vWowPosition, vWowPosition - wowVolumeMaxPacked[index].xyz), 0.0);
  float vertical = clamp(1.0 - outside.z / wowHeightRange, 0.0, 1.0);
  if (wowHorizontalRange <= 0.0) return vertical;
  float core = wowHorizontalRange * 0.5;
  return vertical * (1.0 - clamp((length(outside.xy) - core) / (wowHorizontalRange - core), 0.0, 1.0));
}
`;
// Lit scene materials (Lambert: terrain, the map's props) under the map's
// light, as the client lights them, at terrain's gains. A building's props
// have their own light (applyPropLight): indoors (kind 0) the sky's raw
// ambient, which the client gives a prop when it makes it, and the floor's
// direct light from the indoor light's direction, leaning towards the sky's
// direct light and the sun by their share; outdoors (1) the map's light as
// its own props have; with no floor (2) a flat light. At their own
// brightness.
const CLIENT_LIGHT_FRAGMENT = `
if (wowClientAmbientPacked.w > 0.5) {
  vec3 wowAmbient = wowClientAmbientPacked.rgb * ${CLIENT_AMBIENT_GAIN.toFixed(4)};
  vec3 wowDirect = wowClientDirectPacked.rgb * ${CLIENT_DIRECT_GAIN.toFixed(4)};
  vec3 wowTowards = wowClientSunPacked.xyz;
  float wowBrightness = 1.0;
#ifdef WOW_PROP_LIGHT
  if (vWowPropKind.x < 0.5) {
    float wowShare = vWowPropKind.y;
    wowAmbient = wowClientAmbientPacked.rgb;
    wowDirect = mix(vWowPropDirect.rgb, wowClientDirectPacked.rgb, wowShare);
    wowTowards = mix(wowClientIndoorPacked.xyz, wowClientSunPacked.xyz, wowShare);
    wowTowards = dot(wowTowards, wowTowards) > 1e-6 ? normalize(wowTowards) : wowClientSunPacked.xyz;
  } else if (vWowPropKind.x > 1.5) {
    wowAmbient = vec3(1.0);
    wowDirect = vec3(0.0);
  }
  wowBrightness = vWowPropDirect.w;
#endif
  vec3 wowLight = wowAmbient + wowDirect * saturate(dot(normal, wowTowards));
  reflectedLight.indirectDiffuse += diffuseColor.rgb * pow(max(wowLight, vec3(0.0)), vec3(2.2)) * wowBrightness;
}
`;
const FADE_FRAGMENT = `
if (any(lessThan(vWowPosition, wowReachMin)) || any(greaterThan(vWowPosition, wowReachMax))) discard;
float wowFade = wowVolumeCount == 0 ? 1.0 : 0.0;
for (int index = 0; index < WOW_MAX_VOLUMES; index++) {
  if (index >= wowVolumeCount) break;
  wowFade = max(wowFade, wowVolumeFade(index));
}
if (wowFade <= 0.0 || wowFade < wowBayer4(gl_FragCoord.xy)) discard;
`;

// A WMO group's extras sit on its node: the mesh itself, or the group of
// meshes holding its primitives.
// One function for every material, so three.js shares the compiled program.
// The material also needs the fade block (withFade).
function injectPartyFade(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = FADE_VERTEX_DECLARATIONS + shader.vertexShader
    .replace('#include <project_vertex>', `#include <project_vertex>\n${FADE_VERTEX}`);
  shader.fragmentShader = FADE_FRAGMENT_DECLARATIONS + shader.fragmentShader
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FADE_FRAGMENT}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${CLIENT_LIGHT_FRAGMENT}`)
    .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb += wowFloorAreas();');
}

// A building batch's material (three.js calls it as the material's): its
// own ambient (the newer path's) in its userData.
function injectBuildingLight(this: Material, shader: WebGLProgramParametersWithUniforms): void {
  injectPartyFade(shader);
  shader.uniforms.wowBuildingAmbient = { value: this.userData.wowBuildingAmbient as Color };
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', BUILDING_LIGHT_FRAGMENT);
}

function isExteriorGroup(mesh: Mesh): boolean {
  const node = mesh.userData.kind === 'wmoGroup' ? mesh : mesh.parent;
  return node?.userData.kind === 'wmoGroup' && Boolean(node.userData.exterior);
}

// A building's prop's floor light, as the scene stores it (encodePropFloor
// in export-scene.mjs): [r, g, b, share] per instance; r -1 outdoors, -2
// with no floor found. Null for other meshes and older scenes.
function propFloors(mesh: Mesh): ArrayLike<number> | null {
  if (mesh instanceof InstancedMesh) {
    const floors = mesh.geometry.getAttribute('_WOWFLOOR');
    return floors ? floors.array : null;
  }
  const node = mesh.userData.kind === 'doodad' ? mesh : mesh.parent;
  const floor = node?.userData.kind === 'doodad' ? node.userData.wowFloor as number[] | undefined : undefined;
  return floor?.length === 4 ? floor : null;
}

// Gives a building's prop its light per instance, on its own copy of the
// geometry (the buffers are shared): wowPropKind is [kind, share] and
// wowPropDirect the floor's direct light and the brightness (see
// CLIENT_LIGHT_FRAGMENT). Worked out once per prop; each primitive gets its
// own copy, as culling repacks each one's copies (chooseVisible), and keeps
// the originals for that. Indoors the client's light from the floor (its
// direct light; Wow.exe FUN_007a0d60 keeps the floor's ambient apart, and the
// prop's light setup FUN_007c1730 reads the sky ambient it was made with);
// outdoors the map's light as its own props; with no floor, a flat light as
// unlit props have. Brightness is relative to the shaded props' colour.
interface PropLight {
  kind: Float32Array;
  direct: Float32Array;
}
const propLights = new WeakMap<object, PropLight>();

function propLight(floors: ArrayLike<number>): PropLight {
  const count = floors.length / 4;
  const kind = new Float32Array(count * 2);
  const direct = new Float32Array(count * 4);
  for (let index = 0; index < count; index += 1) {
    const [r, g, b, share] = [floors[index * 4], floors[index * 4 + 1], floors[index * 4 + 2], floors[index * 4 + 3]];
    if (r === -1) {
      kind.set([1, 1], index * 2);
      direct.set([0, 0, 0, 1], index * 4);
    } else if (r < 0) {
      kind.set([2, 0], index * 2);
      direct.set([0, 0, 0, UNLIT_BRIGHTNESS / PROP_BRIGHTNESS], index * 4);
    } else {
      kind.set([0, share], index * 2);
      direct.set([...indoorLight([r, g, b]).direct, 1 / PROP_BRIGHTNESS], index * 4);
    }
  }
  return { kind, direct };
}

function applyPropLight(mesh: Mesh, floors: ArrayLike<number>): void {
  let light = propLights.get(floors);
  if (!light) propLights.set(floors, light = propLight(floors));
  const source = mesh.geometry;
  const geometry = new BufferGeometry();
  geometry.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.boundingBox = source.boundingBox?.clone() ?? null;
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  geometry.userData = source.userData;
  geometry.setAttribute('wowPropKind', new InstancedBufferAttribute(light.kind.slice(), 2));
  geometry.setAttribute('wowPropDirect', new InstancedBufferAttribute(light.direct.slice(), 4));
  mesh.userData.wowPropLight = light;
  mesh.geometry = geometry;
}

// Numbers a scene's building batches: each group's primitives are its render
// batches, in order (userData.wowBatch).
function numberBuildingBatches(root: Object3D): void {
  root.traverse((node) => {
    if (node.userData.kind !== 'wmoGroup') return;
    let batch = 0;
    node.traverse((child) => {
      if (child instanceof Mesh) child.userData.wowBatch = batch++;
    });
  });
}

// A building group's batch, as the scene describes it (the group node's
// extras): which batch it is, the group's batch counts and flags, and its
// building's render path and ambient. Scenes exported before have only the
// group's exterior flag: its batches all outdoor ones or all indoor. Null
// for other meshes.
function buildingBatch(mesh: Mesh): { batch: number; counts: readonly number[]; unified: boolean; ambient: number; flags: number } | null {
  const node = mesh.userData.kind === 'wmoGroup' ? mesh : mesh.parent;
  if (node?.userData.kind !== 'wmoGroup') return null;
  const exterior = Boolean(node.userData.exterior);
  return {
    batch: (mesh.userData.wowBatch as number | undefined) ?? 0,
    counts: (node.userData.wmoBatches as number[] | undefined) ?? (exterior ? [0, 0, Infinity] : [0, Infinity, 0]),
    unified: Boolean(node.userData.wmoUnified),
    ambient: (node.userData.wmoAmbient as number | undefined) ?? 0,
    flags: (node.userData.wmoFlags as number | undefined) ?? (exterior ? WMO_GROUP_FLAG_EXTERIOR : 0),
  };
}
const WMO_GROUP_FLAG_EXTERIOR = 0x8;

// A prop the map places itself (from its ADTs), rather than one of a
// building's: a building's props are siblings of its groups. By parent, as a
// scene has thousands of props under one root.
const placesBuildings = new WeakMap<Object3D, boolean>();
function isWorldProp(mesh: Mesh): boolean {
  const node = mesh.userData.kind === 'doodad' || mesh.userData.kind === 'doodads' ? mesh : mesh.parent;
  if (node?.userData.kind !== 'doodad' && node?.userData.kind !== 'doodads') return false;
  const parent = node.parent;
  if (!parent) return true;
  let buildings = placesBuildings.get(parent);
  if (buildings === undefined) {
    buildings = parent.children.some((sibling) => sibling.userData.kind === 'wmoGroup');
    placesBuildings.set(parent, buildings);
  }
  return !buildings;
}

// Building batches share one vertex buffer per WMO group, so three.js would
// size every batch's bounds to the whole group. Fit them to the vertices the
// batch's triangles actually use, so fade and frustum culling can skip it.
function fitBoundsToIndices(geometry: BufferGeometry, fitted: WeakSet<BufferGeometry>): void {
  if (fitted.has(geometry)) return;
  fitted.add(geometry);
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  if (!index || !position) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return;
  }
  const box = new Box3();
  const vertex = new Vector3();
  for (let item = 0; item < index.count; item += 1) box.expandByPoint(vertex.fromBufferAttribute(position, index.getX(item)));
  geometry.boundingBox = box;
  geometry.boundingSphere = box.getBoundingSphere(new Sphere());
}

interface MeshBounds {
  mesh: Mesh;
  // Server coordinates.
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  // An instanced prop (one model's copies under a building or the map).
  instances?: InstanceBounds;
}

// The copies of an instanced prop. Those the fade and reach cut leave in
// are packed to the front of its instance buffer, so faded copies are
// skipped one by one, as separate meshes are.
interface InstanceBounds {
  // Each copy's matrix as loaded (16 floats each).
  matrices: Float32Array;
  // Each copy's box in server coordinates: minX, maxX, minY, maxY, minZ, maxZ.
  boxes: Float32Array;
  // The copies drawn now, by index (the mesh's count says how many).
  shown: Uint32Array;
}

// Server-coordinate box of `geometry` placed by `matrix`; three.js is Y-up,
// so server (x, y, z) is (x, -z, y).
const scratchBox = new Box3();
const scratchMatrix = new Matrix4();
function serverBox(geometry: BufferGeometry, matrix: Matrix4): [number, number, number, number, number, number] {
  const box = scratchBox.copy(geometry.boundingBox!).applyMatrix4(matrix);
  return [box.min.x, box.max.x, -box.max.z, -box.min.z, box.min.y, box.max.y];
}

function instanceBounds(mesh: InstancedMesh): { bounds: InstanceBounds; union: number[] } {
  // Every copy the file holds (count may already be the visible ones).
  const count = mesh.instanceMatrix.count;
  const matrices = new Float32Array(mesh.instanceMatrix.array);
  const boxes = new Float32Array(count * 6);
  const union = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  const instance = new Matrix4();
  const world = new Matrix4();
  for (let index = 0; index < count; index += 1) {
    const box = serverBox(mesh.geometry, world.multiplyMatrices(mesh.matrixWorld, instance.fromArray(matrices, index * 16)));
    boxes.set(box, index * 6);
    for (let axis = 0; axis < 6; axis += 2) {
      union[axis] = Math.min(union[axis], box[axis]);
      union[axis + 1] = Math.max(union[axis + 1], box[axis + 1]);
    }
  }
  const shown = new Uint32Array(count);
  shown.forEach((_, index) => { shown[index] = index; });
  return { bounds: { matrices, boxes, shown }, union };
}

export type SceneLoadState = 'loading' | 'ready' | 'failed';

// Whether the scene is drawn at a point (server coordinates) under a frame's
// fade: inside the reach box and at least half faded in.
function isDrawnAt(point: Point3, { volumes, fade }: { volumes: FadeVolume[]; fade: FadeSettings }): boolean {
  const [x, y, z] = point;
  const reach = fade.reach;
  if (reach && (x < reach.minX || x > reach.maxX || y < reach.minY || y > reach.maxY || z < reach.minZ || z > reach.maxZ)) return false;
  return getSceneFade(point, volumes, fade) >= 0.5;
}

// Draws an exported instance scene with an orthographic camera that matches
// the overlay's IsoView projection. Renders only when asked.
export class InstanceSceneView {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera();
  // The fade block's contents, shared by every scene material.
  private readonly fadeData = new Float32Array(FADE_BLOCK_FLOATS);
  private readonly ambient = new AmbientLight(0xffffff, NEUTRAL_AMBIENT);
  private readonly sun = new DirectionalLight(0xffffff, NEUTRAL_SUN);
  private mapLights: MapLights | null = null;
  private lighting: SceneLighting = 'client';
  private objectLightsOn = true;
  // Towards the sun now, in three.js world space (applyLighting).
  private readonly sunTowards = NEUTRAL_SUN_TOWARDS.clone();
  // ?lightTime=HH:MM pins the time of day the map's light is drawn at, to
  // compare its look through the day.
  private readonly pinnedTime = ((): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(window.location.search).get('lightTime') ?? '');
    return match ? (Number(match[1]) * 60 + Number(match[2])) * 2 : null;
  })();
  private readonly objectLights = Array.from({ length: OBJECT_LIGHT_COUNT }, () => {
    // No falloff with distance but the fade to `distance`, as the client's
    // lights fade out between two distances.
    const light = new PointLight(0xffffff, 0, 1, 0);
    light.visible = false;
    return light;
  });
  private readonly fadeGroup = new UniformsGroup().setName(FADE_BLOCK).add(new Uniform(this.fadeData));
  // Scenes are meshopt-compressed (scripts/scene/export-scene.mjs).
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly roots = new Map<string, Object3D>();
  // World bounds of each mesh, so wholly faded meshes are not drawn.
  private readonly meshBounds = new Map<Object3D, MeshBounds[]>();
  private readonly states = new Map<string, SceneLoadState>();
  private readonly materials = new Map<string, Material>();
  private shown: Object3D | null = null;
  // Ground heights for particles, for the scene and floors as last shown.
  private readonly groundHeights = new Map<string, number | null>();
  private groundKey = '';
  private groundRays = 0;
  private lost = false;
  // Player and creature models; lit, unlike the scene.
  private readonly units: UnitModelLayer;
  // Spell effects, drawn over everything.
  private readonly effects = new SpellEffectLayer();
  // The client's own spell art, where a spell has it.
  private readonly spellVisuals: SpellVisualLayer;
  private readonly gameObjects: GameObjectLayer;
  private effectsShown = false;
  // Liquid materials and their animation frames, by scene URL.
  private readonly liquids = new Map<string, Array<{ material: MeshBasicMaterial; frames: Texture[] }>>();
  // What the canvas currently shows, to skip redrawing an unchanged frame.
  private lastFrameKey = '';
  // The fade and reach the scene's visible meshes were last chosen for.
  private visibilityKey = '';
  // The fade the last frame drew with, for picking only what can be seen.
  private lastFade: { volumes: FadeVolume[]; fade: FadeSettings } | null = null;
  private readonly raycaster = new Raycaster();
  // Each scene's interior WMO groups' meshes, by group ID, for indoor light.
  private readonly interiors = new WeakMap<Object3D, Map<number, Mesh[]>>();
  // Units' indoor light from the floor under them, and its share of the
  // outdoor light (on a transition face), with where and in which group it
  // was sampled.
  private readonly indoorLights = new Map<string, { groupId: number; position: Point3; light: LightColors | null; outdoor: number }>();
  // The sky's raw light (with the zone's character ambient), which the
  // client blends a unit's indoor light towards on transition faces (Wow.exe
  // FUN_007c1c40); the light outdoors carries terrain's gains.
  private unitSkyLight: LightColors = { direct: [0, 0, 0], ambient: [0, 0, 0] };
  // Transition faces by batch, as sets (from the light file's lists).
  private readonly transitionSets = new WeakMap<number[], Set<number>>();
  // The server point at the centre of the last frame drawn, and the view's
  // frustum, for the units' animation budget.
  private lastViewCentre: Point3 | null = null;
  private readonly frustum = new Frustum();
  // The viewer's render scale (0.5 to 1), times the capped pixel ratio.
  private renderScale = 1;
  // The canvas size and pixel ratio last set, to resize only on a change.
  private sizeKey = '';

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onChange: () => void) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(BACKGROUND);
    // A loaded scene never moves: its world matrices are set once in load()
    // and render() updates only the live layers, rather than three.js walking
    // every node of a big map each frame.
    this.scene.matrixWorldAutoUpdate = false;
    this.units = new UnitModelLayer(this.redraw);
    this.scene.add(this.units.group);
    this.scene.add(this.effects.group);
    const ground = (point: Point3) => this.groundBelow(point);
    this.spellVisuals = new SpellVisualLayer(this.redraw, ground);
    this.scene.add(this.spellVisuals.group);
    this.gameObjects = new GameObjectLayer(this.redraw, ground);
    this.scene.add(this.gameObjects.group);
    this.scene.add(this.ambient, ...this.objectLights);
    this.sun.position.set(0.4, 1, 0.6);
    this.scene.add(this.sun);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
      this.redraw();
    });
  }

  // Draws the next frame in full (a model loaded, the context was lost).
  private readonly redraw = (): void => {
    this.lastFrameKey = '';
    this.onChange();
  };

  static isSupported(): boolean {
    try {
      return Boolean(document.createElement('canvas').getContext('webgl2'));
    } catch {
      return false;
    }
  }

  get available(): boolean {
    return !this.lost;
  }

  // Draws at `scale` (0.5 to 1) of the capped resolution; the canvas is
  // stretched to fit.
  setRenderScale(scale: number): void {
    if (scale === this.renderScale) return;
    this.renderScale = scale;
    this.lastFrameKey = '';
  }

  // Places the unit models for the next render; returns the IDs drawn as
  // models (the rest still need markers).
  setUnits(poses: UnitModelPose[], nowMs: number): Set<string> {
    if (this.lost) return new Set();
    // Animations the spells' kits ask for (from the last frame's effects).
    const animations = this.spellVisuals.takeAnimations();
    // The animation budget goes by the last frame's camera and centre.
    const view = this.lastViewCentre ? {
      frustum: this.frustum.setFromProjectionMatrix(
        scratchMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)),
      centre: this.lastViewCentre,
    } : null;
    this.updateIndoorLights(poses);
    return this.units.update(animations.size ? poses.map((pose) => {
      const animation = animations.get(pose.id);
      return animation ? { ...pose, kitLoop: animation.loop, kitOnce: animation.once } : pose;
    }) : poses, nowMs, view);
  }

  // Units lit by their building's light, for ?debug.
  get indoorCount(): number {
    let count = 0;
    for (const { light } of this.indoorLights.values()) if (light) count += 1;
    return count;
  }

  // Samples the indoor light of units standing in an interior WMO group (as
  // the client does: the floor's baked colour under them), within a budget
  // a frame and only once they have moved; drops it for the rest.
  private updateIndoorLights(poses: UnitModelPose[]): void {
    const interiors = this.lighting === 'client' && this.shown ? this.interiors.get(this.shown) : undefined;
    const indoors = new Set<string>();
    let budget = INDOOR_SAMPLES_PER_FRAME;
    for (const pose of poses) {
      const groupId = pose.wmoGroupId ?? -1;
      const meshes = interiors?.get(groupId);
      const group = this.mapLights?.interiors?.[groupId];
      if (!meshes || group?.outdoor) continue;
      indoors.add(pose.id);
      const known = this.indoorLights.get(pose.id);
      const fresh = known && known.groupId === groupId
        && Math.hypot(known.position[0] - pose.x, known.position[1] - pose.y, known.position[2] - pose.z) < INDOOR_RESAMPLE_DISTANCE;
      if (fresh || budget <= 0) continue;
      budget -= 1;
      const floor = this.floorColor(meshes, [pose.x, pose.y, pose.z]);
      const transitions = floor && group?.transitions?.[floor.batch];
      this.indoorLights.set(pose.id, {
        groupId,
        position: [pose.x, pose.y, pose.z],
        light: floor ? indoorLight(floorLight(floor.color, group?.ambient)) : known?.light ?? null,
        outdoor: floor ? (transitions && this.transitionSet(transitions).has(floor.triangle) ? floor.alpha : 0) : known?.outdoor ?? 0,
      });
    }
    for (const id of this.indoorLights.keys()) if (!indoors.has(id)) this.indoorLights.delete(id);
  }

  private transitionSet(triangles: number[]): Set<number> {
    let set = this.transitionSets.get(triangles);
    if (!set) this.transitionSets.set(triangles, set = new Set(triangles));
    return set;
  }

  // The baked vertex colour and alpha of the floor under a point (client
  // values, 0 to 1), and the render batch and triangle it is on, from a ray
  // down from a little above it; null if it misses.
  private floorColor(meshes: Mesh[], [x, y, z]: Point3): { color: Rgb; alpha: number; batch: number; triangle: number } | null {
    this.raycaster.set(serverToThree([x, y, z + INDOOR_RAY_LIFT]), DOWN);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit?.face || !hit.barycoord || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const colors = (hit.object as Mesh).geometry.getAttribute('color');
    const { a, b, c } = hit.face;
    const { x: wa, y: wb, z: wc } = hit.barycoord;
    const at = (channel: number) =>
      colors.getComponent(a, channel) * wa + colors.getComponent(b, channel) * wb + colors.getComponent(c, channel) * wc;
    return {
      color: [at(0), at(1), at(2)],
      alpha: colors.itemSize > 3 ? at(3) : 1,
      batch: (hit.object.userData.wowBatch as number | undefined) ?? 0,
      triangle: hit.faceIndex,
    };
  }

  // Where an effect sits on a unit, in server coordinates: the model's own
  // point when it has one, otherwise a height up from its feet. `positions`
  // holds the units shown (feet, server coordinates).
  anchor(positions: ReadonlyMap<UnitKey, Point3>, unit: UnitKey, role: UnitAnchorRole): Point3 | null {
    const feet = positions.get(unit);
    if (!feet) return null;
    if (role === 'feet') return feet;
    const point = this.units.pointOf(unit, role);
    if (point) return point;
    const height = this.units.heightOf(unit) ?? DEFAULT_UNIT_HEIGHT;
    const up = role === 'overhead' ? height + 0.3 : role === 'head' || role === 'breath' ? height * HEAD_HEIGHT : height * CHEST_HEIGHT;
    return [feet[0], feet[1], feet[2] + up];
  }

  // Places the store's live effects for the next render; call after
  // setUnits, so hand points follow this frame's animation. Area taunts
  // (`isTaunt`) keep their floor area even when the client's art plays too.
  // `aids` says which of WowMin's own aids to draw beside the client's art;
  // `creatureTypeFlags` gives a creature's type_flags (some colours skip
  // some creatures).
  setEffects(store: CombatEffectStore | null, positions: ReadonlyMap<UnitKey, Point3>, now: number,
    auras?: ReadonlyMap<UnitKey, readonly number[]>, isTaunt: (spellId: number) => boolean = () => false,
    aids: SpellAids = ALL_SPELL_AIDS, creatureTypeFlags: (unit: UnitKey) => number = () => 0): number {
    if (this.lost) return 0;
    const before = this.effects.count + this.spellVisuals.count;
    this.groundRays = 0;
    const anchor = (unit: UnitKey, role: UnitAnchorRole) => this.anchor(positions, unit, role);
    const units: UnitInfo = {
      anchor,
      attachment: (unit, attachment, offset) => (positions.has(unit) ? this.units.attachmentOf(unit, attachment, offset) : null),
      isDrawn: (unit) => this.units.isDrawn(unit),
      scale: (unit) => this.units.scaleOf(unit) ?? 1,
      height: (unit) => this.units.heightOf(unit) ?? DEFAULT_UNIT_HEIGHT,
      facing: (unit) => this.units.orientationOf(unit) ?? 0,
      ground: (center, target) => this.groundUnder(center, target),
      releaseMs: (unit, clip) => this.units.releaseMsOf(unit, clip),
      intersect: (from, to) => this.intersect(from, to),
      blades: (unit) => this.units.bladesOf(unit),
      effectScales: (unit) => this.units.effectScalesOf(unit),
      attachmentTurn: (unit, attachment) => (positions.has(unit) ? this.units.attachmentTurnOf(unit, attachment) : null),
      creatureTypeFlags,
    };
    this.spellVisuals.update(store, now, units, this.camera, auras);
    const looks = this.spellVisuals.unitLooks(now);
    const ambientScale = characterAmbientScale(this.mapLights?.ambientMultiplier);
    for (const [id, { light, outdoor }] of this.indoorLights) {
      if (!light) continue;
      const look: UnitLook = looks.get(id) ?? { color: null, alpha: 1 };
      const own = { direct: light.direct, ambient: scaleAmbient(light.ambient, ambientScale) };
      look.indoor = { ...(outdoor > 0 ? blendLight(own, this.unitSkyLight, outdoor) : own), outdoor };
      looks.set(id, look);
    }
    this.units.setLooks(looks);
    this.effects.update(store, now, anchor,
      (entry) => this.spellVisuals.handles(entry) && !('radius' in entry && isTaunt(entry.spellId)), aids);
    const areas = this.setFloorAreas(store && auras && aids.circles ? this.spellVisuals.bearerAreas(auras) : [], anchor);
    const count = this.effects.count + this.spellVisuals.count + areas;
    // One more frame after the last effect ends, to clear it.
    this.effectsShown = count > 0 || before > 0;
    return count;
  }

  // Where a falling model aimed at `target` lands, searched from `center`:
  // the first surface under it, below any roof, or `center` if none.
  private groundUnder(center: Point3, [x, y]: Point3): Point3 {
    const root = this.shown;
    if (!root) return center;
    const start = serverToThree([center[0], center[1], center[2] + SHARD_START_LIFT]);
    const end = serverToThree([x, y, center[2] + SHARD_SEARCH_HEIGHT]);
    const length = start.distanceTo(end);
    const roof = this.cast(root, start, end.clone().sub(start).normalize(), length);
    const top = roof ? start.lerp(end, (roof.distance / length) * SHARD_ROOF_SHARE) : end;
    const ground = this.cast(root, top, DOWN, SHARD_GROUND_DEPTH);
    return ground ? threeToServer(ground.point) : center;
  }

  // The height of the first surface up to PARTICLE_GROUND_DEPTH below a
  // point, as the client finds the ground for particles that start on it;
  // kept by the half yard across (two up and down), since many are born
  // close together.
  private groundBelow([x, y, z]: Point3): number | null {
    const root = this.shown;
    if (!root) return null;
    if (this.groundHeights.size > GROUND_CACHE_LIMIT) this.groundHeights.clear();
    const key = `${Math.round(x * 2)},${Math.round(y * 2)},${Math.round(z / 2)}`;
    const known = this.groundHeights.get(key);
    if (known !== undefined) return known;
    if (this.groundRays >= GROUND_RAYS_PER_FRAME) return null;
    this.groundRays += 1;
    const hit = this.cast(root, serverToThree([x, y, z]), DOWN, PARTICLE_GROUND_DEPTH);
    const height = hit ? threeToServer(hit.point)[2] : null;
    this.groundHeights.set(key, height);
    return height;
  }

  // Where a segment first meets the map's terrain or buildings, as a share
  // of its length, or null.
  private intersect(from: Point3, to: Point3): number | null {
    const root = this.shown;
    if (!root) return null;
    const start = serverToThree(from);
    const end = serverToThree(to);
    const length = start.distanceTo(end);
    if (length <= 0) return null;
    const hit = this.cast(root, start, end.sub(start).normalize(), length);
    return hit ? hit.distance / length : null;
  }

  // The nearest hit within `far` of a ray from `start` along `direction`, as
  // solidHit finds them.
  private cast(root: Object3D, start: Vector3, direction: Vector3, far: number): Intersection | null {
    this.raycaster.set(start, direction);
    this.raycaster.far = far;
    const hit = this.solidHit(root);
    this.raycaster.far = Infinity;
    return hit;
  }

  // The raycaster's nearest hit on the map's terrain and buildings (not its
  // props), drawn now.
  private solidHit(root: Object3D): Intersection | null {
    for (const hit of this.raycaster.intersectObject(root, true)) {
      if (hit.object instanceof InstancedMesh) continue;
      let shown = true;
      for (let object: Object3D | null = hit.object; object; object = object.parent) shown &&= object.visible;
      if (shown) return hit;
    }
    return null;
  }

  // Puts bearer areas round their units' feet into the fade block, for the
  // scene's shaders to paint on the floor; returns how many there are.
  private setFloorAreas(areas: readonly BearerAreaCircle[], anchor: (unit: UnitKey, role: UnitAnchorRole) => Point3 | null): number {
    const data = this.fadeData;
    let count = 0;
    for (const area of areas) {
      const feet = anchor(area.unit, 'feet');
      if (!feet || area.radius <= 0 || count >= MAX_FLOOR_AREAS) continue;
      data.set([feet[0], feet[1], feet[2], area.radius], FLOOR_AREA_OFFSET + count * 4);
      floorAreaColor.set(area.color).lerp(FLOOR_AREA_BLUE, FLOOR_AREA_BLUE_SHIFT);
      data.set([floorAreaColor.r, floorAreaColor.g, floorAreaColor.b], FLOOR_AREA_COLOR_OFFSET + count * 4);
      count += 1;
    }
    data[FLOOR_AREA_COUNT_OFFSET] = count;
    return count;
  }

  // Places the game objects for the next render, leaving out those the
  // last frame's fade or reach cut hides; returns how many are drawn.
  setGameObjects(poses: GameObjectPose[], now: number): number {
    if (this.lost) return 0;
    const fade = this.lastFade;
    const shown = fade ? poses.filter(({ position }) => isDrawnAt(position, fade)) : poses;
    this.groundRays = 0;
    this.gameObjects.update(shown, now, this.camera);
    return this.gameObjects.count;
  }

  // Whether an aura's spell shows the client's art (so a marker's halo gives way).
  hasAuraArt(spellId: number): boolean {
    return this.spellVisuals.hasAuraArt(spellId);
  }

  // The client's spell art playing, and its live particles, for ?debug.
  get spellArt(): { effects: number; particles: number } {
    return { effects: this.spellVisuals.count, particles: this.spellVisuals.particles };
  }

  state(url: string): SceneLoadState | undefined {
    return this.states.get(url);
  }

  load(url: string): void {
    if (this.states.has(url)) return;
    this.states.set(url, 'loading');
    this.loader.load(url, async (gltf) => {
      const root = gltf.scene;
      const terrain = await this.terrainTextures(gltf);
      const frames = await this.liquidFrames(gltf);
      const liquids: Array<{ material: MeshBasicMaterial; frames: Texture[] }> = [];
      numberBuildingBatches(root);
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const liquid = (object.material as Material).userData?.wowLiquid as LiquidExtras | undefined;
        if (liquid) {
          const material = this.liquidMaterial(liquid, frames);
          if (material) {
            object.material = material.material;
            object.renderOrder = 1;
            liquids.push(material);
            return;
          }
        }
        object.material = this.convertMaterial(object, terrain);
      });
      if (liquids.length) this.liquids.set(url, liquids);
      root.updateMatrixWorld(true);
      const bounds: MeshBounds[] = [];
      const fitted = new WeakSet<BufferGeometry>();
      root.traverse((object) => {
        object.matrixAutoUpdate = false;
        if (!(object instanceof Mesh)) return;
        fitBoundsToIndices(object.geometry, fitted);
        if (object instanceof InstancedMesh) {
          const { bounds: instances, union: [minX, maxX, minY, maxY, minZ, maxZ] } = instanceBounds(object);
          bounds.push({ mesh: object, minX, maxX, minY, maxY, minZ, maxZ, instances });
          return;
        }
        const [minX, maxX, minY, maxY, minZ, maxZ] = serverBox(object.geometry, object.matrixWorld);
        bounds.push({ mesh: object, minX, maxX, minY, maxY, minZ, maxZ });
      });
      this.meshBounds.set(root, bounds);
      this.roots.set(url, root);
      const interiors = new Map<number, Mesh[]>();
      root.traverse((node) => {
        if (node.userData.kind !== 'wmoGroup' || node.userData.exterior) return;
        const meshes = interiors.get(node.userData.wmoGroupId as number) ?? [];
        node.traverse((child) => { if (child instanceof Mesh && child.geometry.getAttribute('color')) meshes.push(child); });
        if (meshes.length) interiors.set(node.userData.wmoGroupId as number, meshes);
      });
      this.interiors.set(root, interiors);
      this.states.set(url, 'ready');
      this.onChange();
    }, undefined, (error) => {
      console.warn(`Could not load instance scene ${url}`, error);
      this.states.set(url, 'failed');
      this.onChange();
    });
  }

  // Geometry stays solid around the fade volumes (the party) and fades out
  // beyond them per `fade`. With no volumes everything is drawn solid.
  render(
    url: string,
    view: IsoView,
    width: number,
    height: number,
    volumes: FadeVolume[],
    fade: FadeSettings,
  ): boolean {
    const root = this.roots.get(url);
    if (!root || this.lost) return false;
    const active = volumes.slice(0, MAX_FADE_VOLUMES);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO) * this.renderScale;
    // Live positions redraw the overlay up to 30 times a second; the scene only
    // changes when the camera moves or the fade shifts by about a yard.
    const visibilityKey = [
      url, fade.height, fade.horizontal ?? 0,
      ...(fade.reach ? [fade.reach.minX, fade.reach.maxX, fade.reach.minY, fade.reach.maxY, fade.reach.minZ, fade.reach.maxZ] : ['none']),
      ...active.flatMap((volume) => [volume.minX, volume.maxX, volume.minY, volume.maxY, volume.minZ, volume.maxZ]
        .map((value) => Math.round(value))),
    ].join('|');
    if (visibilityKey !== this.groundKey) {
      this.groundKey = visibilityKey;
      this.groundHeights.clear();
    }
    const lightKey = this.applyLighting(view.center);
    const frameKey = [
      visibilityKey, width, height, pixelRatio, view.pixelsPerUnit.toFixed(4),
      ...view.center.map((value) => value.toFixed(3)),
      ...view.basis.toCamera.map((value) => value.toFixed(5)),
      lightKey,
    ].join('|');
    // Animated models, live effects, and liquids need every frame.
    const liquids = this.liquids.get(url);
    if (frameKey === this.lastFrameKey && !this.units.count && !this.effectsShown && !liquids?.length
      && !this.gameObjects.count) return true;
    if (liquids) {
      for (const liquid of liquids) {
        liquid.material.map = liquid.frames[Math.floor(performance.now() / (1000 / LIQUID_FPS)) % liquid.frames.length];
      }
    }
    this.lastFrameKey = frameKey;
    this.lastFade = { volumes: active, fade };
    if (this.shown !== root) {
      if (this.shown) this.scene.remove(this.shown);
      this.scene.add(root);
      this.shown = root;
    }
    const data = this.fadeData;
    active.forEach((volume, index) => {
      data.set([volume.minX, volume.minY, volume.minZ], index * 4);
      data.set([volume.maxX, volume.maxY, volume.maxZ], FADE_VOLUME_MAX_OFFSET + index * 4);
    });
    const reachBox = fade.reach ?? {
      minX: -NO_REACH, maxX: NO_REACH, minY: -NO_REACH, maxY: NO_REACH, minZ: -NO_REACH, maxZ: NO_REACH,
    };
    data.set([reachBox.minX, reachBox.minY, reachBox.minZ], FADE_REACH_MIN_OFFSET);
    data.set([reachBox.maxX, reachBox.maxY, reachBox.maxZ], FADE_REACH_MAX_OFFSET);
    data.set([fade.height, fade.horizontal ?? 0, active.length], FADE_PARAMS_OFFSET);
    if (visibilityKey !== this.visibilityKey) {
      this.visibilityKey = visibilityKey;
      this.chooseVisible(root, active, fade, reachBox);
    }
    // Resizing clears and reallocates the drawing buffer, so only on a change.
    const sizeKey = `${width}x${height}@${pixelRatio}`;
    if (sizeKey !== this.sizeKey) {
      this.sizeKey = sizeKey;
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setSize(width, height, false);
    }
    applyIsoCamera(this.camera, view, width, height);
    this.lastViewCentre = [view.center[0], view.center[1], view.center[2]];
    // The ways to the sun and to the indoor light, in view space.
    clientLight.sun.copy(this.sunTowards).transformDirection(this.camera.matrixWorldInverse);
    clientLight.indoor.copy(INDOOR_TOWARDS).transformDirection(this.camera.matrixWorldInverse);
    this.fadeData.set([clientLight.sun.x, clientLight.sun.y, clientLight.sun.z], CLIENT_SUN_OFFSET);
    this.fadeData.set([clientLight.indoor.x, clientLight.indoor.y, clientLight.indoor.z], CLIENT_INDOOR_OFFSET);
    // setUnits has already updated the unit models' matrices this frame.
    for (const child of this.scene.children) if (child !== root && child !== this.units.group) child.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    // Exposed for diagnosing slow scenes from the browser's developer tools.
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.canvas.dataset.triangles = String(this.renderer.info.render.triangles);
    this.canvas.dataset.buffer = `${this.canvas.width}x${this.canvas.height}`;
    return true;
  }

  // Leaves out the meshes, and the copies of instanced props, wholly beyond
  // the reach box or the fade volumes' reach.
  private chooseVisible(root: Object3D, active: FadeVolume[], fade: FadeSettings, reachBox: NonNullable<FadeSettings['reach']>): void {
    const reach = fade.horizontal ?? Infinity;
    const shown = (minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): boolean =>
      minZ <= reachBox.maxZ && maxZ >= reachBox.minZ
      && minX <= reachBox.maxX && maxX >= reachBox.minX
      && minY <= reachBox.maxY && maxY >= reachBox.minY && (!active.length || active.some((volume) =>
        maxZ > volume.minZ - fade.height && minZ < volume.maxZ + fade.height
        && maxX > volume.minX - reach && minX < volume.maxX + reach
        && maxY > volume.minY - reach && minY < volume.maxY + reach));
    for (const bounds of this.meshBounds.get(root) ?? []) {
      const visible = shown(bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.minZ, bounds.maxZ);
      const instances = bounds.instances;
      if (!instances || !visible) {
        bounds.mesh.visible = visible;
        continue;
      }
      const { boxes, matrices } = instances;
      const mesh = bounds.mesh as InstancedMesh;
      const total = matrices.length / 16;
      let count = 0;
      let changed = false;
      for (let index = 0; index < total; index += 1) {
        const box = index * 6;
        if (!shown(boxes[box], boxes[box + 1], boxes[box + 2], boxes[box + 3], boxes[box + 4], boxes[box + 5])) continue;
        if (instances.shown[count] !== index || count >= mesh.count) changed = true;
        instances.shown[count] = index;
        count += 1;
      }
      changed ||= count !== mesh.count;
      mesh.count = count;
      mesh.visible = count > 0;
      if (!changed || !count) continue;
      const array = mesh.instanceMatrix.array as Float32Array;
      for (let slot = 0; slot < count; slot += 1) {
        const from = instances.shown[slot] * 16;
        array.set(matrices.subarray(from, from + 16), slot * 16);
      }
      mesh.instanceMatrix.needsUpdate = true;
      // A building's prop's light follows its copies into their new slots.
      const light = mesh.userData.wowPropLight as PropLight | undefined;
      if (light) {
        for (const [name, source, size] of [['wowPropKind', light.kind, 2], ['wowPropDirect', light.direct, 4]] as const) {
          const attribute = mesh.geometry.getAttribute(name) as InstancedBufferAttribute;
          const target = attribute.array as Float32Array;
          for (let slot = 0; slot < count; slot += 1) {
            const from = instances.shown[slot] * size;
            target.set(source.subarray(from, from + size), slot * size);
          }
          attribute.needsUpdate = true;
        }
      }
      mesh.computeBoundingSphere();
    }
  }

  // The scene point (server coordinates) seen at canvas pixel (x, y) in
  // `view`: the nearest surface that is drawn there, skipping geometry the
  // fade or the reach cut leaves out. Null over empty space.
  pick(view: IsoView, width: number, height: number, x: number, y: number): Point3 | null {
    const root = this.shown;
    const fade = this.lastFade;
    if (!root || !fade) return null;
    applyIsoCamera(this.camera, view, width, height);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), this.camera);
    for (const hit of this.raycaster.intersectObject(root, true)) {
      let shown = true;
      for (let object: Object3D | null = hit.object; object; object = object.parent) shown &&= object.visible;
      if (!shown) continue;
      const point = threeToServer(hit.point);
      if (isDrawnAt(point, fade)) return point;
    }
    return null;
  }

  // The map's lights (null for none yet), how to light the scene, and
  // whether objects' lights (torches, braziers) are drawn.
  setLighting(lights: MapLights | null, lighting: SceneLighting, objectLights: boolean): void {
    this.mapLights = lights;
    this.lighting = lighting;
    this.objectLightsOn = objectLights;
  }

  // Sets the scene's lights for a point (the view's centre) now; returns a
  // key that changes when they do.
  private applyLighting(center: Point3): string {
    const time = this.mapLights ? this.pinnedTime ?? this.mapLights.timeOfDay ?? timeOfDay(new Date()) : 0;
    const colors: LightColors | null = this.lighting === 'client' && this.mapLights
      ? lightAt(this.mapLights, center, time) : null;
    if (colors) this.sunTowards.copy(serverToThree(sunDirection(time).map((value) => -value) as Point3));
    else this.sunTowards.copy(NEUTRAL_SUN_TOWARDS);
    // The scene's own lights only for the neutral look; the client's light
    // is drawn by the materials themselves.
    this.ambient.intensity = colors ? 0 : NEUTRAL_AMBIENT;
    this.sun.intensity = colors ? 0 : NEUTRAL_SUN;
    const on = colors ? 1 : 0;
    const ambient: Rgb = colors?.ambient ?? [0, 0, 0];
    const direct: Rgb = colors?.direct ?? [0, 0, 0];
    this.fadeData.set([...ambient, on], CLIENT_AMBIENT_OFFSET);
    this.fadeData.set([...direct, on], CLIENT_DIRECT_OFFSET);
    // Units (characters) take the zone's character ambient too, and outdoors
    // terrain's gains.
    this.unitSkyLight = { ambient: scaleAmbient(ambient, characterAmbientScale(this.mapLights?.ambientMultiplier)), direct };
    const [ur, ug, ub] = this.unitSkyLight.ambient;
    clientLight.ambient.set(ur * CLIENT_AMBIENT_GAIN, ug * CLIENT_AMBIENT_GAIN, ub * CLIENT_AMBIENT_GAIN, on);
    clientLight.direct.set(direct[0] * CLIENT_DIRECT_GAIN, direct[1] * CLIENT_DIRECT_GAIN, direct[2] * CLIENT_DIRECT_GAIN, on);
    const nearest = this.objectLightsOn && this.mapLights?.objects
      ? nearestObjectLights(this.mapLights.objects, center, OBJECT_LIGHT_COUNT, OBJECT_LIGHT_REACH) : null;
    // All shown while on (unused ones dark), all hidden while off: shaders
    // compile only when the setting changes.
    this.objectLights.forEach((light, index) => {
      light.visible = Boolean(nearest);
      const object = nearest?.[index];
      light.intensity = object ? object.intensity * OBJECT_LIGHT_INTENSITY : 0;
      if (!object) return;
      light.color.setHex(object.color);
      light.distance = object.end;
      light.position.copy(serverToThree(object.position));
    });
    const colorKey = colors
      ? [...colors.ambient, ...colors.direct, this.sunTowards.x, this.sunTowards.y].map((value) => value.toFixed(3)).join(',') : 'neutral';
    return `${colorKey}|${nearest ? nearest.map((light) => light.position.join(',')).join(';') : 'off'}`;
  }

  // Binds the fade block to a material whose shader has the party fade.
  private withFade<T extends Material>(material: T): T {
    (material as T & { uniformsGroups: UniformsGroup[] }).uniformsGroups = [this.fadeGroup];
    return material;
  }

  // Every texture in the scene by its material's name, for liquid frames.
  private async liquidFrames(gltf: GLTF): Promise<Map<string, Texture>> {
    const frames = new Map<string, Texture>();
    const materials = (await gltf.parser.getDependencies('material')) as MeshStandardMaterial[];
    for (const material of materials) {
      if (/^liquid-frame-\d+$/.test(material.name) && material.map) frames.set(material.name, material.map);
    }
    return frames;
  }

  // A liquid's material: its first frame, unlit; water and ocean see-through
  // in their map's colour, magma and slime solid (they glow).
  private liquidMaterial(liquid: LiquidExtras, frames: Map<string, Texture>):
    { material: MeshBasicMaterial; frames: Texture[] } | null {
    const textures = liquid.frames.map((name) => frames.get(name)).filter((texture): texture is Texture => Boolean(texture));
    if (!textures.length) return null;
    const see = liquid.kind === 'water' || liquid.kind === 'ocean';
    const material = new MeshBasicMaterial({
      map: textures[0], side: DoubleSide, forceSinglePass: true, transparent: see, opacity: see ? WATER_OPACITY : 1, depthWrite: !see,
    });
    if (see) {
      material.color.setRGB(...(liquid.color ?? WATER_COLOR), SRGBColorSpace);
      material.onBeforeCompile = (shader) => {
        injectPartyFade(shader);
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', WATER_FRAGMENT);
      };
      material.customProgramCacheKey = () => 'wow-water';
    } else {
      material.onBeforeCompile = injectPartyFade;
    }
    return { material: this.withFade(material), frames: textures };
  }

  // The map's ground textures as one array, and each tile's alpha atlas by
  // name; null for a scene without terrain.
  private async terrainTextures(gltf: GLTF): Promise<TerrainTextures | null> {
    const names = gltf.scene.children[0]?.userData.wowTerrainLayers as string[] | undefined;
    if (!names?.length) return null;
    const materials = (await gltf.parser.getDependencies('material')) as MeshStandardMaterial[];
    const byName = new Map(materials.map((material) => [material.name, material]));
    const layers = buildLayerArray(names.map((name) => (byName.get(name)?.map?.image as CanvasImageSource | undefined) ?? null));
    const alphas = new Map<string, Texture>();
    for (const material of materials) {
      if (material.name.startsWith('terrain-alpha-') && material.map) alphas.set(material.name, prepareAlphaAtlas(material.map));
    }
    return { layers, alphas };
  }

  private convertMaterial(mesh: Mesh, terrain: TerrainTextures | null): Material | Material[] {
    const vertexLit = Boolean(mesh.geometry.getAttribute('color'));
    const exteriorLit = vertexLit && isExteriorGroup(mesh);
    const building = vertexLit ? buildingBatch(mesh) : null;
    const floors = vertexLit ? null : propFloors(mesh);
    if (floors && !mesh.geometry.getAttribute('wowPropKind')) applyPropLight(mesh, floors);
    const propLightReady = Boolean(floors);
    const convert = (source: Material): Material => {
      // Terrain: its texture layers blended through its alpha atlas, lit by
      // the scene's lights (it has no baked lighting), with its vertex
      // shading as colour. Plain ground if its textures are missing.
      if (source.userData.wowTerrain) {
        const alpha = terrain?.alphas.get(source.userData.alpha as string);
        const shadingScale = mesh.geometry.getAttribute('color')?.normalized ? BYTE_SHADING_SCALE : 1;
        if (!terrain || !alpha) {
          const plain = new MeshLambertMaterial({
            color: new Color(TERRAIN_COLOR).multiplyScalar(vertexLit ? shadingScale : 1), vertexColors: vertexLit,
          });
          plain.onBeforeCompile = injectPartyFade;
          return this.withFade(plain);
        }
        return this.withFade(createTerrainMaterial({
          layers: terrain.layers, alpha, origin: source.userData.origin as [number, number],
          vertexShaded: vertexLit, shadingScale, partyFade: injectPartyFade,
        }));
      }
      // Instanced props get their own copy: three.js re-derives the shader
      // program whenever a material switches between instanced and plain.
      const blend = (source.userData.wowBlend ?? 'opaque') as WowBlend;
      // The map's own props are shaded by its light, a building's by the
      // floor under them as the client lights them (applyPropLight; scenes
      // exported before have no floors); glowing (blended) parts stay unlit.
      const opaque = !vertexLit && (blend === 'opaque' || blend === 'alphaKey');
      const propLit = opaque && propLightReady;
      const shaded = opaque && (propLit || isWorldProp(mesh));
      const light = building ? buildingBatchLight(building.batch, building.counts, building.unified, building.flags,
        (source.userData.wowMapObjFlags as number | undefined) ?? 0) : null;
      const key = `${source.uuid}|${vertexLit}|${exteriorLit}|${shaded}|${propLit}|${mesh instanceof InstancedMesh}`
        + (building ? `|${light}|${building.unified ? building.ambient : ''}` : '');
      const cached = this.materials.get(key);
      if (cached) return cached;
      const standard = source as MeshStandardMaterial;
      const MaterialType = shaded ? MeshLambertMaterial : MeshBasicMaterial;
      const material = new MaterialType({
        name: source.name,
        map: standard.map ?? null,
        color: (standard.color ?? new Color(1, 1, 1)).clone()
          .multiplyScalar(shaded ? PROP_BRIGHTNESS : exteriorLit || building ? 1 : vertexLit ? VERTEX_LIT_BRIGHTNESS : UNLIT_BRIGHTNESS),
        opacity: source.opacity,
        vertexColors: vertexLit,
        side: source.side === DoubleSide ? DoubleSide : FrontSide,
        // The client draws both faces in one pass; three.js's default two
        // passes for see-through double-sided materials also re-derive the
        // shader program on every draw.
        forceSinglePass: true,
        alphaTest: blend === 'alphaKey' ? 0.5 : 0,
        transparent: (blend !== 'opaque' && blend !== 'alphaKey') || source.opacity < 1,
        depthWrite: (blend === 'opaque' || blend === 'alphaKey') && source.opacity >= 1,
        blending: blend === 'add' ? AdditiveBlending : blend === 'mod' || blend === 'mod2x' ? MultiplyBlending : NormalBlending,
        premultipliedAlpha: blend === 'mod' || blend === 'mod2x',
      });
      material.onBeforeCompile = injectPartyFade;
      if (propLit) material.defines = { ...material.defines, WOW_PROP_LIGHT: '' };
      if (building && light) {
        material.defines = {
          ...material.defines,
          WOW_BUILDING: BUILDING_LIGHT[light],
          ...(building.unified ? { WOW_BUILDING_UNIFIED: '' } : {}),
          ...(exteriorLit ? { WOW_EXTERIOR_GROUP: '' } : {}),
        };
        material.userData.wowBuildingAmbient = new Color(building.ambient);
        material.onBeforeCompile = injectBuildingLight;
      }
      this.withFade(material);
      this.materials.set(key, material);
      return material;
    };
    return Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  }
}
