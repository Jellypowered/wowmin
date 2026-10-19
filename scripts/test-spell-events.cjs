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
  const context = { module: { exports: {} }, require };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const {
  AREA_FLASH_MS, CHAIN_JUMP_MS, CHAIN_LINK_MS, CombatEffectStore, EVENT_DRIVEN_MS, HEAL_COLOR, NUMBER_LIFETIME_MS, RELEASE_FLASH_MS, STREAK_MS,
  auraTintColor, getCastStrikeKind, getTravelMs, schoolColor, unitKey,
} = loadModule('../renderer/scripts/utils/spell-events.ts');
const { LIVE_RENDER_DELAY_MS } = loadModule('../renderer/scripts/utils/live-positions.ts');

// A combat event as parseCombatEventDatagram returns it.
function event(fields) {
  return {
    kind: 'castGo', sourceGuid: 1, sourceCreature: false, targetGuid: 900, targetCreature: true, spellId: 116,
    schoolMask: 16, auraCategory: null, value: 0, missileSpeed: 0, radius: 0, point: null, area: false,
    channeled: false, periodic: false, helpful: false, triggered: false, ageMs: 0, ...fields,
  };
}

const update = (events, dropped = 0) => ({ mapId: 601, instanceId: 7, serverTimeMs: 0, dropped, events });
const plain = (value) => JSON.parse(JSON.stringify(value));
const tenYards = () => 10;
const unknown = () => null;

test('names units like the model layer and colours schools, the most telling first', () => {
  assert.equal(unitKey(42, false), 'p42');
  assert.equal(unitKey(42, true), 'c42');
  assert.equal(schoolColor(4), '#fb923c');
  assert.equal(schoolColor(4 | 16), schoolColor(16));
  assert.equal(schoolColor(0), schoolColor(1));
  assert.notEqual(auraTintColor('crowdControl'), auraTintColor('shield'));
});

test('plays events on the delayed clock, offset by their age', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ kind: 'castStart', value: 2500, ageMs: 40 })]), 1000);
  const playAt = 1000 - 40 + LIVE_RENDER_DELAY_MS;
  store.advance(playAt - 1, tenYards);
  assert.equal(store.casts.length, 0);
  store.advance(playAt, tenYards);
  assert.deepEqual(plain(store.casts.map(({ caster, spellId, release }) => ({ caster, spellId, release }))),
    [{ caster: 'p1', spellId: 116, release: false }]);
  assert.ok(store.active);
});

test('a cast glows until it fires, then flashes, launches a missile, and cues a cast animation', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ kind: 'castStart', value: 2500 }),
    event({ kind: 'castGo', missileSpeed: 25, ageMs: 0 }),
  ]), 0);
  const cues = store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(cues), [{ unit: 'p1', kind: 'cast' }]);
  assert.equal(store.casts.length, 1);
  assert.equal(store.casts[0].release, true);
  assert.equal(store.projectiles.length, 1);
  assert.equal(store.projectiles[0].target, 'c900');
  assert.equal(store.projectiles[0].travelMs, 400);
  assert.equal(store.projectiles[0].streak, false);
  // The release flash and the missile both end on time.
  store.advance(LIVE_RENDER_DELAY_MS + RELEASE_FLASH_MS, tenYards);
  assert.equal(store.casts.length, 0);
  store.advance(LIVE_RENDER_DELAY_MS + 400, tenYards);
  assert.equal(store.projectiles.length, 0);
  assert.ok(store.isEventDriven('p1', LIVE_RENDER_DELAY_MS + 400));
  assert.ok(!store.isEventDriven('p1', LIVE_RENDER_DELAY_MS + EVENT_DRIVEN_MS));
});

test('a cancelled cast stops glowing', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ kind: 'castStart', value: 3000 })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  store.push(update([event({ kind: 'castCancel' })]), 500);
  store.advance(500 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.casts.length, 0);
});

test('instant spells streak; no missile without both units; triggered spells only ring', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ missileSpeed: 0 })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.projectiles[0].streak, true);
  assert.equal(store.projectiles[0].travelMs, STREAK_MS);

  const hidden = new CombatEffectStore();
  hidden.push(update([event({ missileSpeed: 20 })]), 0);
  hidden.advance(LIVE_RENDER_DELAY_MS, unknown);
  assert.equal(hidden.projectiles.length, 0);

  const triggered = new CombatEffectStore();
  const cues = (triggered.push(update([event({ triggered: true, area: true, radius: 8, missileSpeed: 20 })]), 0),
    triggered.advance(LIVE_RENDER_DELAY_MS, tenYards));
  assert.deepEqual(plain(cues), []);
  // Its cast art plays as the client's does, without WoWMin's glow.
  assert.deepEqual(plain(triggered.casts.map(({ release, glow }) => ({ release, glow }))), [{ release: true, glow: false }]);
  // A triggered spell with a missile (a channel's bolts) flies; one without doesn't.
  assert.equal(triggered.projectiles.length, 1);
  assert.equal(triggered.rings.length, 1);
  const proc = new CombatEffectStore();
  proc.push(update([event({ triggered: true, missileSpeed: 0 })]), 0);
  proc.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(proc.projectiles.length, 0);
});

