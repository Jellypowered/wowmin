import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { serverToThree } from './instance-scene/iso-camera';
import { skyEffectLight } from './instance-scene/m2-effect';
import { SpellEffectLayer, type UnitAnchorRole } from './instance-scene/spell-effects';
import { SpellVisualLayer } from './instance-scene/spell-visual-layer';
import { clientLight, NEUTRAL_LIGHT, type UnitModelPose, UnitModelLayer } from './instance-scene/unit-models';
import type { StreamCombatEvent } from '../../src/types/api';
import { PARTICLE_GROUND_DEPTH } from './utils/m2-tracks';
import {
  fetchMapLights, floorLight, INDOOR_LIGHT_DIRECTION, indoorLight, type LightColors, lightAt, type MapLights, type Rgb, sunDirection,
} from './utils/map-light';
import { CombatEffectStore, type Point3, type UnitKey, unitKey } from './utils/spell-events';

// Spell preview (dev tool, /spell-preview): plays one spell on a loop between
// a caster and a target, close up, so its effects can be compared with the
// client's. Query or form: spell, speed (missile yards/s), cast (ms), channel
// (ms; a channelled spell instead of a missile), bolt (a spell the channel
// fires each second, flying at `speed`), area (radius), lasting (ms, a
// lasting area), ground (the area on the target's ground), aura (ms the
// spell's aura stays on the target), caster (a creature display), heal,
// lighting (neutral, sky: the client's light of lightMap's sky at noon, or
// indoor: the client's light from Utgarde Keep's forge floor).
//
// Stress mode, from the query only: `stress=N` plays N casters, each with
// its target and ally, on a ring, triple k playing preset k of `presets`
// (button names, comma separated) in turn, its loop 400 ms after the last.
// The status line, and the canvas's dataset for scripts, give frame time,
// effects, particles, draw calls, textures, and heap once a second.

const GNOME_URL = 'assets/models/character/7-0-0-0-1-1-1-0-0.0.0.1867.0.0.0.0.0.0.472.0.0.0.glb';
const TARGET_URL = 'assets/models/creature/23561.glb';
const ALLY_URL = 'assets/models/character/1-0-2-1-3-2-2-0-1128.1060.0.9674.51619.1184.3415.0.2952.13963.2806.32558.0.0.glb';
const MIN_LOOP_MS = 5000;
const DEFAULT_HEIGHT = 2;
// The target stands this far ahead of its caster, the ally ahead and to
// its left.
const TARGET_DISTANCE = 14;
const ALLY_OFFSET: [number, number] = [5, 4];
const STRESS_MIN_RADIUS = 12;
const STRESS_RADIUS_PER_TRIPLE = 1.2;
const STRESS_LOOP_OFFSET_MS = 400;
const DEFAULT_STRESS_PRESETS = ['Frostbolt', 'Fireball', 'Shadow Bolt', 'Holy Light', 'Arcane Missiles', 'Consecration', 'Flamestrike', 'Immolate',
  'Renew', 'Power Word: Shield'];
const STATS_INTERVAL_MS = 1000;
// The client's lights the preview can show units and effects in: noon, and
// the forge floor's vertex colour (Utgarde Keep, group 22843).
const NOON = 1440;
const FORGE_FLOOR: Rgb = [108 / 255, 80 / 255, 56 / 255];

// What one play of a spell is: the form's fields, or a preset's.
interface Preset {
  spell: number;
  speed: number;
  cast: number;
  channel: number;
  bolt: number;
  area: number;
  lasting: number;
  aura: number;
  caster: number;
  heal: boolean;
  ground: boolean;
}

// A caster, its target, and its ally, and what they play (null: the form).
interface Triple {
  caster: UnitKey;
  target: UnitKey;
  ally: UnitKey;
  guids: [number, number, number];
  preset: Preset | null;
  nextLoopAt: number;
  offsetMs: number;
}

