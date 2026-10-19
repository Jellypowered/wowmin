import {
  ClampToEdgeWrapping,
  Color,
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshLambertMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import { CHUNK_SIZE } from '../utils/terrain-shadow';
import { pointLightDefines, TERRAIN_POINT_LIGHTS } from './point-lights';

// The ground's material: each chunk blends up to four texture layers through
// its alpha maps, as the client does (layer 1 as the base, each later layer
// mixed over it by its alpha), darkened by the baked shadow, then shaded by
// the vertex colours (MCCV) and lit. Built by scripts/scene/terrain.mjs and
// export-scene.mjs: per vertex `_layers` (four layer indices into the map's
// texture array; 255, or -1 in older scenes, for none) and `_cell` (the
// chunk's row and column in the tile); per tile an alpha atlas (RGB: layers
// 2-4, A: light).

// Ground textures repeat 8 times across a chunk.
const TEXTURE_REPEAT = CHUNK_SIZE / 8;
const LAYER_TEXTURE_SIZE = 256;
// Under the neutral look's lights, a plain white diffuse is far too bright;
// this brings the ground to about the client's level. Tuned by eye; the
// client's light draws the ground at its own colour.
const GROUND_BRIGHTNESS = 0.75;
// The atlas's light in baked shadow (SHADOW_LIGHT in scripts/scene/
// terrain.mjs, out of 255), and how dark the client draws shadowed ground.
const SHADOW_LIGHT = 150 / 255;
const CLIENT_SHADOW = 0.7;
// Vertex shading stored as bytes (normalized, so 1.0 is 255) is centred on
// 127 (MCCV_ONE in scripts/scene/terrain.mjs); older scenes stored floats
// already centred on 1. The client doubles the bytes' value in its own
// colour space, so under its light the shading is made linear first.
export const BYTE_SHADING_SCALE = 255 / 127;
const CLIENT_BYTE_SHADING_SCALE = 2;

// Packs the map's ground textures into one texture array (resampled to one
// size), in the order of their layer indices.
export function buildLayerArray(images: Array<CanvasImageSource | null>): DataArrayTexture {
  const size = LAYER_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4 * Math.max(1, images.length));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  images.forEach((image, index) => {
    if (!image) return;
    context.clearRect(0, 0, size, size);
    context.drawImage(image, 0, 0, size, size);
    data.set(context.getImageData(0, 0, size, size).data, index * size * size * 4);
  });
  const array = new DataArrayTexture(data, size, size, Math.max(1, images.length));
  array.wrapS = RepeatWrapping;
  array.wrapT = RepeatWrapping;
  array.minFilter = LinearMipmapLinearFilter;
  array.magFilter = LinearFilter;
  array.generateMipmaps = true;
  array.colorSpace = SRGBColorSpace;
  array.needsUpdate = true;
  return array;
}

