import { POINT_LIGHT_LINEAR, POINT_LIGHT_QUADRATIC } from '../utils/map-light';

// The props' point lights (torches, braziers) under the map's light: the
// nearest this many to the view's centre are in play (in the scene block,
// scene-block.ts), a fixed number, so shaders compile once. Each object then
// takes the nearest few of them, as the client picks its own: a model or a
// building this many, the ground fewer.
export const MAX_POINT_LIGHTS = 8;
export const MODEL_POINT_LIGHTS = 4;
export const TERRAIN_POINT_LIGHTS = 3;

// The GLSL twin of litColor (map-light.ts): `wowLitSum(ambient, direct,
// facing, points)`, the light the client gives a lit surface, in its own
// colour space: the ambient, the direct light (each channel at most 1) by
// N.L, and any point lights, the sum at most 1.
export const LIT_SUM_FUNCTION = `
vec3 wowLitSum(vec3 ambient, vec3 direct, float facing, vec3 points) {
  return clamp(ambient + min(direct, vec3(1.0)) * clamp(facing, 0.0, 1.0) + points, 0.0, 1.0);
}
`;

// Point lights, worked out per vertex as the client does, for materials
// that define WOW_POINT_LIGHTS (and WOW_POINT_LIMIT, how many an object
// takes): the `limit` lights in play nearest `origin`, each falling off as
// pointLightShare (map-light.ts) at the vertex. Needs the scene block. The
// sum reaches the fragment as vWowPoints (WOW_POINTS, zero without them).
export const POINT_LIGHT_VERTEX_DECLARATIONS = `
#ifdef WOW_POINT_LIGHTS
varying vec3 vWowPoints;
vec3 wowPointLight(vec3 position, vec3 normal, vec3 origin, int limit) {
  vec3 sum = vec3(0.0);
  int count = int(wowPointCountPacked.x);
  bool taken[${MAX_POINT_LIGHTS}];
  for (int index = 0; index < ${MAX_POINT_LIGHTS}; index++) taken[index] = false;
  for (int pick = 0; pick < ${MAX_POINT_LIGHTS}; pick++) {
    if (pick >= limit) break;
    int nearest = -1;
    float nearestDistance = 1e30;
    for (int index = 0; index < ${MAX_POINT_LIGHTS}; index++) {
      if (index >= count) break;
      vec3 away = wowPointPositionPacked[index].xyz - origin;
      float gap = dot(away, away);
      if (!taken[index] && gap < nearestDistance) {
        nearest = index;
        nearestDistance = gap;
      }
    }
    if (nearest < 0) break;
    taken[nearest] = true;
    vec3 toLight = wowPointPositionPacked[nearest].xyz - position;
    float span = max(length(toLight), 1e-3);
    float falloff = ${POINT_LIGHT_LINEAR.toFixed(2)} * span + ${POINT_LIGHT_QUADRATIC.toFixed(2)} * span * span;
    sum += wowPointColorPacked[nearest].rgb * max(dot(normal, toLight / span), 0.0) / falloff;
  }
  return sum;
}
#endif
`;

// After project_vertex: the object's lights picked by its origin (its copy's
// for instanced props) where WOW_POINT_FROM_ORIGIN, else by the vertex
// itself (the ground and buildings, whose own pieces the client picks by);
// `normal` is the view-space normal there.
export function pointLightVertex(normal: string): string {
  return `
#ifdef WOW_POINT_LIGHTS
#ifdef WOW_POINT_FROM_ORIGIN
vec4 wowPointOrigin = vec4(0.0, 0.0, 0.0, 1.0);
#ifdef USE_INSTANCING
wowPointOrigin = instanceMatrix * wowPointOrigin;
#endif
vWowPoints = wowPointLight(mvPosition.xyz, normalize(${normal}), (modelViewMatrix * wowPointOrigin).xyz, WOW_POINT_LIMIT);
#else
vWowPoints = wowPointLight(mvPosition.xyz, normalize(${normal}), mvPosition.xyz, WOW_POINT_LIMIT);
#endif
#endif
`;
}

export const POINT_LIGHT_FRAGMENT_DECLARATIONS = `
#ifdef WOW_POINT_LIGHTS
varying vec3 vWowPoints;
#define WOW_POINTS vWowPoints
#else
#define WOW_POINTS vec3(0.0)
#endif
`;

// The defines a material lit by point lights takes: the most an object
// takes, and whether it picks them by its origin.
export function pointLightDefines(limit: number, fromOrigin: boolean): Record<string, string> {
  return { WOW_POINT_LIGHTS: '', WOW_POINT_LIMIT: String(limit), ...(fromOrigin ? { WOW_POINT_FROM_ORIGIN: '' } : {}) };
}