const form = document.getElementById('preview-form') as HTMLFormElement;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const params = new URLSearchParams(window.location.search);
const NUMBER_FIELDS = ['spell', 'speed', 'cast', 'channel', 'bolt', 'area', 'lasting', 'aura', 'caster'] as const;
const formPreset = (): Preset => ({
  ...Object.fromEntries(NUMBER_FIELDS.map((name) => [name, Number(field(name).value) || 0])) as Record<typeof NUMBER_FIELDS[number], number>,
  heal: field('heal').checked,
  ground: field('ground').checked,
});
const presetButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-preset]')];
// A preset button's spell (its data-preset JSON), fields it leaves out 0.
const presetOf = (button: HTMLButtonElement): Preset => {
  const preset = JSON.parse(button.dataset.preset!) as Record<string, number | boolean>;
  return {
    ...Object.fromEntries(NUMBER_FIELDS.map((key) => [key, Number(preset[key] ?? 0)])) as Record<typeof NUMBER_FIELDS[number], number>,
    heal: Boolean(preset.heal),
    ground: Boolean(preset.ground),
  };
};
const namedPreset = (name: string): Preset | null => {
  const button = presetButtons.find((candidate) => candidate.textContent?.trim().toLowerCase() === name.trim().toLowerCase());
  return button ? presetOf(button) : null;
};
// The ring's radius for `count` casters.
const ringRadius = (count: number): number => Math.max(STRESS_MIN_RADIUS, count * STRESS_RADIUS_PER_TRIPLE);

// The caster: the gnome mage, or a creature display.
const casterUrl = (preset: Preset): string => (preset.caster > 0 ? `assets/models/creature/${preset.caster}.glb` : GNOME_URL);

const positions = new Map<UnitKey, Point3>();
const facing = new Map<UnitKey, number>();
const urls = new Map<UnitKey, () => string>();
const triples: Triple[] = [];
// Triple k stands at angle 2πk/N on the ring, facing out, its target
// further out; a single triple stands at the origin facing +X.
function addTriple(index: number, count: number, preset: Preset | null): void {
  const angle = count > 1 ? (2 * Math.PI * index) / count : 0;
  const radius = count > 1 ? ringRadius(count) : 0;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const guids: [number, number, number] = [1 + 3 * index, 2 + 3 * index, 3 + 3 * index];
  const triple: Triple = {
    caster: unitKey(guids[0], false), target: unitKey(guids[1], true), ally: unitKey(guids[2], false), guids, preset,
    nextLoopAt: index * STRESS_LOOP_OFFSET_MS, offsetMs: index * STRESS_LOOP_OFFSET_MS,
  };
  positions.set(triple.caster, [radius * cos, radius * sin, 0]);
  positions.set(triple.target, [(radius + TARGET_DISTANCE) * cos, (radius + TARGET_DISTANCE) * sin, 0]);
  positions.set(triple.ally, [radius * cos + ALLY_OFFSET[0] * cos - ALLY_OFFSET[1] * sin, radius * sin + ALLY_OFFSET[0] * sin + ALLY_OFFSET[1] * cos, 0]);
  facing.set(triple.caster, angle);
  facing.set(triple.target, angle + Math.PI);
  facing.set(triple.ally, angle - Math.PI / 2);
  urls.set(triple.caster, () => casterUrl(triple.preset ?? formPreset()));
  urls.set(triple.target, () => TARGET_URL);
  urls.set(triple.ally, () => ALLY_URL);
  triples.push(triple);
}
for (const name of [...NUMBER_FIELDS, 'rate', 'lightMap']) {
  const value = params.get(name);
  if (value !== null) field(name).value = value;
}
if (params.has('heal')) field('heal').checked = params.get('heal') !== '0';
if (params.has('ground')) field('ground').checked = params.get('ground') !== '0';
if (params.has('glows')) field('glows').checked = params.get('glows') !== '0';
if (params.has('lighting')) (form.elements.namedItem('lighting') as HTMLSelectElement).value = params.get('lighting')!;

