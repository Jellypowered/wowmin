const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

function loadModule(relativePath) {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} } };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const { createFlatProjection, resolveMinimapTileProjection } = loadModule('../renderer/scripts/utils/map-projection.ts');
const {
  applyInstanceViewTransform,
  projectInstancePosition,
  projectMinimapTilePosition,
} = loadModule('../renderer/scripts/utils/instance-watch.ts');

const baseViewport = { x: 40, y: 12, width: 800, height: 600 };
const zoomedViewport = applyInstanceViewTransform(baseViewport, { zoom: 2.5, panX: -130, panY: 75 });
const bounds = { minX: 862.5, maxX: 1627.08, minY: 895.83, maxY: 2041.67 };
const tiles = { gridSize: 64, worldUnitsPerTile: 533.3333333333334, minTileX: 30, minTileY: 28, maxTileX: 33, maxTileY: 31 };
const positions = [
  [1000, 1200, 345.2],
  [862.5, 2041.67, 0],
  [-250.75, 4100.1, -12],
];

test('bounds projection matches the existing instance helper plus viewport offset', () => {
  for (const viewport of [baseViewport, zoomedViewport]) {
    const projection = createFlatProjection({ type: 'bounds', bounds }, viewport);
    for (const [x, y, z] of positions) {
      const expected = projectInstancePosition({ position_x: x, position_y: y }, bounds, viewport.width, viewport.height);
      const actual = projection.worldToScreen(x, y, z);
      assert.equal(actual.x, viewport.x + expected.x);
      assert.equal(actual.y, viewport.y + expected.y);
    }
  }
});

test('minimap tile projection matches the existing tile helper plus viewport offset', () => {
  for (const viewport of [baseViewport, zoomedViewport]) {
    const projection = createFlatProjection({ type: 'minimapTiles', tiles }, viewport);
    for (const [x, y, z] of positions) {
      const expected = projectMinimapTilePosition({ position_x: x, position_y: y }, tiles, viewport.width, viewport.height);
      const actual = projection.worldToScreen(x, y, z);
      assert.equal(actual.x, viewport.x + expected.x);
      assert.equal(actual.y, viewport.y + expected.y);
    }
  }
});

test('flat projections ignore height', () => {
  const projection = createFlatProjection({ type: 'bounds', bounds }, baseViewport);
  assert.deepEqual(projection.worldToScreen(1000, 1200, -500), projection.worldToScreen(1000, 1200, 500));
});

test('resolves minimap tile metadata with the same defaults the renderer used inline', () => {
  assert.deepEqual({ ...resolveMinimapTileProjection({}) }, {
    gridSize: 64,
    worldUnitsPerTile: 533.3333333333334,
    minTileX: 0,
    minTileY: 0,
    maxTileX: 0,
    maxTileY: 0,
  });
  assert.deepEqual({ ...resolveMinimapTileProjection({ minTileX: 30, minTileY: 28 }) }, {
    gridSize: 64,
    worldUnitsPerTile: 533.3333333333334,
    minTileX: 30,
    minTileY: 28,
    maxTileX: 30,
    maxTileY: 28,
  });
  assert.deepEqual({ ...resolveMinimapTileProjection(tiles) }, tiles);
});

const {
  createIsoView,
  DEFAULT_ISO_YAW,
  getIsoPanForCenter,
  ISO_PITCH,
} = loadModule('../renderer/scripts/utils/map-projection.ts');
const { applyIsoCamera, serverToThree } = loadModule('../renderer/scripts/instance-scene/iso-camera.ts');
const { OrthographicCamera } = loadModule('../node_modules/three/build/three.module.js');

const sceneBox = { minX: 291, maxX: 745, minY: 0, maxY: 893, minZ: -5, maxZ: 878 };
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);

test('iso view fits the whole scene box inside the canvas at zoom 1', () => {
  const view = createIsoView(sceneBox, 900, 600, DEFAULT_ISO_YAW, ISO_PITCH, { zoom: 1, panX: 0, panY: 0 });
  for (const x of [sceneBox.minX, sceneBox.maxX]) {
    for (const y of [sceneBox.minY, sceneBox.maxY]) {
      for (const z of [sceneBox.minZ, sceneBox.maxZ]) {
        const point = view.projection.worldToScreen(x, y, z);
        assert.ok(point.x >= -1e-6 && point.x <= 900 + 1e-6 && point.y >= -1e-6 && point.y <= 600 + 1e-6);
      }
    }
  }
});

