const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/session-recorder.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const moduleValue = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', '__filename', output)(
  moduleValue,
  moduleValue.exports,
  require,
  __dirname,
  __filename,
);
const { SessionRecorder, formatBattlegroundOutcome, readableSessionId } = moduleValue.exports;

function snapshot(capturedAt, players, overrides = {}) {
  return {
    players,
    battlegrounds: [],
    instances: [],
    deaths: [],
    events: [],
    source: 'worldserver',
    capturedAt,
    ...overrides,
  };
}

function player(instanceId, startedAt = 100) {
  return {
    name: 'Jaspianus', map: 631, instanceId, position_x: 10, position_y: 20, position_z: 30,
    orientation: 1, level: 79, race: 1, class: 1, account: '1', accountId: 1, isBot: true,
    alive: true, inCombat: true, mapType: 2, difficulty: 0, sessionStartedAt: startedAt,
  };
}

test('builds readable session file names', () => {
  const startedAt = Date.UTC(2026, 9, 8, 14, 30);
  assert.equal(readableSessionId(489, 'Warsong Gulch', 3, startedAt), 'WSG-3-Oct08-26');
  assert.equal(readableSessionId(33, 'Shadowfang Keep', 17, startedAt), 'SFK-17-Oct08-26');
  assert.equal(readableSessionId(543, 'Hellfire Citadel: Ramparts', 22, startedAt, 1, 1),
    'Ramps(H)-22-Oct08-26');
  assert.equal(readableSessionId(540, 'Hellfire Citadel: The Shattered Halls', 23, startedAt),
    'SHH-23-Oct08-26');
  assert.equal(readableSessionId(568, "Zul'Aman", 24, startedAt), 'ZA-24-Oct08-26');
});

test('defaults recording off when no persisted setting exists', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-recording-default-'));
  const recorder = new SessionRecorder({ dataDir });
  assert.equal(await recorder.isEnabled(), false);
  const settings = JSON.parse(await fs.readFile(path.join(dataDir, 'session-recording.json'), 'utf8'));
  assert.equal(settings.enabled, false);
});

test('records, deduplicates, persists, and indexes a completed session', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-recorder-'));
  const recorder = new SessionRecorder({
    dataDir,
    recordingEnabledDefault: true,
    routeIntervalMs: 1,
    completionGraceMs: 10,
    checkpointIntervalMs: 1,
  });
  const startedAt = Math.floor(Date.now() / 1000);
  const first = snapshot(startedAt * 1000 + 1000, [player(42, startedAt)], {
    events: [{ mapId: 631, instanceId: 42, eventId: 7, occurredAt: startedAt + 1, type: 'loot', actorGuid: 1,
      actorName: 'Jaspianus', targetGuid: 0, targetType: 0, targetName: '', valueId: 49908,
      valueName: 'Primordial Saronite', amount: 2 }],
    deaths: [{ mapId: 631, instanceId: 42, eventId: 8, occurredAt: startedAt + 1, victimGuid: 1,
      victimName: 'Jaspianus', killerGuid: 2, killerType: 3, killerName: 'Boss' }],
  });
  await recorder.ingest(first);
  await recorder.ingest({ ...first, capturedAt: first.capturedAt + 10 });
  await recorder.ingest(snapshot(first.capturedAt + 20, []));
  await recorder.ingest(snapshot(first.capturedAt + 40, []));

  const index = await recorder.list();
  assert.equal(index.length, 1);
  assert.equal(index[0].eventCount, 2);
  assert.equal(index[0].totals.lootItems, 2);
  assert.equal(index[0].totals.deaths, 1);
  assert.match(index[0].id, /^ICC-42-[A-Z][a-z]{2}\d{2}-\d{2}$/);
  assert.ok((await fs.readdir(path.join(dataDir, 'sessions'))).includes(`${index[0].id}.json`));
  const record = await recorder.get(index[0].id);
  assert.equal(record.completed, true);
  assert.equal(record.events.length, 2);
  assert.ok(record.routes.length >= 1);
  assert.equal(record.participants[0].name, 'Jaspianus');
});

test('persists and indexes a completed battleground outcome', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-bg-outcome-'));
  const recorder = new SessionRecorder({ dataDir, recordingEnabledDefault: true, routeIntervalMs: 1, completionGraceMs: 1 });
  const startedAt = Math.floor(Date.now() / 1000);
  const bgPlayer = { ...player(55, startedAt), map: 489, mapType: 3, teamId: 0 };
  const battleground = {
    mapId: 489, instanceId: 55, battlegroundTypeId: 2, status: 3, elapsedMs: 300000,
    remainingMs: 0, winner: 2, allianceScore: 2, hordeScore: 2, alliancePlayers: 5,
    hordePlayers: 5, allianceAlive: 5, hordeAlive: 5, nextResurrectMs: 10000,
    allianceStrategy: -1, hordeStrategy: -1, worldStates: [],
  };
  const active = snapshot(startedAt * 1000 + 1000, [bgPlayer], { battlegrounds: [battleground] });
  await recorder.ingest(active);
  await recorder.ingest({ ...active, capturedAt: active.capturedAt + 1000,
    battlegrounds: [{ ...battleground, status: 4, winner: 1, allianceScore: 3 }] });
  await recorder.ingest(snapshot(active.capturedAt + 1010, []));
  await recorder.ingest(snapshot(active.capturedAt + 1020, []));

  const [entry] = await recorder.list();
  assert.equal(formatBattlegroundOutcome(entry.battleground), 'Alliance wins 3-2');
  const record = await recorder.get(entry.id);
  assert.equal(formatBattlegroundOutcome(record.battleground), 'Alliance wins 3-2');
  assert.equal(record.events.filter((event) => event.type === 'match-result').length, 1);
  assert.equal(record.events.find((event) => event.type === 'match-result').description, 'Alliance wins 3-2');
});

