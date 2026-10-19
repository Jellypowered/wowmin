import {
  DataTexture,
  DoubleSide,
  type MaterialParameters,
  MeshBasicMaterial,
  NoColorSpace,
  RGBAFormat,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import { RAMP_HEIGHT, RAMP_WIDTH, type WaterRamp, waterRampTexels } from '../utils/liquid-light';
import type { WaterColors } from '../utils/map-light';
import { pointLightDefines } from './point-lights';
import { prepareDataTexture } from './terrain-material';

// Water as the client draws it, from the scene's liquid meshes
// (scripts/scene/liquids.mjs): per vertex the ripple texture's uv (uv) and
// the depth ramp's (uv1: u 1 for interior WMO water, v by the depth byte).
// Lit per vertex by the sky's ambient and sun (interior water by a white
// light from straight above instead) and the nearest few point lights,
// times the vertex colour (white, or an interior group's material colour);
// that times the ramp's colour, plus the ripples, which are added, never
// mixed; the alpha the ramp's. All in the client's colour space, made
// linear at the end. Needs the scene block (scene-block.ts).

// Water takes this many point lights, as the client's water shaders do.
const WATER_POINT_LIGHTS = 3;
// The highlight's power, and what the ripples' alpha adds to it.
const SPECULAR_POWER = 6;
const SPECULAR_BASE = 0.25;

// The three ramps, rebuilt when the light's water changes (to the byte).
export class WaterRamps {
  readonly textures: Record<WaterRamp, DataTexture>;
  private readonly last = new Int16Array(16).fill(-1);

  constructor() {
    const ramp = (): DataTexture => prepareDataTexture(
      new DataTexture(new Uint8Array(RAMP_WIDTH * RAMP_HEIGHT * 4), RAMP_WIDTH, RAMP_HEIGHT, RGBAFormat, UnsignedByteType));
    this.textures = { river: ramp(), ocean: ramp(), wmo: ramp() };
  }

  update(water: WaterColors): void {
    let changed = false;
    let slot = 0;
    const note = (value: number): void => {
      const byte = Math.round(value * 255);
      if (this.last[slot] !== byte) changed = true;
      this.last[slot] = byte;
      slot += 1;
    };
    for (const color of [water.oceanShallow, water.oceanDeep, water.riverShallow, water.riverDeep]) color.forEach(note);
    water.alphas.forEach(note);
    if (!changed) return;
    for (const [name, texture] of Object.entries(this.textures) as Array<[WaterRamp, DataTexture]>) {
      waterRampTexels(name, water, texture.image.data as Uint8Array);
      texture.needsUpdate = true;
    }
  }
}

const VERTEX_DECLARATIONS = `
#ifndef USE_UV1
attribute vec2 uv1;
#endif
uniform vec4 wowLiquidColor;
varying vec4 vWowLiquidPrimary;
varying vec2 vWowRampUv;
#ifdef WOW_WATER_SPECULAR
varying vec3 vWowSpecular;
#endif
`;

// Liquid lies flat: its normal is the scene's up (the normal the party
// fade's point lights take, WOW_VERTEX_NORMAL).
const NORMAL_VERTEX = `
vec3 wowLiquidUp = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
`;

// After the party fade's vertex code, which has worked out the point
// lights (vWowPoints). The sum is not capped; the vertex colour is, as the
// client's is. Without the map's light, lit at 1.
const VERTEX = `
#ifdef WOW_INTERIOR_LIQUID
vec3 wowLit = vec3(1.0);
#else
vec3 wowLit = wowClientAmbientPacked.w > 0.5
  ? wowClientAmbientPacked.rgb + wowClientDirectPacked.rgb * clamp(dot(wowLiquidUp, wowClientSunPacked.xyz), 0.0, 1.0)
  : vec3(1.0);
#endif
#ifdef WOW_POINT_LIGHTS
wowLit += vWowPoints;
#endif
vWowLiquidPrimary = clamp(vec4(wowLit, 1.0) * wowLiquidColor, 0.0, 1.0);
vWowRampUv = uv1;
#ifdef WOW_WATER_SPECULAR
vec3 wowEye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-mvPosition.xyz);
vec3 wowHalf = normalize(wowEye + wowClientSunPacked.xyz);
vWowSpecular = clamp(pow(max(dot(wowLiquidUp, wowHalf), 0.0), ${SPECULAR_POWER.toFixed(1)}) * wowWaterSpecularPacked.rgb, 0.0, 1.0);
#endif
`;

const FRAGMENT_DECLARATIONS = `
uniform sampler2D wowWaterRamp;
varying vec4 vWowLiquidPrimary;
varying vec2 vWowRampUv;
#ifdef WOW_WATER_SPECULAR
varying vec3 vWowSpecular;
#endif
`;

const FRAGMENT = `
vec4 wowRipple = texture2D(map, vMapUv);
vec4 wowRamp = texture2D(wowWaterRamp, vWowRampUv);
vec3 wowWater = vWowLiquidPrimary.rgb * wowRamp.rgb + wowRipple.rgb;
#ifdef WOW_WATER_SPECULAR
wowWater += wowRipple.a * (vWowSpecular + ${SPECULAR_BASE.toFixed(2)});
#endif
diffuseColor = vec4(pow(clamp(wowWater, 0.0, 1.0), vec3(2.2)), vWowLiquidPrimary.a * wowRamp.a);
`;

// Magma and slime as the client draws them: unlit and solid, the sheet's
// colour times the vertex colour (white, or an interior group's material
// colour), the sheet scrolling by `scroll` (texture widths, set each
// frame). The product is taken in the client's colour space and made
// linear once, as water is.
const MAGMA_VERTEX_DECLARATIONS = `
uniform vec2 wowLiquidScroll;
`;

const MAGMA_FRAGMENT_DECLARATIONS = `
uniform vec4 wowLiquidColor;
`;

const MAGMA_FRAGMENT = `
diffuseColor = vec4(pow(clamp(texture2D(map, vMapUv).rgb * wowLiquidColor.rgb, 0.0, 1.0), vec3(2.2)), 1.0);
`;

type PartyFade = (shader: WebGLProgramParametersWithUniforms) => void;

// A liquid's material: its first frame (sampled as stored, see rawFrames)
// drawn from both sides, its vertex colour ([r, g, b, a], 0 to 1) as
// wowLiquidColor with `uniforms`, the party fade (which binds nothing; the
// caller binds the scene block), and the shader's own declarations, vertex
// code (`vertex(shader)`) and fragment colour.
function liquidMaterial({
  frame, color, partyFade, cacheKey, parameters = {}, defines = {}, uniforms = {},
  vertexDeclarations, vertex, fragmentDeclarations, fragment,
}: {
  frame: Texture;
  color: readonly number[] | null;
  partyFade: PartyFade;
  cacheKey: string;
  parameters?: MaterialParameters;
  defines?: Record<string, string>;
  uniforms?: Record<string, { value: unknown }>;
  vertexDeclarations: string;
  vertex: (shader: string) => string;
  fragmentDeclarations: string;
  fragment: string;
}): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ map: frame, side: DoubleSide, forceSinglePass: true, ...parameters });
  material.defines = defines;
  const [r, g, b, a] = color ?? [1, 1, 1, 1];
  const all = { ...uniforms, wowLiquidColor: { value: new Vector4(r, g, b, a) } };
  material.onBeforeCompile = (shader) => {
    partyFade(shader);
    Object.assign(shader.uniforms, all);
    shader.vertexShader = vertexDeclarations + vertex(shader.vertexShader);
    shader.fragmentShader = fragmentDeclarations + shader.fragmentShader.replace('#include <map_fragment>', fragment);
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

// A water type's material: its ramp, and interior WMO water lit by the
// white light from above.
export function createWaterMaterial({ frame, ramp, color, interior, specular, partyFade }: {
  frame: Texture;
  ramp: Texture;
  color: readonly number[] | null;
  interior: boolean;
  specular: boolean;
  partyFade: PartyFade;
}): MeshBasicMaterial {
  return liquidMaterial({
    frame, color, partyFade, cacheKey: 'wow-water',
    parameters: { transparent: true, depthWrite: false },
    defines: {
      ...pointLightDefines(WATER_POINT_LIGHTS, false),
      WOW_VERTEX_NORMAL: 'wowLiquidUp',
      ...(interior ? { WOW_INTERIOR_LIQUID: '' } : {}),
      ...(specular ? { WOW_WATER_SPECULAR: '' } : {}),
    },
    uniforms: { wowWaterRamp: { value: ramp } },
    vertexDeclarations: VERTEX_DECLARATIONS,
    vertex: (shader) => shader
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${NORMAL_VERTEX}`)
      .replace('#include <fog_vertex>', `${VERTEX}\n#include <fog_vertex>`),
    fragmentDeclarations: FRAGMENT_DECLARATIONS,
    fragment: FRAGMENT,
  });
}

// A magma or slime type's material, and the scroll its caller sets.
export function createMagmaMaterial({ frame, color, partyFade }: {
  frame: Texture;
  color: readonly number[] | null;
  partyFade: PartyFade;
}): { material: MeshBasicMaterial; scroll: Vector2 } {
  const scroll = new Vector2();
  const material = liquidMaterial({
    frame, color, partyFade, cacheKey: 'wow-magma',
    uniforms: { wowLiquidScroll: { value: scroll } },
    vertexDeclarations: MAGMA_VERTEX_DECLARATIONS,
    vertex: (shader) => shader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv += wowLiquidScroll;'),
    fragmentDeclarations: MAGMA_FRAGMENT_DECLARATIONS,
    fragment: MAGMA_FRAGMENT,
  });
  return { material, scroll };
}

// A liquid's frames are sampled as stored, in the client's colour space.
export function rawFrames(frames: Texture[]): Texture[] {
  for (const frame of frames) {
    if (frame.colorSpace === NoColorSpace) continue;
    frame.colorSpace = NoColorSpace;
    frame.needsUpdate = true;
  }
  return frames;
}