test('area spells ring at their ground point; channelled ones last the channel and beam to a target', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ area: true, radius: 8, point: [10, 20, 30], targetGuid: 0, channeled: true, value: 8000, spellId: 10 }),
    event({ sourceGuid: 2, area: true, radius: 10, targetGuid: 0, spellId: 1449, schoolMask: 64 }),
    event({ sourceGuid: 3, channeled: true, value: 3000, spellId: 15407, schoolMask: 32 }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.rings.map(({ caster, point, radius, endAt }) => ({ caster, point, radius, endAt }))), [
    { caster: 'p1', point: [10, 20, 30], radius: 8, endAt: LIVE_RENDER_DELAY_MS + 8000 },
    { caster: 'p2', point: null, radius: 10, endAt: LIVE_RENDER_DELAY_MS + AREA_FLASH_MS },
  ]);
  assert.equal(store.beams.length, 1);
  assert.equal(store.beams[0].source, 'p3');
  // Party buffs and raid-wide areas get no ring.
  store.push(update([
    event({ sourceGuid: 4, area: true, radius: 30, targetGuid: 0, spellId: 48162, schoolMask: 2, helpful: true }),
    event({ sourceGuid: 900, sourceCreature: true, area: true, radius: 100, targetGuid: 0, spellId: 52086, schoolMask: 32 }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.rings.length, 2);
  assert.equal(store.beams[0].target, 'c900');
  // A channel is not a missile.
  assert.equal(store.projectiles.filter((projectile) => projectile.source === 'p3').length, 0);
  store.push(update([event({ kind: 'castCancel', sourceGuid: 3, spellId: 15407 })]), 1000);
  store.advance(1000 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.beams.length, 0);
});

test('keeps every area for the client art: lasting ones for their duration, cancelled channels ending early', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ sourceGuid: 2, spellId: 26573, area: true, radius: 8, point: [1, 2, 3], persistentArea: true, value: 8000, targetGuid: 0, schoolMask: 2 }),
    event({ sourceGuid: 3, spellId: 10, area: true, radius: 8, point: [4, 5, 6], channeled: true, value: 8000, targetGuid: 0 }),
    event({ sourceGuid: 4, spellId: 48078, area: true, radius: 10, helpful: true, targetGuid: 0, schoolMask: 2 }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.areas.map(({ caster, spellId, endAt, channeled }) => ({ caster, spellId, endAt, channeled }))), [
    { caster: 'p2', spellId: 26573, endAt: LIVE_RENDER_DELAY_MS + 8000, channeled: false },
    { caster: 'p3', spellId: 10, endAt: LIVE_RENDER_DELAY_MS + 8000, channeled: true },
    // A helpful burst: no level 1 ring, but an instant area for the art.
    { caster: 'p4', spellId: 48078, endAt: LIVE_RENDER_DELAY_MS, channeled: false },
  ]);
  store.push(update([event({ kind: 'castCancel', sourceGuid: 3, spellId: 10 }), event({ kind: 'castCancel', sourceGuid: 2, spellId: 26573 })]), 2000);
  store.advance(2000 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.areas.map((area) => area.spellId)), [26573]);
  store.advance(LIVE_RENDER_DELAY_MS + 8000, tenYards);
  assert.equal(store.areas.length, 0);
});

test('chooses attack animations for fired spells', () => {
  assert.equal(getCastStrikeKind(event({ schoolMask: 4 })), 'cast');
  assert.equal(getCastStrikeKind(event({ schoolMask: 1, spellId: 75 })), 'ranged');
  assert.equal(getCastStrikeKind(event({ schoolMask: 1, spellId: 12294 })), 'melee');
  assert.equal(getCastStrikeKind(event({ schoolMask: 1, spellId: 6673, helpful: true, targetGuid: 1, targetCreature: false })), null);
  assert.equal(getCastStrikeKind(event({ schoolMask: 4, triggered: true })), null);
  assert.equal(getTravelMs(10, 20), 500);
  assert.equal(getTravelMs(1000, 20), 3000);
  assert.equal(getTravelMs(0.1, 20), 120);
});

