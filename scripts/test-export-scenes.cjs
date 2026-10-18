const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');

const exporter = import(pathToFileURL(path.join(__dirname, 'export-scenes.mjs')).href);

test('scene export options need a source and maps', async () => {
  const { parseSceneArgs } = await exporter;
  const options = parseSceneArgs(['--source', '/wow', '--map', '489', '-m', '574', '--scene-texture-max', '256']);
  assert.deepEqual(options.mapIds, [489, 574]);
  assert.equal(options.textureMax, 256);
  assert.equal(options.source, path.resolve('/wow'));
  assert.equal(options.output, path.resolve('assets/instances'));
  assert.equal(parseSceneArgs(['--source', '/wow', '--all-instances']).allInstances, true);
  assert.throws(() => parseSceneArgs(['--map', '489']), /--source/);
  assert.throws(() => parseSceneArgs(['--source', '/wow']), /--map <id> or --all-instances/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--map', '1', '--all-instances']), /mutually exclusive/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--map', 'x']), /non-negative integers/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--scenes']), /Unknown argument/);
});

test('scene export options also come from npm config, as npm passes them without a standalone --', async () => {
  const { parseSceneArgs } = await exporter;
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { npm_config_source: '/wow', npm_config_all_instances: 'true', npm_config_scene_texture_max: '256' });
    const options = parseSceneArgs([]);
    assert.equal(options.source, path.resolve('/wow'));
    assert.equal(options.allInstances, true);
    assert.equal(options.textureMax, 256);
    process.env.npm_config_source = 'true';
    assert.throws(() => parseSceneArgs([]), /npm consumed --source without their values/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('a scene manifest names its map and carries the scene', async () => {
  const { sceneManifest, SCENE_SCHEMA_VERSION, SCENE_EXPORT_VERSION } = await exporter;
  const manifest = sceneManifest(
    { mapId: 109, label: 'Sunken Temple', mapType: 1, mapTypeLabel: 'instance', floors: [] },
    { file: '109.glb', bounds: { minX: 0 }, groups: [], floors: [] },
  );
  assert.deepEqual(manifest, {
    schemaVersion: SCENE_SCHEMA_VERSION, exportVersion: SCENE_EXPORT_VERSION, mapId: 109, label: 'Sunken Temple', mapType: 1, mapTypeLabel: 'instance',
    file: '109.glb', bounds: { minX: 0 }, groups: [], floors: [],
  });
});

// WoWMin's own scene export version (src/scene-export-version.ts), built for
// node so the test reads what the viewer and the server use.
function loadSceneVersion() {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'scene-export-version.ts')], bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} } };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

test('the exporter writes the scene export version WoWMin draws', async () => {
  const { SCENE_EXPORT_VERSION } = await exporter;
  assert.equal(SCENE_EXPORT_VERSION, loadSceneVersion().SCENE_EXPORT_VERSION,
    'bump SCENE_EXPORT_VERSION in scripts/export-scenes.mjs and src/scene-export-version.ts together');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'scene-export-version.ts'), 'utf8'),
    new RegExp(`^// ${SCENE_EXPORT_VERSION}: `, 'm'), 'note what each scene export version changed');
});

test('tells older and newer scene exports from current ones, and what to run', () => {
  const version = loadSceneVersion();
  assert.equal(version.sceneExportStatus(undefined, 2), 'older', 'scenes from before the version was kept count as 1');
  assert.equal(version.sceneExportStatus(1, 1), 'current');
  assert.equal(version.sceneExportStatus(3, 2), 'newer');
  assert.equal(version.sceneExportNotice('current'), null);
  assert.match(version.sceneExportNotice('older'), /npm run extract:scenes -- --all-instances/);
  assert.match(version.sceneExportNotice('newer'), /npm run build/);
  assert.equal(version.sceneExportAdvice([2, 2], 2), null);
  assert.equal(version.sceneExportAdvice([undefined, 1, 2, 3], 2),
    '2 of 4 3D scenes predate this WoWMin: run npm run extract:scenes -- --all-instances.'
    + ' 1 of 4 3D scenes are newer than this WoWMin: run npm run build and restart it.');
});
