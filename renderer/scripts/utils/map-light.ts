// A map's light at a point and a time of day, as the client blends it: the
// map's default light, with each area light mixed over it in turn, in full
// inside its inner radius and fading out to its outer one. Pure, so it can
// be tested without three.js. The lights come from /assets/models/light/<mapId>.json
// (scripts/scene/lights.mjs).

import type { Point3 } from './spell-events';

// Keys of a colour through the day: [time in half-minutes from midnight,
// 0xRRGGBB].
export type LightKeys = Array<[number, number]>;

export interface MapLight {
  id: number;
  defaultLight: boolean;
  // Server coordinates; null for the default light.
  position: Point3 | null;
  // Yards.
  inner: number;
  outer: number;
  direct: LightKeys;
  ambient: LightKeys;
}

// A prop's point light (a torch's, a brazier's): server coordinates, its
// colour (0xRRGGBB) and intensity, which it shines by together.
export interface ObjectLight {
  position: Point3;
  color: number;
  intensity: number;
}

// An interior WMO group's part in lighting units on its floor: the
// building's ambient (0xRRGGBB) the client adds to the floor colour,
// whether the group is lit by the outdoor light instead, and its transition
// faces (doorways, cave mouths): by render batch, the batch's triangles
// that blend towards the outdoor light, or null.
export interface InteriorGroup {
  ambient?: number;
  outdoor?: boolean;
  transitions?: Array<number[] | null>;
}

export interface MapLights {
  mapId: number;
  lights: MapLight[];
  objects?: ObjectLight[];
  // By WMO group ID; groups with nothing to say are left out.
  interiors?: Record<number, InteriorGroup>;
  // The map's zone's ambient multiplier for characters (AreaTable), if set.
  ambientMultiplier?: number;
  // The time of day the map is always lit at (half-minutes), if the client
  // fixes it (Ulduar, two arenas); else the clock's.
  timeOfDay?: number;
}

export type Rgb = [number, number, number];

// The direct (sun) and ambient colours at a point, 0 to 1 (sRGB).
export interface LightColors {
  direct: Rgb;
  ambient: Rgb;
}

export const HALF_MINUTES_PER_DAY = 2880;

// The time of day in the client's units (half-minutes from midnight).
export function timeOfDay(date: Date): number {
  return (date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60) * 2;
}

const toRgb = (color: number): Rgb => [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];