const stress = Math.max(0, Math.floor(Number(params.get('stress')) || 0));
if (stress > 0) {
  const names = params.get('presets')?.split(',').filter((name) => name.trim()) ?? DEFAULT_STRESS_PRESETS;
  const presets = names.map((name) => {
    const preset = namedPreset(name);
    if (!preset) console.warn(`No spell preview preset named ${name}`);
    return preset;
  }).filter((preset): preset is Preset => Boolean(preset));
  if (!presets.length) presets.push(formPreset());
  for (let index = 0; index < stress; index += 1) addTriple(index, stress, presets[index % presets.length]);
} else {
  addTriple(0, 1, null);
}
const casters = new Set(triples.map((triple) => triple.caster));
const targets = new Set(triples.map((triple) => triple.target));

const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
const scene = new Scene();
scene.background = new Color(0x0b1220);
const ambientLight = new AmbientLight(0xffffff, NEUTRAL_LIGHT.ambient);
scene.add(ambientLight);
const sun = new DirectionalLight(0xffffff, NEUTRAL_LIGHT.sun);
sun.position.set(...NEUTRAL_LIGHT.sunPosition);
scene.add(sun);
// The ring's reach, for the floor and camera in stress mode.
const reach = stress > 0 ? ringRadius(stress) + TARGET_DISTANCE + 4 : 0;
const gridSize = stress > 0 ? Math.ceil(reach * 2) : 40;
const grid = new GridHelper(gridSize, gridSize, 0x334155, 0x1e293b);
grid.position.set(stress > 0 ? 0 : 7, 0, 0);
scene.add(grid);
const camera = new PerspectiveCamera(40, 1, 0.1, 500 + reach * 4);
const controls = new OrbitControls(camera, canvas);
if (stress > 0) {
  camera.position.set(0, reach * 1.6, reach * 1.6);
  controls.target.set(0, 1.5, 0);
} else {
  camera.position.set(7, 6, 12);
  controls.target.set(7, 1.5, 0);
}
controls.update();

const units = new UnitModelLayer(() => {});
const glows = new SpellEffectLayer();
// The ground is the preview's flat floor (z 0).
const visuals = new SpellVisualLayer(() => {}, (point) => (point[2] >= 0 && point[2] <= PARTICLE_GROUND_DEPTH ? 0 : null));
scene.add(units.group, glows.group, visuals.group);
const store = new CombatEffectStore();

const anchor = (unit: UnitKey, role: UnitAnchorRole): Point3 | null => {
  const feet = positions.get(unit);
  if (!feet) return null;
  if (role === 'feet') return feet;
  const point = units.pointOf(unit, role);
  if (point) return point;
  const height = units.heightOf(unit) ?? DEFAULT_HEIGHT;
  return [feet[0], feet[1], feet[2] + height * (role === 'overhead' ? 1.1 : role === 'head' || role === 'breath' ? 0.9 : 0.6)];
};

function pose(id: UnitKey, url: string): UnitModelPose {
  const [x, y, z] = positions.get(id)!;
  return {
    id, url, x, y, z, orientation: facing.get(id)!, scale: 1, alive: true, inCombat: true,
    style: targets.has(id) ? 'melee' : 'cast',
    weapons: { mainHandType: casters.has(id) ? 17 : 0, mainHandSubclass: 10, offHandType: 0, rangedSubclass: 0 },
    sheathState: 1, marker: { color: '#38bdf8', inCombat: false, selected: false, healthPct: null }, eventDriven: true,
  };
}

function event(fields: Partial<StreamCombatEvent>): StreamCombatEvent {
  return {
    kind: 'castGo', sourceGuid: 1, sourceCreature: false, targetGuid: 2, targetCreature: true, spellId: 0, schoolMask: 0,
    auraCategory: null, value: 0, missileSpeed: 0, radius: 0, point: null, area: false, channeled: false, periodic: false,
    helpful: false, triggered: false, persistentArea: false, ageMs: 0, ...fields,
  };
}