test('swings cue melee strikes and drive the unit by events for a while', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ kind: 'swing', sourceGuid: 900, sourceCreature: true, targetGuid: 1, targetCreature: false, schoolMask: 1, spellId: 0 })]), 0);
  assert.deepEqual(plain(store.advance(LIVE_RENDER_DELAY_MS, tenYards)), [{ unit: 'c900', kind: 'melee' }]);
  assert.ok(store.isEventDriven('c900', LIVE_RENDER_DELAY_MS + 1000));
  assert.ok(!store.isEventDriven('p1', LIVE_RENDER_DELAY_MS + 1000));
});

test('damage and heals float numbers; spell hits and heals also flash, white hits do not', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ kind: 'damage', value: 812, spellId: 48125, schoolMask: 32, periodic: true }),
    event({ kind: 'damage', value: 340, spellId: 0, schoolMask: 1 }),
    event({ kind: 'heal', value: 2000, spellId: 48071, schoolMask: 2, targetGuid: 2, targetCreature: false, helpful: true }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.numbers.map(({ target, amount, heal, periodic, color }) => ({ target, amount, heal, periodic, color }))), [
    { target: 'c900', amount: 812, heal: false, periodic: true, color: schoolColor(32) },
    { target: 'c900', amount: 340, heal: false, periodic: false, color: schoolColor(1) },
    { target: 'p2', amount: 2000, heal: true, periodic: false, color: HEAL_COLOR },
  ]);
  assert.deepEqual(plain(store.impacts.map(({ target, heal, small }) => ({ target, heal, small }))), [
    { target: 'c900', heal: false, small: true },
    { target: 'p2', heal: true, small: false },
  ]);
  store.advance(LIVE_RENDER_DELAY_MS + NUMBER_LIFETIME_MS, tenYards);
  assert.equal(store.numbers.length, 0);
  assert.ok(!store.active);
});

test('tints units by their strongest notable aura until it is removed or runs out', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ kind: 'auraApply', auraCategory: 'offensive', spellId: 2825, value: 40000 }),
    event({ kind: 'auraApply', auraCategory: 'crowdControl', spellId: 118, value: 8000 }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.tint('c900'), auraTintColor('crowdControl'));
  assert.deepEqual(plain([...store.tints()]), [['c900', auraTintColor('crowdControl')]]);
  // An aura the client's art shows gets no tint; the next strongest does.
  assert.equal(store.tint('c900', (spellId) => spellId === 118), auraTintColor('offensive'));
  store.push(update([event({ kind: 'auraRemove', spellId: 118 })]), 1000);
  store.advance(1000 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.tint('c900'), auraTintColor('offensive'));
  store.advance(LIVE_RENDER_DELAY_MS + 40000, tenYards);
  assert.equal(store.tint('c900'), null);
});

test('counts dropped events and the event rate', () => {
  const store = new CombatEffectStore();
  store.push(update([event({}), event({})], 5), 1000);
  store.push(update([], 2), 1500);
  assert.equal(store.dropped, 7);
  assert.equal(store.eventsPerSecond(1500), 1);
  assert.equal(store.eventsPerSecond(4000), 0);
  store.clear();
  assert.equal(store.dropped, 0);
});

const plates = loadModule('../renderer/scripts/instance-scene/nameplates.ts');

test('colours nameplate levels against the party, as the client does', () => {
  assert.equal(plates.levelColor(85, 80), '#ff2020');
  assert.equal(plates.levelColor(83, 80), '#ff8040');
  assert.equal(plates.levelColor(78, 80), '#ffff00');
  assert.equal(plates.levelColor(75, 80), '#40c040');
  assert.equal(plates.levelColor(71, 80), '#808080');
  // Low levels: nothing is grey to a level 5.
  assert.equal(plates.levelColor(1, 5), '#40c040');
});

test('sizes nameplates above their anchor, growing with a cast and a note', () => {
  const plate = {
    name: 'Tankard', level: '80', levelColor: '#ffff00', elite: false, boss: false, healthPct: 50, barColor: '#C79C6E',
    alive: true, threat: false, selected: false, cast: null, note: null,
  };
  for (const style of ['neon', 'grey', 'quatre']) {
    const plain = plates.plateBounds(style, plate, 1);
    assert.equal(plain.bottom, 0);
    assert.ok(plain.top < 0 && plain.left < 0 && plain.right > 0);
    const busy = plates.plateBounds(style, { ...plate, cast: { fraction: 0.5, name: 'Frostbolt', channeled: false }, note: 'attack' }, 1);
    assert.ok(busy.top < plain.top, style);
    assert.equal(plates.plateBounds(style, plate, 2).top, plain.top * 2);
  }
});

