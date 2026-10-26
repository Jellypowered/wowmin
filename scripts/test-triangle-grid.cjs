const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// The triangle grid the 3D scene's ground rays use: its hits must be the
// ones three.js finds testing every triangle.

function loadModule(relativePath) {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, relativePath)], bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} }, require, Math };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const { TriangleGrid } = loadModule('../renderer/scripts/utils/triangle-grid.ts');

function random(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// A bumpy height field of `size` quads a side, `step` yards apart, two
// triangles a quad, as terrain is.
function heightField(size, step, next) {
  const heights = Array.from({ length: (size + 1) ** 2 }, () => next() * 30);
  const positions = new Float32Array((size + 1) ** 2 * 3);
  heights.forEach((height, index) => positions.set([1000 + (index % (size + 1)) * step, -500 + Math.floor(index / (size + 1)) * step, height], index * 3));
  const indices = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const a = row * (size + 1) + column;
      indices.push(a, a + 1, a + size + 2, a, a + size + 2, a + size + 1);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

// Triangles scattered through a box, some large, as a building's are.
function triangleSoup(count, next) {
  const positions = new Float32Array(count * 9);
  for (let triangle = 0; triangle < count; triangle += 1) {
    const [x, y, z] = [next() * 80, next() * 80, next() * 40];
    const size = next() < 0.1 ? 30 : 4;
    for (let corner = 0; corner < 3; corner += 1) {
      positions.set([x + (next() - 0.5) * size, y + (next() - 0.5) * size, z + (next() - 0.5) * size], triangle * 9 + corner * 3);
    }
  }
  return { positions, indices: null };
}

// The nearest hit by testing every triangle with three.js, as Mesh.raycast
// does (FrontSide culls back faces; BackSide tests the reversed triangle).
function bruteForce(three, { positions, indices }, origin, direction, far, culling) {
  const ray = new three.Ray(new three.Vector3(...origin), new three.Vector3(...direction));
  const count = indices ? indices.length / 3 : positions.length / 9;
  const vertex = (triangle, corner) => new three.Vector3().fromArray(positions, (indices ? indices[triangle * 3 + corner] : triangle * 3 + corner) * 3);
  const point = new three.Vector3();
  let best = null;
  for (let triangle = 0; triangle < count; triangle += 1) {
    const [a, b, c] = [vertex(triangle, 0), vertex(triangle, 1), vertex(triangle, 2)];
    const hit = culling === 'front' ? ray.intersectTriangle(c, b, a, true, point) : ray.intersectTriangle(a, b, c, culling === 'back', point);
    if (!hit) continue;
    const distance = ray.origin.distanceTo(point);
    if (distance <= far && (best === null || distance < best)) best = distance;
  }
  return best;
}

const unit = (vector) => {
  const size = Math.hypot(...vector);
  return vector.map((value) => value / size);
};
const sameHit = (actual, expected, label) => {
  if (expected === null) assert.equal(actual, null, label);
  else assert.ok(actual !== null && Math.abs(actual - expected) < 1e-3, `${label}: ${actual} != ${expected}`);
};

test('finds what three.js finds straight down onto a height field, with one cell a ray', async () => {
  const three = await import('three');
  const next = random(3);
  const mesh = heightField(40, 4.1666, next);
  const grid = TriangleGrid.build(mesh.positions, mesh.indices);
  let hits = 0;
  for (let index = 0; index < 300; index += 1) {
    // Some start beside the field, some below it, some too high to reach.
    const origin = [990 + next() * 190, -510 + next() * 190, next() * 60 - 5];
    const far = next() < 0.2 ? 5 : 20;
    const expected = bruteForce(three, mesh, origin, [0, 0, -1], far, 'none');
    if (expected !== null) hits += 1;
    sameHit(grid.cast(...origin, 0, 0, -1, far), expected, `ray ${index}`);
  }
  assert.ok(hits > 40, `only ${hits} rays hit`);
});

test('finds what three.js finds along slanted rays through scattered triangles', async () => {
  const three = await import('three');
  const next = random(11);
  const mesh = triangleSoup(400, next);
  const grid = TriangleGrid.build(mesh.positions, mesh.indices);
  let hits = 0;
  for (let index = 0; index < 400; index += 1) {
    const origin = [next() * 120 - 20, next() * 120 - 20, next() * 60 - 10];
    const direction = unit([next() - 0.5, next() - 0.5, next() - 0.5]);
    const culling = ['none', 'back', 'front'][index % 3];
    const expected = bruteForce(three, mesh, origin, direction, 120, culling);
    if (expected !== null) hits += 1;
    sameHit(grid.cast(...origin, ...direction, 120, culling), expected, `ray ${index} (${culling})`);
  }
  assert.ok(hits > 30, `only ${hits} rays hit`);
});

test('skips the faces culling leaves out, and hits beyond the ray\'s reach', () => {
  // One triangle at z 0, its corners anticlockwise seen from above.
  const grid = TriangleGrid.build(new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), null);
  assert.equal(grid.cast(2, 2, 5, 0, 0, -1, 20), 5);
  assert.equal(grid.cast(2, 2, 5, 0, 0, -1, 20, 'back'), 5);
  assert.equal(grid.cast(2, 2, 5, 0, 0, -1, 20, 'front'), null);
  assert.equal(grid.cast(2, 2, -5, 0, 0, 1, 20, 'back'), null);
  assert.equal(grid.cast(2, 2, -5, 0, 0, 1, 20, 'front'), 5);
  assert.equal(grid.cast(2, 2, 5, 0, 0, -1, 4), null);
  assert.equal(grid.cast(8, 8, 5, 0, 0, -1, 20), null);
  assert.equal(TriangleGrid.build(new Float32Array(0), null).cast(0, 0, 0, 0, 0, -1, 10), null);
});