// A texture that holds data, not colour (a tile's alpha atlas, water's
// depth ramps): sampled as stored, clamped, linear, no mipmaps.
export function prepareDataTexture<T extends Texture>(texture: T): T {
  texture.colorSpace = NoColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const VERTEX_DECLARATIONS = `
attribute vec4 _layers;
attribute vec2 _cell;
varying vec4 vWowLayers;
varying vec2 vWowCell;
varying vec2 vWowServer;
`;

const VERTEX = `
vWowLayers = _layers;
vWowCell = _cell;
vWowServer = position.xy;
`;

const FRAGMENT_DECLARATIONS = `
precision highp sampler2DArray;
uniform sampler2DArray wowTerrainLayers;
uniform sampler2D wowTerrainAlpha;
uniform vec2 wowTileOrigin;
uniform float wowShadingScale;
uniform float wowClientShadingScale;
varying vec4 vWowLayers;
varying vec2 vWowCell;
varying vec2 vWowServer;
`;

// The vertex shading, as the neutral look scales it or as the client does.
const COLOR_FRAGMENT = `
#ifdef USE_COLOR
diffuseColor.rgb *= wowClientAmbientPacked.w > 0.5
  ? pow(vColor.rgb * wowClientShadingScale, vec3(2.2)) : vColor.rgb * wowShadingScale;
#endif
`;

const FRAGMENT = `
{
  vec2 repeatUv = vWowServer / ${TEXTURE_REPEAT.toFixed(6)};
  // Within the tile, in chunks: east (column) and south (row) of its corner.
  vec2 inTile = vec2(wowTileOrigin.y - vWowServer.y, wowTileOrigin.x - vWowServer.x) / ${CHUNK_SIZE.toFixed(6)};
  vec2 cell = vec2(vWowCell.y, vWowCell.x);
  // Stay inside this chunk's 64 x 64 cell, so neighbours never bleed in.
  vec2 inCell = clamp(inTile - cell, 0.5 / 64.0, 63.5 / 64.0);
  vec4 splat = texture2D(wowTerrainAlpha, (cell + inCell) / 16.0);
  vec4 layers = floor(vWowLayers + 0.5);
  bvec4 used = bvec4(layers.x >= 0.0 && layers.x < 254.5, layers.y >= 0.0 && layers.y < 254.5,
    layers.z >= 0.0 && layers.z < 254.5, layers.w >= 0.0 && layers.w < 254.5);
  vec3 ground = used.x ? texture(wowTerrainLayers, vec3(repeatUv, layers.x)).rgb : vec3(0.5);
  if (used.y) ground = mix(ground, texture(wowTerrainLayers, vec3(repeatUv, layers.y)).rgb, splat.r);
  if (used.z) ground = mix(ground, texture(wowTerrainLayers, vec3(repeatUv, layers.z)).rgb, splat.g);
  if (used.w) ground = mix(ground, texture(wowTerrainLayers, vec3(repeatUv, layers.w)).rgb, splat.b);
  // The baked shadow: the neutral look darkens by the atlas's light as it
  // is; the client's light takes 0.7 in shadow and 1 in light, in its own
  // colour space.
  float wowLit = clamp((splat.a - ${SHADOW_LIGHT.toFixed(6)}) / ${(1 - SHADOW_LIGHT).toFixed(6)}, 0.0, 1.0);
  diffuseColor.rgb *= ground * (wowClientAmbientPacked.w > 0.5
    ? vec3(pow(${CLIENT_SHADOW.toFixed(2)} + ${(1 - CLIENT_SHADOW).toFixed(2)} * wowLit, 2.2)) : vec3(splat.a));
}
`;

export function createTerrainMaterial({
  layers,
  alpha,
  origin,
  vertexShaded,
  shadingScale = 1,
  partyFade,
}: {
  layers: DataArrayTexture;
  alpha: Texture;
  origin: [number, number];
  vertexShaded: boolean;
  // Multiplies the vertex shading: BYTE_SHADING_SCALE for byte colours.
  shadingScale?: number;
  // Adds the party fade, and the client's light (whose block the shading
  // reads, as does WOW_NEUTRAL_SCALE).
  partyFade: (shader: WebGLProgramParametersWithUniforms) => void;
}): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color: new Color(1, 1, 1), vertexColors: vertexShaded });
  // The ground picks its point lights by each vertex, fewer than models.
  material.defines = { WOW_NEUTRAL_SCALE: GROUND_BRIGHTNESS.toFixed(2), ...pointLightDefines(TERRAIN_POINT_LIGHTS, false) };
  const uniforms = {
    wowTerrainLayers: { value: layers },
    wowTerrainAlpha: { value: alpha },
    wowTileOrigin: { value: new Vector2(origin[0], origin[1]) },
    wowShadingScale: { value: shadingScale },
    wowClientShadingScale: { value: shadingScale === BYTE_SHADING_SCALE ? CLIENT_BYTE_SHADING_SCALE : 1 },
  };
  material.onBeforeCompile = (shader) => {
    partyFade(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VERTEX_DECLARATIONS + shader.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX}`);
    shader.fragmentShader = FRAGMENT_DECLARATIONS + shader.fragmentShader
      .replace('#include <map_fragment>', FRAGMENT)
      .replace('#include <color_fragment>', COLOR_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'wow-terrain';
  return material;
}
