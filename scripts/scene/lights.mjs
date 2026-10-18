// A map's light, as the client lights the world: Light.dbc's lights for the
// map (a default one, and ones covering an area that fade out towards their
// edge), each with its direct (sun) and ambient colours through the day from
// LightIntBand; and the lights of the models on it (braziers', bonfires'
// and torches' point lights), placed in server coordinates. Buildings' own
// lights (MOLT) are left out: the client never makes them, as its tools
// baked them into the buildings' vertex colours.
// Served on demand as /assets/models/light/<mapId>.json.

import { findChunk, readChunks, readFloats } from './chunks.mjs';
import { readDbc } from './dbc.mjs';
import { FLOAT, readTrack, VEC3 } from './m2-effects.mjs';
import { dedupeByUniqueId, readAdtPlacements, readWdt, rotateByQuaternion } from './placement.mjs';
import {
  groupFileName, MOHD_AMBIENT, MOHD_FLAGS, MOPY_FLAG_TRANSITION, readDoodadDefinitions, readGroupHeader, selectDoodadIndices,
  WMO_GROUP_FLAG_EXTERIOR, WMO_GROUP_FLAG_EXTERIOR_LIT, WMO_ROOT_FLAG_UNIFIED,
} from './wmo.mjs';

// Light.dbc: map, position, falloff start and end (the inner and outer
// radius), and the clear-weather LightParams.
const LIGHT_MAP = 1;
const LIGHT_POSITION = 2;
const LIGHT_INNER = 5;
const LIGHT_OUTER = 6;
const LIGHT_PARAMS = 7;
// The light used when a map has none of its own (Eastern Kingdoms' default).
const FALLBACK_LIGHT = 1;
// Light.dbc positions and radii are in client units: 36 to the yard, from a
// corner of the world.
const LIGHT_UNITS = 36;
const WORLD_CORNER = 17066.666;
// LightIntBand: 18 bands per LightParams; each up to 16 keys of a time
// (half-minutes from midnight) and a BGRA colour.
const BANDS_PER_PARAMS = 18;
const BAND_DIRECT = 0;
const BAND_AMBIENT = 1;
const BAND_COUNT = 1;
const BAND_TIMES = 2;
const BAND_COLOURS = 18;
const MAX_KEYS = 16;

// Map.dbc: the map's directory under World\maps, and the time of day the
// map is always lit at (minutes from midnight; -1 for the clock). Only
// Ulduar and two arenas set one.
const MAP_DIRECTORY = 1;
const MAP_TIME_OF_DAY_OVERRIDE = 62;
// An M2's lights (header 0x108, 156 bytes each): type (1 point), position,
// then tracks; each track is a u16 interpolation, an i16 global sequence,
// and M2Arrays of per-sequence time and key arrays. The first key of the
// first sequence is used: diffuse colour and intensity. The client loads
// the attenuation tracks but never reads them (every point light fades by
// the same curve), so they are not exported.
const M2_LIGHTS = 0x108;
const M2_LIGHT_SIZE = 156;
const M2_LIGHT_POINT = 1;
const M2_LIGHT_POSITION = 4;
const M2_LIGHT_DIFFUSE_COLOR = 56;
const M2_LIGHT_DIFFUSE_INTENSITY = 76;
// AreaTable: parent area, and the ambient multiplier characters' light is
// scaled by.
const AREA_MAP = 1;
const AREA_PARENT = 2;
const AREA_AMBIENT_MULTIPLIER = 34;

// A light's position in server coordinates, from Light.dbc's.
export function lightPosition([x, y, z]) {
  return [WORLD_CORNER - z / LIGHT_UNITS, WORLD_CORNER - x / LIGHT_UNITS, y / LIGHT_UNITS];
}

// A band's keys: [time, 0xRRGGBB] pairs.
function bandKeys(band) {
  if (!band) return [];
  const count = Math.min(MAX_KEYS, band.uint(BAND_COUNT));
  return Array.from({ length: count }, (_, index) => [band.uint(BAND_TIMES + index), band.uint(BAND_COLOURS + index) & 0xffffff]);
}

// A point turned by a placement's quaternion, scaled, and moved to its
// position.
export function placePoint({ position, rotation, scale }, [px, py, pz]) {
  const [x, y, z] = rotateByQuaternion([px * scale, py * scale, pz * scale], rotation);
  return [position[0] + x, position[1] + y, position[2] + z];
}

const toColor = (rgb) => rgb.reduce((color, channel) => (color << 8) | Math.round(Math.min(1, Math.max(0, channel)) * 255), 0);