// A band's colour at a time: between the keys either side, wrapping past
// midnight; the one colour of a single key; black with none.
export function keyColor(keys: LightKeys, time: number): Rgb {
  if (!keys.length) return [0, 0, 0];
  if (keys.length === 1) return toRgb(keys[0][1]);
  const t = ((time % HALF_MINUTES_PER_DAY) + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY;
  let next = keys.findIndex(([at]) => at > t);
  if (next < 0) next = 0;
  const previous = (next - 1 + keys.length) % keys.length;
  const [fromAt, fromColor] = keys[previous];
  const [toAt, toColor] = keys[next];
  const span = (toAt - fromAt + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY || HALF_MINUTES_PER_DAY;
  const along = ((t - fromAt + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY) / span;
  const from = toRgb(fromColor);
  const to = toRgb(toColor);
  return [0, 1, 2].map((channel) => from[channel] + (to[channel] - from[channel]) * along) as Rgb;
}

// How much an area light counts at a point: 1 inside its inner radius,
// falling to 0 at its outer one.
export function lightWeight(light: MapLight, point: Point3): number {
  if (!light.position) return 0;
  const distance = Math.hypot(point[0] - light.position[0], point[1] - light.position[1], point[2] - light.position[2]);
  if (distance <= light.inner) return 1;
  if (distance >= light.outer || light.outer <= light.inner) return 0;
  return 1 - (distance - light.inner) / (light.outer - light.inner);
}

// The `count` object lights nearest a point, as the client picks a model's
// lights: by distance alone, with no range.
export function nearestObjectLights(objects: readonly ObjectLight[], point: Point3, count: number): ObjectLight[] {
  return objects
    .map((light) => ({ light, distance: Math.hypot(light.position[0] - point[0], light.position[1] - point[1], light.position[2] - point[2]) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, count)
    .map(({ light }) => light);
}

// The map's light at a point and time, as the client mixes it: from the
// default light's colours, each area light that reaches the point mixed over
// them by its weight, the farthest first.
export function lightAt(map: MapLights, point: Point3, time: number): LightColors {
  const fallback = map.lights.find((light) => light.defaultLight);
  const direct = fallback ? keyColor(fallback.direct, time) : [0, 0, 0] as Rgb;
  const ambient = fallback ? keyColor(fallback.ambient, time) : [0, 0, 0] as Rgb;
  const reaching = map.lights.filter((light) => !light.defaultLight && light.position)
    .map((light) => ({ light, weight: lightWeight(light, point), distance: Math.hypot(
      point[0] - light.position![0], point[1] - light.position![1], point[2] - light.position![2]) }))
    .filter(({ weight }) => weight > 0)
    .sort((left, right) => right.distance - left.distance);
  for (const { light, weight } of reaching) {
    const d = keyColor(light.direct, time);
    const a = keyColor(light.ambient, time);
    for (let channel = 0; channel < 3; channel += 1) {
      direct[channel] += (d[channel] - direct[channel]) * weight;
      ambient[channel] += (a[channel] - ambient[channel]) * weight;
    }
  }
  return { direct, ambient };
}

// Every point light fades with distance (yards) by the same curve, whatever
// its model asks: 1 / (0.7 d + 0.03 d^2), times how squarely it shines on
// the surface (`facing`, N.L). Its colour times this joins the lit sum.
export const POINT_LIGHT_LINEAR = 0.7;
export const POINT_LIGHT_QUADRATIC = 0.03;

export function pointLightShare(distance: number, facing: number): number {
  return Math.max(0, facing) / (POINT_LIGHT_LINEAR * distance + POINT_LIGHT_QUADRATIC * distance * distance);
}

// The light the client gives a lit surface (0 to 1, in its own colour
// space): the ambient, plus the direct light (each channel at most 1) by how
// squarely the surface faces it (`facing`, N.L), the sum at most 1. Point
// lights join the sum before the cap.
export function litColor({ direct, ambient }: LightColors, facing: number): Rgb {
  const share = Math.min(1, Math.max(0, facing));
  return [0, 1, 2].map((channel) =>
    Math.min(1, Math.max(0, ambient[channel] + Math.min(1, direct[channel]) * share))) as Rgb;
}

// The way the sun's light travels at a time (server coordinates, unit
// length), as the client turns its sky's light through the day: from a
// fixed bearing, 225 degrees round from +x, its angle from straight up 127
// degrees at midnight and noon and 110 at six, linear between. So the light is highest (37 degrees up) at noon and
// midnight and lowest (20 degrees) at six in the morning and evening.
export const SUN_BEARING = (225 * Math.PI) / 180;
const SUN_POLAR_HIGH = (127 * Math.PI) / 180;
const SUN_POLAR_LOW = (110 * Math.PI) / 180;

export function sunDirection(time: number): Point3 {
  const day = ((time % HALF_MINUTES_PER_DAY) + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY / HALF_MINUTES_PER_DAY;
  // 0 at midnight and noon, 1 at six.
  const towardsSix = 1 - Math.abs(((day * 4) % 2) - 1);
  const polar = SUN_POLAR_HIGH + (SUN_POLAR_LOW - SUN_POLAR_HIGH) * towardsSix;
  return [Math.cos(SUN_BEARING) * Math.sin(polar), Math.sin(SUN_BEARING) * Math.sin(polar), Math.cos(polar)];
}

// Indoors the client lights a unit by the building's baked light on the floor
// under it, not by the map's sun and sky (a ray from 1.5 yards above the
// unit down into its WMO group, the floor's vertex colour at the hit; its
// direct light that colour brightened, hue kept, until its brightest channel
// is at least 168/255, its ambient the colour dimmed until its brightest
// channel is at most 96/255), shining from a fixed direction.
export const INDOOR_DIRECT_FLOOR = 168 / 255;
export const INDOOR_AMBIENT_CEILING = 96 / 255;
// The way indoor light travels (server coordinates): mostly down.
export const INDOOR_LIGHT_DIRECTION: Point3 = [-0.3082, -0.3082, -0.9];

// The colour the client lights a unit indoors by, from the floor's vertex
// colour under it: doubled, plus the building's
// ambient if it adds one, each channel at most 1.
export function floorLight(vertex: Rgb, ambient = 0): Rgb {
  const added = toRgb(ambient);
  return [0, 1, 2].map((channel) => Math.min(1, vertex[channel] * 2 + added[channel])) as Rgb;
}

// Characters' ambient is scaled by 1 + 2 x the zone's multiplier, each
// channel at most 1 (the client's characterAmbient setting).
export function characterAmbientScale(multiplier = 0): number {
  return 1 + 2 * multiplier;
}

export function scaleAmbient(ambient: Rgb, scale: number): Rgb {
  return ambient.map((value) => Math.min(1, value * scale)) as Rgb;
}

// On a transition face the client mixes a unit's indoor light towards the
// outdoor light by the floor colour's alpha; its light direction too, in
// the unit's shader.
export function blendLight(indoor: LightColors, outdoor: LightColors, share: number): LightColors {
  const mix = (from: Rgb, to: Rgb): Rgb => [0, 1, 2].map((channel) => from[channel] + (to[channel] - from[channel]) * share) as Rgb;
  return { direct: mix(indoor.direct, outdoor.direct), ambient: mix(indoor.ambient, outdoor.ambient) };
}

// How strongly a unit takes its direct light: outdoors the client aims at
// 2.5 (in effect 1, as the scale never passes 1) or 0.5 where the ground's
// baked shadow lies under it; indoors 1, or 1 + 1.5 x the floor's alpha on
// a transition face.
export const DIRECT_SCALE_LIT = 2.5;
export const DIRECT_SCALE_SHADOWED = 0.5;
export const DIRECT_SCALE_INDOORS = 1;
export const transitionDirectScale = (share: number): number => 1 + 1.5 * share;

// A unit's light eases towards where it should be rather than jumping: its
// ambient by up to this much a second on each channel (2 x 255 in the
// client's bytes), its direct scale by this much, never above 1.
export const AMBIENT_EASE_PER_SECOND = 2;
export const DIRECT_SCALE_EASE_PER_SECOND = 10 / 3;

export interface EasedLight {
  ambient: Rgb;
  directScale: number;
}

const toward = (from: number, to: number, step: number): number => (from < to ? Math.min(to, from + step) : Math.max(to, from - step));

export function easeLight(current: EasedLight, target: EasedLight, seconds: number): EasedLight {
  const step = AMBIENT_EASE_PER_SECOND * seconds;
  return {
    ambient: current.ambient.map((value, channel) => toward(value, target.ambient[channel], step)) as Rgb,
    directScale: Math.min(1, toward(current.directScale, target.directScale, DIRECT_SCALE_EASE_PER_SECOND * seconds)),
  };
}

export function indoorLight(floor: Rgb): LightColors {
  const brightest = Math.max(floor[0], floor[1], floor[2]) || 1 / 255;
  const scale = (factor: number): Rgb => [floor[0] * factor, floor[1] * factor, floor[2] * factor];
  return {
    direct: brightest < INDOOR_DIRECT_FLOOR ? scale(INDOOR_DIRECT_FLOOR / brightest) : [...floor],
    ambient: brightest > INDOOR_AMBIENT_CEILING ? scale(INDOOR_AMBIENT_CEILING / brightest) : [...floor],
  };
}

// How the client lights a building's render batch, on its older render
// path or its newer "unified" one (header flag 0x2): 'own' by the batch's own vertex colours (the newer path adds
// the building's ambient to them), 'lit' by the map's light on them,
// 'transition' a mix of the two by the vertex alpha, 'unlit' by the vertex
// colours alone. A group's batches are its transition ones, then its
// interior ones, then its exterior ones.
export type BuildingBatchLight = 'own' | 'lit' | 'transition' | 'unlit';

export const WMO_GROUP_EXTERIOR_FLAGS = 0x8 | 0x40;
export const WMO_MATERIAL_UNLIT = 0x1;
export const WMO_MATERIAL_WINDOW = 0x20;

export function buildingBatchLight(
  batch: number, [transition, interior]: readonly number[], unified: boolean, groupFlags: number, materialFlags: number,
): BuildingBatchLight {
  if (batch < transition) return 'transition';
  if (!unified) return batch < transition + interior ? 'unlit' : 'lit';
  if (groupFlags & WMO_GROUP_EXTERIOR_FLAGS) return materialFlags & WMO_MATERIAL_UNLIT ? 'unlit' : 'lit';
  // Windows take the sky's second light, drawn here as its first.
  return materialFlags & WMO_MATERIAL_WINDOW ? 'lit' : 'own';
}
