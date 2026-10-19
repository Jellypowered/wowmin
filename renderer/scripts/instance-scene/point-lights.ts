import { Vector4 } from 'three';

import { POINT_LIGHT_LINEAR, POINT_LIGHT_QUADRATIC } from '../utils/map-light';

// The props' point lights (torches, braziers) under the map's light: the
// nearest this many to the view's centre light every lit surface, as the
// client's nearest few light each model. A fixed number, so shaders compile
// once.
export const MAX_POINT_LIGHTS = 8;

// The lights now, for the unit models' shaders (the scene's materials read
// the same from the fade block): view-space positions, colours (times
// intensity, in the client's colour space), and how many are in use.
export const pointLights = {
  positions: Array.from({ length: MAX_POINT_LIGHTS }, () => new Vector4()),
  colors: Array.from({ length: MAX_POINT_LIGHTS }, () => new Vector4()),
  count: { value: 0 },
};

// The GLSL twin of litColor (map-light.ts): `wowLitSum(ambient, direct,
// facing, points)`, the light the client gives a lit surface, in its own
// colour space: the ambient, the direct light (each channel at most 1) by
// N.L, and any point lights, the sum at most 1.
export const LIT_SUM_FUNCTION = `
vec3 wowLitSum(vec3 ambient, vec3 direct, float facing, vec3 points) {
  return clamp(ambient + min(direct, vec3(1.0)) * clamp(facing, 0.0, 1.0) + points, 0.0, 1.0);
}
`;

// A GLSL function `name(position, normal)` (view space) giving the point
// lights' sum on a surface (pointLightShare in map-light.ts per light),
// read from the arrays and count given.
export function pointLightFunction(name: string, positions: string, colors: string, count: string): string {
  return `
vec3 ${name}(vec3 position, vec3 normal) {
  vec3 sum = vec3(0.0);
  for (int index = 0; index < ${MAX_POINT_LIGHTS}; index++) {
    if (float(index) >= ${count}) break;
    vec3 toLight = ${positions}[index].xyz - position;
    float distance = max(length(toLight), 1e-3);
    float falloff = ${POINT_LIGHT_LINEAR.toFixed(2)} * distance + ${POINT_LIGHT_QUADRATIC.toFixed(2)} * distance * distance;
    sum += ${colors}[index].rgb * max(dot(normal, toLight / distance), 0.0) / falloff;
  }
  return sum;
}
`;
}