test('formats battleground-specific outcomes', () => {
  const base = { mapId: 529, battlegroundTypeId: 3, status: 4, winner: 0,
    allianceScore: 1200, hordeScore: 1600 };
  assert.equal(formatBattlegroundOutcome(base), 'Horde wins');
  assert.equal(formatBattlegroundOutcome({ ...base, mapId: 566 }), 'Horde wins 1600-1200');
  assert.equal(formatBattlegroundOutcome({ ...base, mapId: 489, winner: 2,
    allianceScore: 2, hordeScore: 2 }), 'Draw 2-2');
  assert.equal(formatBattlegroundOutcome({ ...base, mapId: 628, winner: 1 }), 'Alliance wins');
  assert.equal(formatBattlegroundOutcome({ ...base, status: 3 }), null);
});

test('records a final battleground state after all players leave', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-bg-final-'));
  const recorder = new SessionRecorder({ dataDir, recordingEnabledDefault: true, routeIntervalMs: 1, completionGraceMs: 10 });
  const startedAt = Math.floor(Date.now() / 1000);
  const bgPlayer = { ...player(56, startedAt), map: 489, mapType: 3, teamId: 0 };
  const battleground = {
    mapId: 489, instanceId: 56, battlegroundTypeId: 2, status: 3, elapsedMs: 300000,
    remainingMs: 0, winner: 2, allianceScore: 2, hordeScore: 0, alliancePlayers: 5,
    hordePlayers: 5, allianceAlive: 5, hordeAlive: 5, nextResurrectMs: 10000,
    allianceStrategy: -1, hordeStrategy: -1, worldStates: [],
  };
  const active = snapshot(startedAt * 1000 + 1000, [bgPlayer], { battlegrounds: [battleground] });
  await recorder.ingest(active);
  await recorder.ingest(snapshot(active.capturedAt + 10, [], {
    battlegrounds: [{ ...battleground, status: 4, winner: 1, allianceScore: 3 }],
  }));
  await recorder.ingest(snapshot(active.capturedAt + 30, []));

  const [entry] = await recorder.list();
  assert.equal(formatBattlegroundOutcome(entry.battleground), 'Alliance wins 3-0');
  const record = await recorder.get(entry.id);
  assert.equal(record.events.find((event) => event.type === 'match-result').description, 'Alliance wins 3-0');
});

test('records EotS resource gains as objectives rather than flag captures', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-eots-score-'));
  const recorder = new SessionRecorder({ dataDir, recordingEnabledDefault: true, routeIntervalMs: 1, completionGraceMs: 1 });
  const startedAt = Math.floor(Date.now() / 1000);
  const bgPlayer = { ...player(57, startedAt), map: 566, mapType: 3, teamId: 0 };
  const battleground = {
    mapId: 566, instanceId: 57, battlegroundTypeId: 7, status: 3, elapsedMs: 300000,
    remainingMs: 0, winner: 2, allianceScore: 100, hordeScore: 50, alliancePlayers: 5,
    hordePlayers: 5, allianceAlive: 5, hordeAlive: 5, nextResurrectMs: 10000,
    allianceStrategy: -1, hordeStrategy: -1, worldStates: [],
  };
  const active = snapshot(startedAt * 1000 + 1000, [bgPlayer], { battlegrounds: [battleground] });
  await recorder.ingest(active);
  await recorder.ingest({ ...active, capturedAt: active.capturedAt + 10,
    battlegrounds: [{ ...battleground, allianceScore: 110 }] });
  await recorder.ingest(snapshot(active.capturedAt + 20, []));
  await recorder.ingest(snapshot(active.capturedAt + 30, []));

  const [entry] = await recorder.list();
  assert.equal(entry.totals.flagCaptures, 0);
  assert.equal(entry.totals.objectives, 1);
});