// An M2's point lights, in its own space.
export function readM2Lights(buffer) {
  if (!buffer || buffer.length < M2_LIGHTS + 8) return [];
  const count = buffer.readUInt32LE(M2_LIGHTS);
  const offset = buffer.readUInt32LE(M2_LIGHTS + 4);
  // The track's first key (its first sequence's), or null.
  const firstKey = (track, type) => {
    const values = readTrack(buffer, track, type).sequences[0]?.values ?? [];
    return values.length ? values.slice(0, type.components ?? 1) : null;
  };
  const lights = [];
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * M2_LIGHT_SIZE;
    if (at + M2_LIGHT_SIZE > buffer.length || buffer.readUInt16LE(at) !== M2_LIGHT_POINT) continue;
    const color = firstKey(at + M2_LIGHT_DIFFUSE_COLOR, VEC3);
    const intensity = firstKey(at + M2_LIGHT_DIFFUSE_INTENSITY, FLOAT)?.[0] ?? 0;
    if (!color || intensity <= 0 || color.every((channel) => channel <= 0)) continue;
    lights.push({ position: readFloats(buffer, at + M2_LIGHT_POSITION, 3), color: toColor(color), intensity });
  }
  return lights;
}

// The buildings and loose props a map places.
function mapPlacements(readFile, directory) {
  const mapPath = `World\\maps\\${directory}\\${directory}`;
  const wdtBuffer = readFile(`${mapPath}.wdt`);
  if (!wdtBuffer) return { wmos: [], doodads: [] };
  const wdt = readWdt(wdtBuffer);
  if (wdt.wmoOnly) return { wmos: wdt.wmo ? [wdt.wmo] : [], doodads: [] };
  const tiles = wdt.tiles.map(({ x, y }) => readFile(`${mapPath}_${x}_${y}.adt`)).filter(Boolean).map(readAdtPlacements);
  return {
    wmos: dedupeByUniqueId(tiles.flatMap((tile) => tile.wmos)),
    doodads: dedupeByUniqueId(tiles.flatMap((tile) => tile.doodads)),
  };
}

// A group's transition faces (from its header, readGroupHeader), by render
// batch, in the order the scene's primitives are: each batch's triangles
// (counted from its first index) that have the transition flag, or null for
// none. Empty when the group has none.
export function transitionTriangles({ polyFlags, renderBatches }) {
  if (!polyFlags) return [];
  const triangleCount = polyFlags.length / 2;
  const batches = [];
  let any = false;
  for (const { first, count } of renderBatches) {
    const triangles = [];
    for (let triangle = 0; triangle < count / 3 && first / 3 + triangle < triangleCount; triangle += 1) {
      if (polyFlags[(first / 3 + triangle) * 2] & MOPY_FLAG_TRANSITION) triangles.push(triangle);
    }
    any ||= triangles.length > 0;
    batches.push(triangles.length ? triangles : null);
  }
  return any ? batches : [];
}

// What the renderer needs to light units in a map's interior WMO groups as
// the client does, by group ID (the stream's wmoGroupId): `ambient`
// (0xRRGGBB), the building's ambient the client adds to the floor colour;
// `outdoor`, a group lit by the outdoor light although not exterior;
// `transitions`, its transition faces (transitionTriangles). Groups with
// none of these are left out.
export function interiorGroups(readFile, wmoNames) {
  const interiors = {};
  for (const name of new Set(wmoNames)) {
    const rootBuffer = readFile(name);
    const mohd = rootBuffer && findChunk(readChunks(rootBuffer), 'MOHD');
    if (!mohd) continue;
    const groupCount = mohd.readUInt32LE(4);
    const ambient = mohd.readUInt16LE(MOHD_FLAGS) & WMO_ROOT_FLAG_UNIFIED ? mohd.readUInt32LE(MOHD_AMBIENT) & 0xffffff : 0;
    for (let index = 0; index < groupCount; index += 1) {
      const groupBuffer = readFile(groupFileName(name, index));
      if (!groupBuffer) continue;
      const header = readGroupHeader(groupBuffer);
      const { flags, groupId } = header;
      if (flags & WMO_GROUP_FLAG_EXTERIOR) continue;
      const transitions = transitionTriangles(header);
      const entry = {
        ...(ambient ? { ambient } : {}),
        ...(flags & WMO_GROUP_FLAG_EXTERIOR_LIT ? { outdoor: true } : {}),
        ...(transitions.length ? { transitions } : {}),
      };
      if (Object.keys(entry).length) interiors[groupId] = entry;
    }
  }
  return interiors;
}

