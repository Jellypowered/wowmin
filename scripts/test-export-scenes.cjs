const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const exporter = import(pathToFileURL(path.join(__dirname, 'export-scenes.mjs')).href);

test('scene export options need a source and maps', async () => {
  const { parseSceneArgs } = await exporter;
  const options = parseSceneArgs(['--source', '/wow', '--map', '489', '-m', '574', '--scene-texture-max', '256']);
  assert.deepEqual(options.mapIds, [489, 574]);
  assert.equal(options.textureMax, 256);
  assert.equal(options.source, path.resolve('/wow'));
  assert.equal(options.output, path.resolve('assets/instances'));
  assert.equal(parseSceneArgs(['--source', '/wow', '--all-instances']).allInstances, true);
  assert.throws(() => parseSceneArgs(['--map', '489'], {}), /--source/);
  assert.throws(() => parseSceneArgs(['--source', '/wow']), /--map <id> or --all-instances/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--map', '1', '--all-instances']), /mutually exclusive/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--map', 'x']), /non-negative integers/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--scenes']), /Unknown argument/);
});

test('the client data folder falls back to WOWMIN_CLIENT_DATA from the settings, --source winning', async () => {
  const { parseSceneArgs } = await exporter;
  assert.equal(parseSceneArgs(['--all-instances'], { WOWMIN_CLIENT_DATA: '/data' }).source, path.resolve('/data'));
  assert.equal(parseSceneArgs(['--source', '/wow', '--all-instances'], { WOWMIN_CLIENT_DATA: '/data' }).source, path.resolve('/wow'));
  assert.throws(() => parseSceneArgs(['--all-instances'], { WOWMIN_CLIENT_DATA: '' }), /WOWMIN_CLIENT_DATA/);
});

test('loads the settings files as the web service does: the system file, then the project\'s .env, skipping missing ones', async () => {
  const { loadSettingsEnv, settingsFiles } = await import(pathToFileURL(path.join(__dirname, 'settings-env.mjs')).href);
  assert.deepEqual(settingsFiles('linux', {}, '/repo'), ['/etc/wowmin.env', path.join('/repo', '.env')]);
  assert.deepEqual(settingsFiles('win32', { ProgramData: 'C:\\ProgramData' }, '/repo'), ['C:\\ProgramData\\wowmin\\wowmin.env', path.join('/repo', '.env')]);
  const loaded = [];
  const warnings = [];
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const broken = Object.assign(new Error('bad line'), { code: 'EINVAL' });
  loadSettingsEnv(['/etc/wowmin.env', '/repo/.env', '/repo/bad.env'], (file) => {
    if (file === '/etc/wowmin.env') throw missing;
    if (file === '/repo/bad.env') throw broken;
    loaded.push(file);
  }, (message) => warnings.push(message));
  assert.deepEqual(loaded, ['/repo/.env']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad\.env/);
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
  const { sceneManifest, SCENE_SCHEMA_VERSION } = await exporter;
  const manifest = sceneManifest(
    { mapId: 109, label: 'Sunken Temple', mapType: 1, mapTypeLabel: 'instance', floors: [] },
    { file: '109.glb', bounds: { minX: 0 }, groups: [], floors: [] },
  );
  assert.deepEqual(manifest, {
    schemaVersion: SCENE_SCHEMA_VERSION, mapId: 109, label: 'Sunken Temple', mapType: 1, mapTypeLabel: 'instance',
    file: '109.glb', bounds: { minX: 0 }, groups: [], floors: [],
  });
});
