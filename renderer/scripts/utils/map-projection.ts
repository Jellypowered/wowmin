import type {
  InstanceCoordinateBounds,
  InstanceProjectionViewport,
  InstanceViewTransform,
  MinimapTileProjection,
} from './instance-watch';
import { applyInstanceViewTransform, projectInstancePosition, projectMinimapTilePosition } from './instance-watch';

export interface ScreenPoint {
  x: number;
  y: number;
}

// Single seam between world coordinates and canvas pixels for Instance Watch
// and Session Replay. Flat projections ignore height; a 3D camera will not.
export interface MapProjection {
  worldToScreen(x: number, y: number, z: number): ScreenPoint;
}

export type FlatProjectionSource =
  | { type: 'minimapTiles'; tiles: MinimapTileProjection }
  | { type: 'bounds'; bounds: InstanceCoordinateBounds };

const DEFAULT_GRID_SIZE = 64;
const DEFAULT_WORLD_UNITS_PER_TILE = 533.3333333333334;

export function resolveMinimapTileProjection(metadata: Partial<MinimapTileProjection>): MinimapTileProjection {
  const minTileX = metadata.minTileX ?? 0;
  const minTileY = metadata.minTileY ?? 0;
  return {
    gridSize: metadata.gridSize ?? DEFAULT_GRID_SIZE,
    worldUnitsPerTile: metadata.worldUnitsPerTile ?? DEFAULT_WORLD_UNITS_PER_TILE,
    minTileX,
    minTileY,
    maxTileX: metadata.maxTileX ?? minTileX,
    maxTileY: metadata.maxTileY ?? minTileY,
  };
}

export function createFlatProjection(
  source: FlatProjectionSource,
  viewport: InstanceProjectionViewport,
): MapProjection {
  return {
    worldToScreen(x, y) {
      const position = { position_x: x, position_y: y };
      const projected = source.type === 'minimapTiles'
        ? projectMinimapTilePosition(position, source.tiles, viewport.width, viewport.height)
        : projectInstancePosition(position, source.bounds, viewport.width, viewport.height);
      return { x: viewport.x + projected.x, y: viewport.y + projected.y };
    },
  };
}

export type Vec3 = [number, number, number];

export interface SceneBox extends InstanceCoordinateBounds {
  minZ: number;
  maxZ: number;
}

// True isometric elevation. Yaw is measured like orientation in server
// coordinates (0 = +X, north); the camera sits on that side of the target.
export const ISO_PITCH = Math.atan(1 / Math.SQRT2);
// Camera to the south-west, looking north-east, so north-east is screen-up.
export const DEFAULT_ISO_YAW = Math.PI * 0.75;

export interface IsoBasis {
  // Unit vectors in server coordinates (Z up).
  toCamera: Vec3;
  right: Vec3;
  up: Vec3;
}

export interface IsoView {
  projection: MapProjection;
  // Where the fitted scene sits before zoom/pan, in the same terms as the flat
  // view's base viewport, so the existing zoom and pan handlers apply as-is.
  baseViewport: InstanceProjectionViewport;
  basis: IsoBasis;
  // Server-coordinate point under the canvas centre.
  center: Vec3;
  pixelsPerUnit: number;
}

const dot = (left: Vec3, right: Vec3): number => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

export function getIsoBasis(yaw: number, pitch: number): IsoBasis {
  const toCamera: Vec3 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  const right: Vec3 = [-Math.sin(yaw), Math.cos(yaw), 0];
  const up: Vec3 = [
    toCamera[1] * right[2] - toCamera[2] * right[1],
    toCamera[2] * right[0] - toCamera[0] * right[2],
    toCamera[0] * right[1] - toCamera[1] * right[0],
  ];
  return { toCamera, right, up };
}

export function createIsoView(
  box: SceneBox,
  width: number,
  height: number,
  yaw: number,
  pitch: number,
  transform: InstanceViewTransform,
  margin = 0.04,
): IsoView {
  const basis = getIsoBasis(yaw, pitch);
  const origin: Vec3 = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2];
  const toPlane = (x: number, y: number, z: number) => {
    const offset: Vec3 = [x - origin[0], y - origin[1], z - origin[2]];
    return { u: dot(offset, basis.right), v: dot(offset, basis.up) };
  };

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) {
        const { u, v } = toPlane(x, y, z);
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
    }
  }
  const spanU = Math.max(maxU - minU, 1);
  const spanV = Math.max(maxV - minV, 1);
  const baseScale = Math.min(width * (1 - margin * 2) / spanU, height * (1 - margin * 2) / spanV);
  const baseViewport = {
    x: (width - spanU * baseScale) / 2,
    y: (height - spanV * baseScale) / 2,
    width: spanU * baseScale,
    height: spanV * baseScale,
  };
  const viewport = applyInstanceViewTransform(baseViewport, transform);
  const scale = viewport.width / spanU;

  const centerU = minU + (width / 2 - viewport.x) / scale;
  const centerV = maxV - (height / 2 - viewport.y) / scale;
  return {
    projection: {
      worldToScreen(x, y, z) {
        const { u, v } = toPlane(x, y, z);
        return { x: viewport.x + (u - minU) * scale, y: viewport.y + (maxV - v) * scale };
      },
    },
    baseViewport,
    basis,
    center: [
      origin[0] + centerU * basis.right[0] + centerV * basis.up[0],
      origin[1] + centerU * basis.right[1] + centerV * basis.up[1],
      origin[2] + centerU * basis.right[2] + centerV * basis.up[2],
    ],
    pixelsPerUnit: scale,
  };
}