// Virtual time, so the whole scene can run slowed down.
let virtualNow = 0;
let lastReal = performance.now();

// Schedules one play of the triple's spell from `at`; returns how long it
// takes.
function scheduleLoop(triple: Triple, at: number): number {
  const preset = triple.preset ?? formPreset();
  const spellId = preset.spell;
  const speed = Math.max(0, preset.speed);
  const castMs = Math.max(0, preset.cast);
  const channelMs = Math.max(0, preset.channel);
  const radius = Math.max(0, preset.area);
  const lastingMs = Math.max(0, preset.lasting);
  const ground = preset.ground;
  const auraMs = Math.max(0, preset.aura);
  const length = Math.max(MIN_LOOP_MS, castMs + Math.max(channelMs, lastingMs, auraMs) + 3000);
  const heal = preset.heal;
  const [casterGuid, targetGuid, allyGuid] = triple.guids;
  const target = heal ? { targetGuid: allyGuid, targetCreature: false } : { targetGuid, targetCreature: true };
  const [from, to] = [positions.get(triple.caster)!, positions.get(heal ? triple.ally : triple.target)!];
  const travel = speed > 0 ? Math.hypot(to[0] - from[0], to[1] - from[1]) / speed * 1000 : 0;
  // The store plays events LIVE_RENDER_DELAY_MS after they arrive; ageMs
  // backdates them so they play at the times below.
  const push = (time: number, fields: Partial<StreamCombatEvent>) => {
    setTimeoutVirtual(time, () => store.push({ mapId: 0, instanceId: 0, serverTimeMs: 0, dropped: 0, events: [event({ spellId, sourceGuid: casterGuid, ...target, ...fields })] }, virtualNow));
  };
  if (castMs > 0) push(at, { kind: 'castStart', value: castMs, helpful: heal });
  if (radius > 0) {
    // An area spell: at the target's feet, or round the caster.
    const point = positions.get(ground ? triple.target : triple.caster)!;
    push(at + castMs, {
      kind: 'castGo', area: true, radius, point: [...point], channeled: channelMs > 0, persistentArea: lastingMs > 0,
      value: channelMs || lastingMs, targetGuid: 0, helpful: heal,
    });
    for (let tick = 1000; tick <= Math.max(channelMs, lastingMs); tick += 1000) {
      push(at + castMs + tick, { kind: 'damage', value: 300, helpful: false });
    }
    return length;
  }
  if (channelMs > 0) {
    push(at + castMs, { kind: 'castGo', channeled: true, value: channelMs, helpful: heal });
    const bolt = preset.bolt;
    for (let tick = 1000; tick <= channelMs; tick += 1000) {
      if (bolt) {
        push(at + castMs + tick - travel, { kind: 'castGo', spellId: bolt, missileSpeed: speed, triggered: true, helpful: heal });
        push(at + castMs + tick, { kind: heal ? 'heal' : 'damage', spellId: bolt, value: 400, helpful: heal });
      } else {
        push(at + castMs + tick, { kind: heal ? 'heal' : 'damage', value: 400, helpful: heal, periodic: true });
      }
    }
    return length;
  }
  push(at + castMs, { kind: 'castGo', missileSpeed: speed, helpful: heal });
  push(at + castMs + travel, { kind: heal ? 'heal' : 'damage', value: 1234, helpful: heal });
  if (auraMs > 0) {
    auraWindows.push({ unit: heal ? triple.ally : triple.target, spellId, from: at + castMs + travel, to: at + castMs + travel + auraMs });
  }
  return length;
}

