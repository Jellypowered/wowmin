import {
  AdditiveBlending,
  Box3,
  type BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MultiplyBlending,
  NormalBlending,
  Object3D,
  OrthographicCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { type FadeSettings, type FadeVolume, type IsoView, MAX_FADE_VOLUMES } from '../utils/map-projection';
import { applyIsoCamera } from './iso-camera';

type WowBlend = 'opaque' | 'alphaKey' | 'alpha' | 'add' | 'mod' | 'mod2x';

// WMO interiors carry baked lighting in their vertex colours, which the client
// brightens; props have no baked light and are drawn slightly dimmed to sit in
// the same range. Tuned by eye against Azjol-Nerub.
const VERTEX_LIT_BRIGHTNESS = 2;
const UNLIT_BRIGHTNESS = 0.75;
const BACKGROUND = 0x08111d;

// Party fade, matching getSceneFade() in map-projection.ts: each volume keeps
// its surroundings solid, fading out over the height range above and below and
// (when on) over the outer half of the horizontal reach. Faded geometry is
// dithered with a 4x4 ordered pattern rather than alpha-blended, so solid
// walls keep writing depth and need no back-to-front sorting. Positions are in
// server coordinates; three.js is Y-up, so server (x, y, z) is (x, -z, y) here.
const FADE_VERTEX_DECLARATIONS = 'varying vec3 vWowPosition;\n';
const FADE_VERTEX = `
vec4 wowWorld = modelMatrix * vec4(transformed, 1.0);
vWowPosition = vec3(wowWorld.x, -wowWorld.z, wowWorld.y);
`;
const FADE_FRAGMENT_DECLARATIONS = `
#define WOW_MAX_VOLUMES ${MAX_FADE_VOLUMES}
uniform vec3 wowVolumeMin[WOW_MAX_VOLUMES];
uniform vec3 wowVolumeMax[WOW_MAX_VOLUMES];
uniform int wowVolumeCount;
uniform float wowHeightRange;
uniform float wowHorizontalRange;
varying vec3 vWowPosition;
float wowBayer4(vec2 position) {
  const float pattern[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  ivec2 cell = ivec2(mod(position, 4.0));
  return (pattern[cell.x + cell.y * 4] + 0.5) / 16.0;
}
float wowVolumeFade(int index) {
  vec3 outside = max(max(wowVolumeMin[index] - vWowPosition, vWowPosition - wowVolumeMax[index]), 0.0);
  float vertical = clamp(1.0 - outside.z / wowHeightRange, 0.0, 1.0);
  if (wowHorizontalRange <= 0.0) return vertical;
  float core = wowHorizontalRange * 0.5;
  return vertical * (1.0 - clamp((length(outside.xy) - core) / (wowHorizontalRange - core), 0.0, 1.0));
}
`;
const FADE_FRAGMENT = `
float wowFade = wowVolumeCount == 0 ? 1.0 : 0.0;
for (int index = 0; index < WOW_MAX_VOLUMES; index++) {
  if (index >= wowVolumeCount) break;
  wowFade = max(wowFade, wowVolumeFade(index));
}
if (wowFade <= 0.0 || wowFade < wowBayer4(gl_FragCoord.xy)) discard;
`;

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
}

export type SceneLoadState = 'loading' | 'ready' | 'failed';