test('groups area circles into merged shapes by colour and height', () => {
  const { groupAreaCircles } = loadModule('../renderer/scripts/instance-scene/spell-effects.ts');
  const circle = (color, z, x = 0) => ({ center: [x, 0, z], color, radius: 6, opacity: 1 });
  const groups = groupAreaCircles([circle('#a', 0), circle('#a', 3, 5), circle('#b', 0), circle('#a', 30)]);
  const summary = JSON.parse(JSON.stringify(groups.map((group) => group.map((entry) => `${entry.color}@${entry.center[2]}`).join(','))));
  assert.deepEqual(summary.sort(), ['#a@0,#a@3', '#a@30', '#b@0']);
  // At most 32 circles per shape.
  const many = groupAreaCircles(Array.from({ length: 40 }, (_, index) => circle('#a', 0, index)));
  assert.deepEqual(JSON.parse(JSON.stringify(many.map((group) => group.length))), [32, 8]);
});

test('a chain links its caster to its target, then each unit its spell goes on to hit soon after', () => {
  const store = new CombatEffectStore();
  const heal = (targetGuid, ageMs = 0) => event({
    kind: 'heal', spellId: 55459, schoolMask: 8, helpful: true, targetGuid, targetCreature: false, value: 3000, ageMs,
  });
  store.push(update([
    event({ spellId: 55459, schoolMask: 8, helpful: true, targetGuid: 2, targetCreature: false }),
    heal(2), heal(3), heal(2), heal(4), event({ kind: 'heal', spellId: 55459, targetGuid: 5, targetCreature: false, periodic: true }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.chains.map(({ from, to, index }) => `${index}:${from}>${to}`)), ['0:p1>p2', '1:p2>p3', '2:p3>p4']);
  // Hits after the jump window are not jumps; links go after their time.
  store.push(update([heal(6)]), CHAIN_JUMP_MS + 1);
  store.advance(LIVE_RENDER_DELAY_MS + CHAIN_JUMP_MS + 1, tenYards);
  assert.equal(store.chains.length, 3);
  store.advance(LIVE_RENDER_DELAY_MS + CHAIN_LINK_MS, tenYards);
  assert.equal(store.chains.length, 0);
});

test('a weapon strike plays its cast art without a glow', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ spellId: 12294, schoolMask: 1 })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.casts.map(({ spellId, release, glow }) => ({ spellId, release, glow }))),
    [{ spellId: 12294, release: true, glow: false }]);
  assert.equal(store.projectiles.length, 0);
});

test('a helpful cast lands on its target as its missile arrives, and its heal plays no second impact', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ spellId: 1459, schoolMask: 64, helpful: true, targetCreature: false })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.impacts.map(({ source, target, spellId, at, kit, glow }) => ({ source, target, spellId, at, kit, glow }))),
    [{ source: 'p1', target: 'p900', spellId: 1459, at: LIVE_RENDER_DELAY_MS, kit: true, glow: false }]);

  const heal = new CombatEffectStore();
  heal.push(update([
    event({ spellId: 2061, schoolMask: 2, helpful: true, targetCreature: false }),
    event({ kind: 'heal', spellId: 2061, schoolMask: 2, value: 900, targetCreature: false, ageMs: -100 }),
  ]), 0);
  heal.advance(LIVE_RENDER_DELAY_MS + 100, tenYards);
  // The cast's landing plays the art; the heal keeps its glow and number.
  assert.deepEqual(plain(heal.impacts.map(({ kit, glow }) => ({ kit, glow }))), [{ kit: true, glow: false }, { kit: false, glow: true }]);
  assert.equal(heal.numbers.length, 1);

  // A missile's landing waits for it; harmful casts wait for their hit.
  const bolt = new CombatEffectStore();
  bolt.push(update([event({ helpful: true, missileSpeed: 20, targetCreature: false }), event({ sourceGuid: 2, missileSpeed: 20 })]), 0);
  bolt.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(bolt.impacts.map(({ source, at }) => ({ source, at }))), [{ source: 'p1', at: LIVE_RENDER_DELAY_MS + 500 }]);
});

test('an area carries its missile speed, for its impact art to wait on', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ area: true, radius: 8, point: [10, 20, 30], targetGuid: 0, missileSpeed: 25 })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.areas[0].missileSpeed, 25);
});

test('a channel at a target holds a chain link until it ends or is cancelled', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ spellId: 47857, schoolMask: 32, channeled: true, value: 5000 })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.chains.map(({ caster, from, to, index, endAt }) => ({ caster, from, to, index, endAt }))),
    [{ caster: 'p1', from: 'p1', to: 'c900', index: 0, endAt: LIVE_RENDER_DELAY_MS + 5000 }]);
  // Past the usual link time, it holds.
  store.advance(LIVE_RENDER_DELAY_MS + 4000, tenYards);
  assert.equal(store.chains.length, 1);
  store.push(update([event({ kind: 'castCancel', spellId: 47857, schoolMask: 32 })]), 4000);
  store.advance(4000 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.chains.length, 0);
});