// Pan that puts a world point back under the canvas centre, used to rotate
// about whatever the viewer is looking at.
export function getIsoPanForCenter(
  box: SceneBox,
  width: number,
  height: number,
  yaw: number,
  pitch: number,
  zoom: number,
  point: Vec3,
): { panX: number; panY: number } {
  const unpanned = createIsoView(box, width, height, yaw, pitch, { zoom, panX: 0, panY: 0 });
  const screen = unpanned.projection.worldToScreen(point[0], point[1], point[2]);
  return { panX: width / 2 - screen.x, panY: height / 2 - screen.y };
}

export interface HeightBand {
  minZ: number;
  maxZ: number;
}

// The height range the party occupies.
export function getHeightBand(heights: number[]): HeightBand | null {
  const finite = heights.filter(Number.isFinite);
  return finite.length ? { minZ: Math.min(...finite), maxZ: Math.max(...finite) } : null;
}

// A region the scene stays solid around, in server coordinates: one per party
// member (a point), or a single box around everyone for large groups.
export interface FadeVolume {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface FadeSettings {
  // Yards above or below a volume over which geometry fades to nothing.
  height: number;
  // Horizontal reach in yards: solid out to half of it, gone at all of it.
  // Null turns the horizontal fade off.
  horizontal: number | null;
}

// The scene shader holds this many volumes.
export const MAX_FADE_VOLUMES = 40;

const axisGap = (minA: number, maxA: number, minB: number, maxB: number): number =>
  Math.max(minB - maxA, minA - maxB, 0);

function mergeVolumes(a: FadeVolume, b: FadeVolume): FadeVolume {
  return {
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

// One volume per party member, then nearby members are merged into boxes.
// Two members are merged when they stand within half the horizontal reach of
// each other (inside each other's solid core) and half the height range, so
// clusters look the same with fewer volumes. Large groups keep merging their
// closest pair until they fit the shader's limit.
export function getFadeVolumes(positions: Vec3[], settings: FadeSettings): FadeVolume[] {
  const volumes: FadeVolume[] = positions
    .filter((position) => position.every(Number.isFinite))
    .map(([x, y, z]) => ({ minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z }));
  const mergeHorizontal = settings.horizontal ? settings.horizontal / 2 : Infinity;
  const mergeVertical = settings.height / 2;
  // 0 for overlapping volumes; 1 at the merge threshold.
  const separation = (a: FadeVolume, b: FadeVolume): number => Math.max(
    Math.hypot(axisGap(a.minX, a.maxX, b.minX, b.maxX), axisGap(a.minY, a.maxY, b.minY, b.maxY)) / mergeHorizontal,
    axisGap(a.minZ, a.maxZ, b.minZ, b.maxZ) / mergeVertical,
  );

  while (volumes.length > 1) {
    let best = { first: 0, second: 1, separation: Infinity };
    for (let first = 0; first < volumes.length; first += 1) {
      for (let second = first + 1; second < volumes.length; second += 1) {
        const current = separation(volumes[first], volumes[second]);
        if (current < best.separation) best = { first, second, separation: current };
      }
    }
    if (best.separation > 1 && volumes.length <= MAX_FADE_VOLUMES) break;
    volumes[best.first] = mergeVolumes(volumes[best.first], volumes[best.second]);
    volumes.splice(best.second, 1);
  }
  return volumes;
}

function getVolumeFade([x, y, z]: Vec3, volume: FadeVolume, settings: FadeSettings): number {
  const outsideZ = Math.max(volume.minZ - z, z - volume.maxZ, 0);
  const vertical = Math.max(0, 1 - outsideZ / settings.height);
  if (!settings.horizontal) return vertical;
  const outsideX = Math.max(volume.minX - x, x - volume.maxX, 0);
  const outsideY = Math.max(volume.minY - y, y - volume.maxY, 0);
  const core = settings.horizontal / 2;
  const beyondCore = (Math.hypot(outsideX, outsideY) - core) / (settings.horizontal - core);
  return vertical * (1 - Math.min(1, Math.max(0, beyondCore)));
}

// Visibility of scene geometry at a point: the most visible of the volumes'
// fades (so each party member gets their own bubble). The scene shader
// implements the same formula.
export function getSceneFade(point: Vec3, volumes: FadeVolume[], settings: FadeSettings): number {
  if (!volumes.length) return 1;
  return Math.max(...volumes.map((volume) => getVolumeFade(point, volume, settings)));
}

// Tilt limits for free orbiting: from a low oblique view to straight down.
export const ISO_PITCH_MIN = Math.PI / 18;
export const ISO_PITCH_MAX = Math.PI / 2;

export function clampIsoPitch(pitch: number): number {
  return Math.max(ISO_PITCH_MIN, Math.min(ISO_PITCH_MAX, pitch));
}

// Next quarter-turn yaw in `direction` (+1 or -1), snapping onto the standard
// angles (DEFAULT_ISO_YAW plus multiples of 90°) after free rotation.
export function getNextQuarterTurn(yaw: number, direction: 1 | -1): number {
  const quarter = Math.PI / 2;
  const steps = (yaw - DEFAULT_ISO_YAW) / quarter;
  const epsilon = 1e-6;
  const next = direction > 0 ? Math.floor(steps + epsilon) + 1 : Math.ceil(steps - epsilon) - 1;
  return DEFAULT_ISO_YAW + next * quarter;
}
