import {
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  LinearFilter,
  MeshBasicMaterial,
  NoColorSpace,
  RGBAFormat,
  type Texture,
  UnsignedByteType,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import { RAMP_HEIGHT, RAMP_WIDTH, type WaterRamp, waterRampTexels } from '../utils/liquid-light';
import type { WaterColors } from '../utils/map-light';
import { pointLightDefines } from './point-lights';

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

// The three ramps, rebuilt when the light's water changes.
export class WaterRamps {
  readonly textures: Record<WaterRamp, DataTexture>;
  private key = '';

  constructor() {
    const ramp = (): DataTexture => {
      const texture = new DataTexture(new Uint8Array(RAMP_WIDTH * RAMP_HEIGHT * 4), RAMP_WIDTH, RAMP_HEIGHT, RGBAFormat, UnsignedByteType);
      texture.colorSpace = NoColorSpace;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      return texture;
    };
    this.textures = { river: ramp(), ocean: ramp(), wmo: ramp() };
  }

  update(water: WaterColors): void {
    const key = [water.oceanShallow, water.oceanDeep, water.riverShallow, water.riverDeep, water.alphas]
      .flat().map((value) => Math.round(value * 255)).join(',');
    if (key === this.key) return;
    this.key = key;
    for (const [name, texture] of Object.entries(this.textures) as Array<[WaterRamp, DataTexture]>) {
      (texture.image.data as Uint8Array).set(waterRampTexels(name, water));
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

// Liquid lies flat: its normal is the scene's up.
const NORMAL_VERTEX = `
vec3 transformedNormal = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
`;

// After the party fade's vertex code, which has worked out the point
// lights (vWowPoints). The sum is not capped; the vertex colour is, as the
// client's is. Without the map's light, lit at 1.
const VERTEX = `
#ifdef WOW_INTERIOR_LIQUID
vec3 wowLit = vec3(1.0);
#else
vec3 wowLit = wowClientAmbientPacked.w > 0.5
  ? wowClientAmbientPacked.rgb + wowClientDirectPacked.rgb * clamp(dot(transformedNormal, wowClientSunPacked.xyz), 0.0, 1.0)
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
vWowSpecular = clamp(pow(max(dot(transformedNormal, wowHalf), 0.0), ${SPECULAR_POWER.toFixed(1)}) * wowWaterSpecularPacked.rgb, 0.0, 1.0);
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

// A water type's material: its first ripple frame (sampled as stored, see
// rawFrames), its ramp, and its vertex colour ([r, g, b, a], 0 to 1);
// interior WMO water lit by the white light from above. `partyFade` adds
// the fade and binds nothing; the caller binds the scene block.
export function createWaterMaterial({
  frame, ramp, color, interior, specular, partyFade,
}: {
  frame: Texture;
  ramp: Texture;
  color: readonly number[] | null;
  interior: boolean;
  specular: boolean;
  partyFade: (shader: WebGLProgramParametersWithUniforms) => void;
}): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    map: frame, side: DoubleSide, forceSinglePass: true, transparent: true, depthWrite: false,
  });
  material.defines = {
    ...pointLightDefines(WATER_POINT_LIGHTS, false),
    ...(interior ? { WOW_INTERIOR_LIQUID: '' } : {}),
    ...(specular ? { WOW_WATER_SPECULAR: '' } : {}),
  };
  const [r, g, b, a] = color ?? [1, 1, 1, 1];
  const uniforms = { wowLiquidColor: { value: new Vector4(r, g, b, a) }, wowWaterRamp: { value: ramp } };
  material.onBeforeCompile = (shader) => {
    partyFade(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VERTEX_DECLARATIONS + shader.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${NORMAL_VERTEX}`)
      .replace('#include <fog_vertex>', `${VERTEX}\n#include <fog_vertex>`);
    shader.fragmentShader = FRAGMENT_DECLARATIONS + shader.fragmentShader
      .replace('#include <map_fragment>', FRAGMENT);
  };
  material.customProgramCacheKey = () => 'wow-water';
  return material;
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