// The lights of the props on a map, in server coordinates: its buildings'
// doodad sets' models' and its loose props'.
export function objectLights(readFile, { wmos, doodads }) {
  const m2Lights = new Map();
  const modelLights = (name) => {
    if (!m2Lights.has(name)) m2Lights.set(name, readM2Lights(readFile(name)));
    return m2Lights.get(name);
  };
  const placed = [];
  const add = (lights, ...placements) => {
    for (const light of lights) {
      placed.push({ ...light, position: placements.reduceRight((point, placement) => placePoint(placement, point), light.position) });
    }
  };
  for (const wmo of wmos) {
    const rootBuffer = readFile(wmo.name);
    if (!rootBuffer) continue;
    const { sets, definitions } = readDoodadDefinitions(readChunks(rootBuffer));
    for (const index of selectDoodadIndices(sets, wmo.doodadSet)) {
      const definition = definitions[index];
      if (definition) add(modelLights(definition.name), wmo, definition);
    }
  }
  for (const doodad of doodads) add(modelLights(doodad.name), doodad);
  return placed.map(({ position, color, intensity }) => ({
    position: position.map((value) => Math.round(value * 100) / 100), color, intensity,
  }));
}

// The ambient multiplier of a map's zone: its top-level area's (the one
// with no parent, the lowest ID if several), 0 if none. The client takes
// the player's own area, falling back to the parent's unless the area has
// its own flag set, so in a dungeon it is the zone's.
export function zoneAmbientMultiplier(areas, mapId) {
  let zone = null;
  for (const record of areas.records()) {
    if (record.uint(AREA_MAP) !== mapId || record.uint(AREA_PARENT) !== 0) continue;
    if (!zone || record.uint(0) < zone.uint(0)) zone = record;
  }
  return zone ? Math.round(zone.float(AREA_AMBIENT_MULTIPLIER) * 1000) / 1000 : 0;
}

// The map's lights, with their direct and ambient keys: `defaultLight` set on
// the one that covers the whole map (at the origin, no radius), else on the
// fallback light; and its objects' lights. Positions are in server
// coordinates and distances in yards.
export function mapLights(readFile, mapId) {
  const table = (name) => {
    const buffer = readFile(`DBFilesClient\\${name}.dbc`);
    return buffer ? readDbc(buffer) : null;
  };
  const lights = table('Light');
  const bands = table('LightIntBand')?.byId();
  if (!lights || !bands) return null;
  const describe = (record, defaultLight) => {
    const params = record.uint(LIGHT_PARAMS);
    const band = (index) => bands.get(params * BANDS_PER_PARAMS - (BANDS_PER_PARAMS - 1) + index);
    const position = [0, 1, 2].map((axis) => record.float(LIGHT_POSITION + axis));
    return {
      id: record.uint(0),
      defaultLight,
      position: defaultLight ? null : lightPosition(position),
      inner: record.float(LIGHT_INNER) / LIGHT_UNITS,
      outer: record.float(LIGHT_OUTER) / LIGHT_UNITS,
      direct: bandKeys(band(BAND_DIRECT)),
      ambient: bandKeys(band(BAND_AMBIENT)),
    };
  };
  const records = [...lights.records()];
  const own = records.filter((record) => record.uint(LIGHT_MAP) === mapId);
  const isDefault = (record) => [0, 1, 2].every((axis) => record.float(LIGHT_POSITION + axis) === 0);
  const described = own.map((record) => describe(record, isDefault(record)));
  if (!described.some((light) => light.defaultLight)) {
    const fallback = records.find((record) => record.uint(0) === FALLBACK_LIGHT);
    if (fallback) described.push(describe(fallback, true));
  }
  const map = table('Map')?.byId().get(mapId);
  const directory = map?.string(MAP_DIRECTORY);
  // The objects' and the interiors' passes read the same buildings once.
  const buildings = new Map();
  const readOnce = (name) => {
    if (!/\.wmo$/i.test(name)) return readFile(name);
    if (!buildings.has(name)) buildings.set(name, readFile(name));
    return buildings.get(name);
  };
  const placements = directory ? mapPlacements(readOnce, directory) : { wmos: [], doodads: [] };
  const objects = objectLights(readOnce, placements);
  const interiors = interiorGroups(readOnce, placements.wmos.map((wmo) => wmo.name));
  const areas = table('AreaTable');
  const ambientMultiplier = areas ? zoneAmbientMultiplier(areas, mapId) : 0;
  const fixedTime = map ? map.int(MAP_TIME_OF_DAY_OVERRIDE) : -1;
  return described.length
    ? {
      mapId, lights: described, objects, interiors,
      ...(ambientMultiplier > 0 ? { ambientMultiplier } : {}),
      ...(fixedTime >= 0 ? { timeOfDay: fixedTime * 2 } : {}),
    }
    : null;
}