// Draws an exported instance scene with an orthographic camera that matches
// the overlay's IsoView projection. Renders only when asked.
export class InstanceSceneView {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera();
  // Shared by every scene material.
  private readonly fadeUniforms = {
    wowVolumeMin: { value: Array.from({ length: MAX_FADE_VOLUMES }, () => new Vector3()) },
    wowVolumeMax: { value: Array.from({ length: MAX_FADE_VOLUMES }, () => new Vector3()) },
    wowVolumeCount: { value: 0 },
    wowHeightRange: { value: 1 },
    wowHorizontalRange: { value: 0 },
  };
  private readonly loader = new GLTFLoader();
  private readonly roots = new Map<string, Object3D>();
  // World bounds of each mesh, so wholly faded meshes are not drawn.
  private readonly meshBounds = new Map<Object3D, MeshBounds[]>();
  private readonly states = new Map<string, SceneLoadState>();
  private readonly materials = new Map<string, Material>();
  private shown: Object3D | null = null;
  private lost = false;
  // What the canvas currently shows, to skip redrawing an unchanged frame.
  private lastFrameKey = '';

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onChange: () => void) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(BACKGROUND);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
      this.lastFrameKey = '';
      this.onChange();
    });
  }

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

  state(url: string): SceneLoadState | undefined {
    return this.states.get(url);
  }

  load(url: string): void {
    if (this.states.has(url)) return;
    this.states.set(url, 'loading');
    this.loader.load(url, (gltf) => {
      const root = gltf.scene;
      root.traverse((object) => {
        if (object instanceof Mesh) object.material = this.convertMaterial(object);
      });
      root.updateMatrixWorld(true);
      const bounds: MeshBounds[] = [];
      const fitted = new WeakSet<BufferGeometry>();
      root.traverse((object) => {
        object.matrixAutoUpdate = false;
        if (!(object instanceof Mesh)) return;
        fitBoundsToIndices(object.geometry, fitted);
        const box = new Box3().copy(object.geometry.boundingBox!).applyMatrix4(object.matrixWorld);
        bounds.push({
          mesh: object,
          minX: box.min.x, maxX: box.max.x,
          minY: -box.max.z, maxY: -box.min.z,
          minZ: box.min.y, maxZ: box.max.y,
        });
      });
      this.meshBounds.set(root, bounds);
      this.roots.set(url, root);
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
    // Live positions redraw the overlay up to 30 times a second; the scene only
    // changes when the camera moves or the fade shifts by about a yard.
    const frameKey = [
      url, width, height, view.pixelsPerUnit.toFixed(4),
      ...view.center.map((value) => value.toFixed(3)),
      ...view.basis.toCamera.map((value) => value.toFixed(5)),
      fade.height, fade.horizontal ?? 0,
      ...active.flatMap((volume) => [volume.minX, volume.maxX, volume.minY, volume.maxY, volume.minZ, volume.maxZ]
        .map((value) => Math.round(value))),
    ].join('|');
    if (frameKey === this.lastFrameKey) return true;
    this.lastFrameKey = frameKey;
    if (this.shown !== root) {
      if (this.shown) this.scene.remove(this.shown);
      this.scene.add(root);
      this.shown = root;
    }
    active.forEach((volume, index) => {
      this.fadeUniforms.wowVolumeMin.value[index].set(volume.minX, volume.minY, volume.minZ);
      this.fadeUniforms.wowVolumeMax.value[index].set(volume.maxX, volume.maxY, volume.maxZ);
    });
    this.fadeUniforms.wowVolumeCount.value = active.length;
    this.fadeUniforms.wowHeightRange.value = fade.height;
    this.fadeUniforms.wowHorizontalRange.value = fade.horizontal ?? 0;
    const reach = fade.horizontal ?? Infinity;
    for (const bounds of this.meshBounds.get(root) ?? []) {
      bounds.mesh.visible = !active.length || active.some((volume) =>
        bounds.maxZ > volume.minZ - fade.height && bounds.minZ < volume.maxZ + fade.height
        && bounds.maxX > volume.minX - reach && bounds.minX < volume.maxX + reach
        && bounds.maxY > volume.minY - reach && bounds.minY < volume.maxY + reach);
    }
    this.renderer.setSize(width, height, false);
    applyIsoCamera(this.camera, view, width, height);
    this.renderer.render(this.scene, this.camera);
    // Exposed for diagnosing slow scenes from the browser's developer tools.
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.canvas.dataset.triangles = String(this.renderer.info.render.triangles);
    return true;
  }

  // One function for every material, so three.js shares the compiled program.
  private readonly injectPartyFade = (shader: WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, this.fadeUniforms);
    shader.vertexShader = FADE_VERTEX_DECLARATIONS + shader.vertexShader
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FADE_VERTEX}`);
    shader.fragmentShader = FADE_FRAGMENT_DECLARATIONS + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FADE_FRAGMENT}`);
  };

  private convertMaterial(mesh: Mesh): Material | Material[] {
    const vertexLit = Boolean(mesh.geometry.getAttribute('color'));
    const convert = (source: Material): Material => {
      const key = `${source.uuid}|${vertexLit}`;
      const cached = this.materials.get(key);
      if (cached) return cached;
      const standard = source as MeshStandardMaterial;
      const blend = (source.userData.wowBlend ?? 'opaque') as WowBlend;
      const material = new MeshBasicMaterial({
        name: source.name,
        map: standard.map ?? null,
        color: (standard.color ?? new Color(1, 1, 1)).clone()
          .multiplyScalar(vertexLit ? VERTEX_LIT_BRIGHTNESS : UNLIT_BRIGHTNESS),
        opacity: source.opacity,
        vertexColors: vertexLit,
        side: source.side === DoubleSide ? DoubleSide : FrontSide,
        alphaTest: blend === 'alphaKey' ? 0.5 : 0,
        transparent: (blend !== 'opaque' && blend !== 'alphaKey') || source.opacity < 1,
        depthWrite: (blend === 'opaque' || blend === 'alphaKey') && source.opacity >= 1,
        blending: blend === 'add' ? AdditiveBlending : blend === 'mod' || blend === 'mod2x' ? MultiplyBlending : NormalBlending,
        premultipliedAlpha: blend === 'mod' || blend === 'mod2x',
      });
      material.onBeforeCompile = this.injectPartyFade;
      this.materials.set(key, material);
      return material;
    };
    return Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  }
}