test('iso view keeps its centre point at the canvas centre under zoom and pan', () => {
  const view = createIsoView(sceneBox, 900, 600, 1.1, ISO_PITCH, { zoom: 3, panX: 140, panY: -60 });
  const point = view.projection.worldToScreen(...view.center);
  near(point.x, 450, 'x');
  near(point.y, 300, 'y');
});

test('higher points draw higher on screen without moving sideways', () => {
  const view = createIsoView(sceneBox, 900, 600, DEFAULT_ISO_YAW, ISO_PITCH, { zoom: 1, panX: 0, panY: 0 });
  const floor = view.projection.worldToScreen(500, 400, 100);
  const raised = view.projection.worldToScreen(500, 400, 200);
  near(raised.x, floor.x, 'x');
  assert.ok(raised.y < floor.y);
});

test('a top-down camera from the south matches the flat map orientation (north up, east right)', () => {
  const view = createIsoView(sceneBox, 900, 600, Math.PI, Math.PI / 2 - 1e-9, { zoom: 1, panX: 0, panY: 0 });
  const origin = view.projection.worldToScreen(500, 400, 0);
  const north = view.projection.worldToScreen(510, 400, 0);
  const east = view.projection.worldToScreen(500, 390, 0);
  assert.ok(north.y < origin.y);
  near(north.x, origin.x, 'north x');
  assert.ok(east.x > origin.x);
  near(east.y, origin.y, 'east y');
});

test('quarter turns keep the zoom and the pan that centres a point', () => {
  const point = [600, 300, 500];
  for (const yaw of [DEFAULT_ISO_YAW, DEFAULT_ISO_YAW + Math.PI / 2, DEFAULT_ISO_YAW + Math.PI, 2.3]) {
    const pan = getIsoPanForCenter(sceneBox, 900, 600, yaw, ISO_PITCH, 2.5, point);
    const view = createIsoView(sceneBox, 900, 600, yaw, ISO_PITCH, { zoom: 2.5, ...pan });
    const screen = view.projection.worldToScreen(...point);
    near(screen.x, 450, `x at yaw ${yaw}`);
    near(screen.y, 300, `y at yaw ${yaw}`);
  }
});

test('the three.js camera draws world points on the same pixels as the overlay projection', () => {
  const width = 900;
  const height = 600;
  const camera = new OrthographicCamera();
  for (const yaw of [DEFAULT_ISO_YAW, 0.4, DEFAULT_ISO_YAW + Math.PI / 2]) {
    const view = createIsoView(sceneBox, width, height, yaw, ISO_PITCH, { zoom: 2, panX: -80, panY: 35 });
    applyIsoCamera(camera, view, width, height);
    for (const point of [[300, 10, 0], [520, 450, 640], [740, 880, 870]]) {
      const ndc = serverToThree(point).project(camera);
      const expected = view.projection.worldToScreen(...point);
      near((ndc.x + 1) / 2 * width, expected.x, `x at yaw ${yaw}`);
      near((1 - ndc.y) / 2 * height, expected.y, `y at yaw ${yaw}`);
      assert.ok(ndc.z > -1 && ndc.z < 1, 'inside the depth range');
    }
  }
});

const { getFadeVolumes, getHeightBand, getSceneFade, MAX_FADE_VOLUMES } = loadModule('../renderer/scripts/utils/map-projection.ts');

test('height band spans the party and ignores missing heights', () => {
  assert.deepEqual({ ...getHeightBand([777.4, 776.5, Number.NaN, 777]) }, { minZ: 776.5, maxZ: 777.4 });
  assert.equal(getHeightBand([]), null);
});

test('nearby party members share a fade volume; distant ones keep their own', () => {
  const settings = { height: 10, horizontal: 40 };
  const plain = (volumes) => Array.from(volumes, (volume) => ({ ...volume }));
  // Within 20 yards across and 5 yards up: one box around both.
  assert.deepEqual(plain(getFadeVolumes([[0, 0, 0], [12, 0, 3], [Number.NaN, 0, 0]], settings)), [
    { minX: 0, maxX: 12, minY: 0, maxY: 0, minZ: 0, maxZ: 3 },
  ]);
  // Too far apart across, or too far apart in height: separate volumes.
  assert.equal(getFadeVolumes([[0, 0, 0], [25, 0, 0]], settings).length, 2);
  assert.equal(getFadeVolumes([[0, 0, 0], [0, 0, 6]], settings).length, 2);
  // Without a horizontal fade, only height matters.
  assert.equal(getFadeVolumes([[0, 0, 0], [300, 0, 4]], { height: 10, horizontal: null }).length, 1);
});