test('purges abandoned incomplete checkpoints and temporary files on startup', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-incomplete-'));
  const options = { dataDir, recordingEnabledDefault: true, routeIntervalMs: 1, checkpointIntervalMs: 1 };
  const startedAt = Math.floor(Date.now() / 1000);
  const firstRecorder = new SessionRecorder(options);
  await firstRecorder.ingest(snapshot(startedAt * 1000 + 1000, [player(77, startedAt)]));

  const sessionDir = path.join(dataDir, 'sessions');
  const activeDir = path.join(sessionDir, '.active');
  assert.equal((await fs.readdir(activeDir)).filter((name) => name.endsWith('.json')).length, 1);
  await fs.writeFile(path.join(activeDir, 'abandoned.tmp'), 'partial');
  await fs.writeFile(path.join(sessionDir, 'index.json.123.tmp'), 'partial');

  const restartedRecorder = new SessionRecorder(options);
  assert.equal((await restartedRecorder.list()).length, 0);
  assert.deepEqual(await fs.readdir(activeDir), []);
  assert.equal((await fs.readdir(sessionDir)).some((name) => name.endsWith('.tmp')), false);
});

test('purges completed history only when explicitly requested', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-purge-'));
  const recorder = new SessionRecorder({ dataDir, recordingEnabledDefault: true, routeIntervalMs: 1, completionGraceMs: 1, checkpointIntervalMs: 1 });
  const startedAt = Math.floor(Date.now() / 1000);
  const completed = snapshot(startedAt * 1000 + 10, [player(1, startedAt)]);
  await recorder.ingest(completed);
  await recorder.ingest(snapshot(completed.capturedAt + 10, []));
  await recorder.ingest(snapshot(completed.capturedAt + 20, []));
  await recorder.ingest(snapshot(completed.capturedAt + 30, [player(2, startedAt + 1)]));

  assert.equal((await recorder.list()).length, 1);
  assert.equal(await recorder.purgeCompleted(), 1);
  assert.equal((await recorder.list()).length, 0);
  const sessionDir = path.join(dataDir, 'sessions');
  assert.deepEqual((await fs.readdir(sessionDir)).filter((name) => name.endsWith('.json')), ['index.json']);
  assert.equal((await fs.readdir(path.join(sessionDir, '.active'))).filter((name) => name.endsWith('.json')).length, 1);
});

test('disabling recording discards active checkpoints without deleting completed sessions', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-recording-toggle-'));
  const recorder = new SessionRecorder({ dataDir, recordingEnabledDefault: true, routeIntervalMs: 1, completionGraceMs: 1, checkpointIntervalMs: 1 });
  const startedAt = Math.floor(Date.now() / 1000);

  const completed = snapshot(startedAt * 1000 + 10, [player(1, startedAt)]);
  await recorder.ingest(completed);
  await recorder.ingest(snapshot(completed.capturedAt + 10, []));
  await recorder.ingest(snapshot(completed.capturedAt + 20, []));

  await recorder.ingest(snapshot(completed.capturedAt + 30, [player(2, startedAt + 1)]));
  const activeDir = path.join(dataDir, 'sessions', '.active');
  assert.equal((await fs.readdir(activeDir)).filter((name) => name.endsWith('.json')).length, 1);
  assert.equal(await recorder.setEnabled(false), false);
  assert.equal(await recorder.isEnabled(), false);
  assert.deepEqual(await fs.readdir(activeDir), []);
  assert.equal((await recorder.list()).length, 1);

  await recorder.ingest(snapshot(completed.capturedAt + 40, [player(3, startedAt + 2)]));
  assert.deepEqual(await fs.readdir(activeDir), []);
  const restartedDisabledRecorder = new SessionRecorder({ dataDir });
  assert.equal(await restartedDisabledRecorder.isEnabled(), false);

  assert.equal(await restartedDisabledRecorder.setEnabled(true), true);
  const restartedEnabledRecorder = new SessionRecorder({ dataDir });
  assert.equal(await restartedEnabledRecorder.isEnabled(), true);
});

test('derives objective transitions once and retains all completed records', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-history-'));
  const recorder = new SessionRecorder({ dataDir, recordingEnabledDefault: true, routeIntervalMs: 1, completionGraceMs: 1 });
  const baseStartedAt = Math.floor(Date.now() / 1000);
  for (const [instanceId, startedAt] of [[1, baseStartedAt], [2, baseStartedAt + 1]]) {
    const active = snapshot(startedAt * 1000 + 10, [player(instanceId, startedAt)], {
      battlegrounds: [{ mapId: 631, instanceId, battlegroundTypeId: 0, status: 3, elapsedMs: 0,
        remainingMs: 0, winner: 0, allianceScore: 0, hordeScore: 0, alliancePlayers: 1,
        hordePlayers: 0, allianceAlive: 1, hordeAlive: 0, nextResurrectMs: 0,
        allianceStrategy: -1, hordeStrategy: -1, worldStates: [{ id: 9, value: 1 }] }],
    });
    await recorder.ingest(active);
    await recorder.ingest({ ...active, capturedAt: active.capturedAt + 10,
      battlegrounds: [{ ...active.battlegrounds[0], worldStates: [{ id: 9, value: 2 }] }] });
    await recorder.ingest(snapshot(active.capturedAt + 20, []));
    await recorder.ingest(snapshot(active.capturedAt + 30, []));
  }
  const index = await recorder.list();
  assert.equal(index.length, 2);
  assert.equal(index[0].instanceId, 2);
  assert.equal(index[0].totals.objectives, 1);
  assert.equal(index[1].instanceId, 1);
  assert.equal(index[1].totals.objectives, 1);
});