// Auras the loop has put on units, as the module's aura lists would say:
// a unit whose aura has just ended keeps an empty list for a moment.
const auraWindows: Array<{ unit: UnitKey; spellId: number; from: number; to: number }> = [];
const AURA_EMPTY_LIST_MS = 2000;
function currentAuras(now: number): Map<UnitKey, number[]> {
  const auras = new Map<UnitKey, number[]>();
  for (let index = auraWindows.length - 1; index >= 0; index -= 1) {
    const window = auraWindows[index];
    if (window.to + AURA_EMPTY_LIST_MS <= now) {
      auraWindows.splice(index, 1);
      continue;
    }
    if (window.to <= now) auras.set(window.unit, auras.get(window.unit) ?? []);
    else if (window.from <= now) auras.set(window.unit, [...(auras.get(window.unit) ?? []), window.spellId]);
  }
  return auras;
}

const timers: Array<{ at: number; run: () => void }> = [];
function setTimeoutVirtual(at: number, run: () => void): void {
  timers.push({ at, run });
}

// Frame times (ms of work, from the frame's start to its draw having been
// sent) since the stats were last shown.
const frameTimes: number[] = [];
let statsAt = performance.now();
const memoryOf = (): number | null => {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / 1e6 : null;
};

function showStats(real: number): void {
  if (real - statsAt < STATS_INTERVAL_MS) return;
  const seconds = (real - statsAt) / 1000;
  statsAt = real;
  const mean = frameTimes.length ? frameTimes.reduce((sum, time) => sum + time, 0) / frameTimes.length : 0;
  const max = frameTimes.reduce((most, time) => Math.max(most, time), 0);
  const fps = frameTimes.length / seconds;
  frameTimes.length = 0;
  const heap = memoryOf();
  const stats = {
    fps: fps.toFixed(1), frameMs: mean.toFixed(2), frameMaxMs: max.toFixed(2), effects: String(visuals.count), particles: String(visuals.particles),
    drawCalls: String(renderer.info.render.calls), textures: String(renderer.info.memory.textures), geometries: String(renderer.info.memory.geometries),
    heapMb: heap === null ? '' : heap.toFixed(1),
  };
  Object.assign(canvas.dataset, stats);
  const status = document.getElementById('preview-status');
  if (status) {
    status.textContent = `${stats.fps} fps · ${stats.frameMs} ms (max ${stats.frameMaxMs}) · effects ${stats.effects} · particles ${stats.particles}`
      + ` · ${stats.drawCalls} draws · ${stats.textures} textures${heap === null ? '' : ` · ${stats.heapMb} MB`}`;
  }
}

// The client's light the Lighting choice asks for, or null for neutral:
// a map's light at noon at its biggest area light (its default light if it
// has none), with the sun's way then, or the forge floor's indoor light.
const mapLights = new Map<number, MapLights | null | 'loading'>();
function chosenLight(): { colors: LightColors; towards: Point3 } | null {
  const choice = (form.elements.namedItem('lighting') as HTMLSelectElement).value;
  if (choice === 'indoor') {
    return { colors: indoorLight(floorLight(FORGE_FLOOR)), towards: INDOOR_LIGHT_DIRECTION.map((value) => -value) as Point3 };
  }
  if (choice !== 'sky') return null;
  const mapId = Number(field('lightMap').value) || 0;
  const known = mapLights.get(mapId);
  if (known === undefined) {
    mapLights.set(mapId, 'loading');
    void fetchMapLights(mapId).then((lights) => mapLights.set(mapId, lights));
  }
  if (!known || known === 'loading') return null;
  const area = known.lights.filter((light) => light.position).sort((left, right) => right.outer - left.outer)[0];
  return { colors: lightAt(known, area?.position ?? [0, 0, 0], NOON), towards: sunDirection(NOON).map((value) => -value) as Point3 };
}