test('large groups merge their closest clusters until they fit the shader limit', () => {
  const settings = { height: 10, horizontal: 40 };
  // 80 players spread 100 yards apart: nothing is close enough to merge by distance.
  const crowd = Array.from({ length: 80 }, (_, index) => [(index % 10) * 100, Math.floor(index / 10) * 100, 0]);
  const volumes = getFadeVolumes(crowd, settings);
  assert.ok(volumes.length <= MAX_FADE_VOLUMES, `${volumes.length} volumes`);
  for (const [x, y, z] of crowd) {
    assert.ok(volumes.some((volume) => x >= volume.minX && x <= volume.maxX && y >= volume.minY
      && y <= volume.maxY && z >= volume.minZ && z <= volume.maxZ), `player at ${x},${y} is covered`);
  }
});

test('the height fade falls off linearly over its range above and below the party', () => {
  const settings = { height: 10, horizontal: null };
  const volumes = getFadeVolumes([[0, 0, 100]], settings);
  assert.equal(getSceneFade([500, 500, 100], volumes, settings), 1, 'horizontal distance ignored when off');
  near(getSceneFade([0, 0, 105], volumes, settings), 0.5, 'halfway above');
  near(getSceneFade([0, 0, 97.5], volumes, settings), 0.75, 'quarter below');
  assert.equal(getSceneFade([0, 0, 111], volumes, settings), 0);
});

test('the horizontal fade keeps a solid core of half its reach, then fades out', () => {
  const settings = { height: 10, horizontal: 40 };
  const volumes = getFadeVolumes([[0, 0, 0]], settings);
  assert.equal(getSceneFade([12, 16, 0], volumes, settings), 1, '20 yards: edge of the core');
  near(getSceneFade([30, 0, 0], volumes, settings), 0.5, '30 yards');
  assert.equal(getSceneFade([0, 40, 0], volumes, settings), 0, '40 yards');
  near(getSceneFade([30, 0, 5], volumes, settings), 0.25, 'both fades multiply');
});

test('each member keeps their own surroundings visible, and the scene is solid with no party', () => {
  const settings = { height: 10, horizontal: 40 };
  const volumes = getFadeVolumes([[0, 0, 0], [200, 0, 50]], settings);
  assert.equal(getSceneFade([200, 10, 50], volumes, settings), 1, 'near the second member');
  assert.equal(getSceneFade([100, 0, 25], volumes, settings), 0, 'the gap between them');
  assert.equal(getSceneFade([100, 0, 25], [], settings), 1);
});

const { clampIsoPitch, getNextQuarterTurn, ISO_PITCH_MAX, ISO_PITCH_MIN } = loadModule('../renderer/scripts/utils/map-projection.ts');

test('quarter turns step between standard angles and snap back after free rotation', () => {
  const quarter = Math.PI / 2;
  near(getNextQuarterTurn(DEFAULT_ISO_YAW, 1), DEFAULT_ISO_YAW + quarter, 'from standard, right');
  near(getNextQuarterTurn(DEFAULT_ISO_YAW, -1), DEFAULT_ISO_YAW - quarter, 'from standard, left');
  near(getNextQuarterTurn(DEFAULT_ISO_YAW + 0.3, 1), DEFAULT_ISO_YAW + quarter, 'free, right');
  near(getNextQuarterTurn(DEFAULT_ISO_YAW + 0.3, -1), DEFAULT_ISO_YAW, 'free, left');
  near(getNextQuarterTurn(DEFAULT_ISO_YAW - 3 * quarter - 0.2, -1), DEFAULT_ISO_YAW - 4 * quarter, 'several turns away');
});

test('tilt is limited to between a low oblique view and straight down', () => {
  assert.equal(clampIsoPitch(-1), ISO_PITCH_MIN);
  assert.equal(clampIsoPitch(3), ISO_PITCH_MAX);
  assert.equal(clampIsoPitch(ISO_PITCH), ISO_PITCH);
});

test('the three.js camera still matches the overlay when looking straight down', () => {
  const camera = new OrthographicCamera();
  const view = createIsoView(sceneBox, 900, 600, 2.1, ISO_PITCH_MAX, { zoom: 1.5, panX: 20, panY: -10 });
  applyIsoCamera(camera, view, 900, 600);
  for (const point of [[300, 10, 0], [520, 450, 640]]) {
    const ndc = serverToThree(point).project(camera);
    const expected = view.projection.worldToScreen(...point);
    near((ndc.x + 1) / 2 * 900, expected.x, 'x');
    near((1 - ndc.y) / 2 * 600, expected.y, 'y');
  }
});
