import { Uniform, UniformsGroup } from 'three';

import { MAX_FADE_VOLUMES } from '../utils/map-projection';
import { MAX_POINT_LIGHTS } from './point-lights';

// The scene's shared uniform block: the party fade, floor areas, the
// client's light and the props' point lights, in one buffer every scene
// material (and every lit unit material) binds, uploaded once a frame
// (per-material uniform arrays were re-sent on every material switch).
// three.js r186 mislays arrays of vectors in a uniforms group, so the block
// is one Float32Array packed by hand in std140 order.
const SCENE_BLOCK = 'WowFade';
export const FADE_VOLUME_MAX_OFFSET = MAX_FADE_VOLUMES * 4;
export const FADE_REACH_MIN_OFFSET = FADE_VOLUME_MAX_OFFSET * 2;
export const FADE_REACH_MAX_OFFSET = FADE_REACH_MIN_OFFSET + 4;
export const FADE_PARAMS_OFFSET = FADE_REACH_MAX_OFFSET + 4;
// Floor areas (Starfall's reach): each a centre and radius, and a colour;
// then their count.
export const MAX_FLOOR_AREAS = 8;
export const FLOOR_AREA_OFFSET = FADE_PARAMS_OFFSET + 4;
export const FLOOR_AREA_COLOR_OFFSET = FLOOR_AREA_OFFSET + MAX_FLOOR_AREAS * 4;
export const FLOOR_AREA_COUNT_OFFSET = FLOOR_AREA_COLOR_OFFSET + MAX_FLOOR_AREAS * 4;
// The sky's light for lit scene materials: ambient and direct colours (w 1
// while on) and the view-space way to the sun.
export const CLIENT_AMBIENT_OFFSET = FLOOR_AREA_COUNT_OFFSET + 4;
export const CLIENT_DIRECT_OFFSET = CLIENT_AMBIENT_OFFSET + 4;
export const CLIENT_SUN_OFFSET = CLIENT_DIRECT_OFFSET + 4;
// The view-space way to the indoor light, for a building's props.
export const CLIENT_INDOOR_OFFSET = CLIENT_SUN_OFFSET + 4;
// The props' point lights (point-lights.ts): view-space positions, colours
// (times intensity), and how many are in use.
export const POINT_POSITION_OFFSET = CLIENT_INDOOR_OFFSET + 4;
export const POINT_COLOR_OFFSET = POINT_POSITION_OFFSET + MAX_POINT_LIGHTS * 4;
export const POINT_COUNT_OFFSET = POINT_COLOR_OFFSET + MAX_POINT_LIGHTS * 4;
// Water's highlight: the sun's colour on clouds (w 1 while it is drawn).
export const WATER_SPECULAR_OFFSET = POINT_COUNT_OFFSET + 4;
const SCENE_BLOCK_FLOATS = WATER_SPECULAR_OFFSET + 4;

export const sceneBlockData = new Float32Array(SCENE_BLOCK_FLOATS);
export const sceneBlock = new UniformsGroup().setName(SCENE_BLOCK).add(new Uniform(sceneBlockData));

export const SCENE_BLOCK_DECLARATION = `
#define WOW_MAX_VOLUMES ${MAX_FADE_VOLUMES}
layout(std140) uniform ${SCENE_BLOCK} {
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
  vec4 wowPointPositionPacked[${MAX_POINT_LIGHTS}];
  vec4 wowPointColorPacked[${MAX_POINT_LIGHTS}];
  vec4 wowPointCountPacked;
  vec4 wowWaterSpecularPacked;
};
`;