// Lights units and effects by the choice: the client's light through the
// models' shared uniforms and the effects' sky light, or the preview's own.
function applyLighting(): void {
  const chosen = chosenLight();
  const on = chosen ? 1 : 0;
  ambientLight.intensity = chosen ? 0 : NEUTRAL_LIGHT.ambient;
  sun.intensity = chosen ? 0 : NEUTRAL_LIGHT.sun;
  const ambient = chosen?.colors.ambient ?? [0, 0, 0];
  const direct = chosen?.colors.direct ?? [0, 0, 0];
  const towards = serverToThree(chosen?.towards ?? [0, 0, 1]).normalize();
  // The effects' sky light shares the models' direct light and way to it.
  clientLight.ambient.set(...ambient, on);
  clientLight.direct.set(...direct, on);
  skyEffectLight.ambient.set(...ambient, on);
  skyEffectLight.upward = Math.max(0, towards.y);
  towards.transformDirection(camera.matrixWorldInverse);
  clientLight.sun.copy(towards);
  clientLight.indoor.copy(towards);
}

function frame(): void {
  const real = performance.now();
  const rate = Math.max(0.05, Number(field('rate').value) || 1);
  virtualNow += (real - lastReal) * rate;
  lastReal = real;
  for (const triple of triples) if (virtualNow >= triple.nextLoopAt) triple.nextLoopAt += scheduleLoop(triple, triple.nextLoopAt);
  for (let index = timers.length - 1; index >= 0; index -= 1) {
    if (timers[index].at <= virtualNow) {
      timers[index].run();
      timers.splice(index, 1);
    }
  }
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.floor(width * renderer.getPixelRatio()) || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }
  const cues = store.advance(virtualNow, (a, b) => {
    const from = positions.get(a);
    const to = positions.get(b);
    return from && to ? Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) : null;
  });
  const strikes = new Map(cues.map((cue) => [cue.unit, cue.kind] as const));
  const animations = visuals.takeAnimations();
  units.update([...urls].map(([id, url]) => ({
    ...pose(id, url()),
    strike: strikes.get(id) ?? null,
    kitLoop: animations.get(id)?.loop ?? null,
    kitOnce: animations.get(id)?.once ?? null,
  })), virtualNow);
  visuals.update(store, virtualNow, {
    anchor,
    attachment: (unit, attachment, offset) => units.attachmentOf(unit, attachment, offset),
    isDrawn: (unit) => units.isDrawn(unit),
    scale: (unit) => units.scaleOf(unit) ?? 1,
    height: (unit) => units.heightOf(unit) ?? DEFAULT_HEIGHT,
    facing: (unit) => facing.get(unit) ?? 0,
    // No scene: falling models land on the preview's flat floor, and the
    // ground is that floor (z 0).
    ground: (center, target) => [target[0], target[1], center[2]],
    releaseMs: (unit, clip) => units.releaseMsOf(unit, clip),
    intersect: (from, to) => (from[2] >= 0 && to[2] < 0 ? from[2] / (from[2] - to[2]) : null),
    blades: (unit) => units.bladesOf(unit),
    effectScales: (unit) => units.effectScalesOf(unit),
    light: () => null,
    attachmentTurn: (unit, attachment, out) => units.attachmentTurnOf(unit, attachment, out),
    creatureTypeFlags: () => 0,
  }, camera, currentAuras(virtualNow));
  const aids = field('glows').checked;
  glows.update(store, virtualNow, anchor, (entry) => visuals.handles(entry), { glows: aids, circles: aids });
  camera.updateMatrixWorld();
  applyLighting();
  renderer.render(scene, camera);
  frameTimes.push(performance.now() - real);
  showStats(real);
  requestAnimationFrame(frame);
}

form.addEventListener('submit', (submitted) => {
  submitted.preventDefault();
  store.clear();
  timers.length = 0;
  auraWindows.length = 0;
  for (const triple of triples) triple.nextLoopAt = virtualNow + triple.offsetMs;
});
presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const preset = presetOf(button);
    for (const name of NUMBER_FIELDS) field(name).value = String(preset[name]);
    field('heal').checked = preset.heal;
    field('ground').checked = preset.ground;
    form.requestSubmit();
  });
});
requestAnimationFrame(frame);
