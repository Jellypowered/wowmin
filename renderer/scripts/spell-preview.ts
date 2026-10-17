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

import { SpellEffectLayer, type UnitAnchorRole } from './instance-scene/spell-effects';
import { SpellVisualLayer } from './instance-scene/spell-visual-layer';
import { type UnitModelPose, UnitModelLayer } from './instance-scene/unit-models';
import type { StreamCombatEvent } from '../../src/types/api';
import { PARTICLE_GROUND_DEPTH } from './utils/m2-tracks';
import { CombatEffectStore, type Point3, type UnitKey } from './utils/spell-events';

// Spell preview (dev tool, /spell-preview): plays one spell on a loop between
// a caster and a target, close up, so its effects can be compared with the
// client's. Query or form: spell, speed (missile yards/s), cast (ms), channel
// (ms; a channelled spell instead of a missile), bolt (a spell the channel
// fires each second, flying at `speed`), area (radius), lasting (ms, a
// lasting area), ground (the area on the target's ground), aura (ms the
// spell's aura stays on the target), caster (a creature display), heal.

const CASTER: UnitKey = 'p1';
const TARGET: UnitKey = 'c2';
const ALLY: UnitKey = 'p3';
const GNOME_URL = 'assets/models/character/7-0-0-0-1-1-1-0-0.0.0.1867.0.0.0.0.0.0.472.0.0.0.glb';
// The caster: the gnome mage, or a creature display (form or query `caster`).
const casterUrl = (): string => {
  const display = Number(field('caster').value) || 0;
  return display > 0 ? `assets/models/creature/${display}.glb` : GNOME_URL;
};
const TARGET_URL = 'assets/models/creature/23561.glb';
const ALLY_URL = 'assets/models/character/1-0-2-1-3-2-2-0-1128.1060.0.9674.51619.1184.3415.0.2952.13963.2806.32558.0.0.glb';
const MIN_LOOP_MS = 5000;
const DEFAULT_HEIGHT = 2;

const positions = new Map<UnitKey, Point3>([[CASTER, [0, 0, 0]], [TARGET, [14, 0, 0]], [ALLY, [5, 4, 0]]]);
const facing = new Map<UnitKey, number>([[CASTER, 0], [TARGET, Math.PI], [ALLY, -Math.PI / 2]]);

const form = document.getElementById('preview-form') as HTMLFormElement;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const params = new URLSearchParams(window.location.search);
for (const name of ['spell', 'speed', 'cast', 'channel', 'bolt', 'area', 'lasting', 'aura', 'caster', 'rate']) {
  const value = params.get(name);
  if (value !== null) field(name).value = value;
}
if (params.has('heal')) field('heal').checked = params.get('heal') !== '0';
if (params.has('ground')) field('ground').checked = params.get('ground') !== '0';
if (params.has('glows')) field('glows').checked = params.get('glows') !== '0';

const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
const scene = new Scene();
scene.background = new Color(0x0b1220);
scene.add(new AmbientLight(0xffffff, 2.2));
const sun = new DirectionalLight(0xffffff, 1.6);
sun.position.set(0.4, 1, 0.6);
scene.add(sun);
const grid = new GridHelper(40, 40, 0x334155, 0x1e293b);
grid.position.set(7, 0, 0);
scene.add(grid);
const camera = new PerspectiveCamera(40, 1, 0.1, 500);
camera.position.set(7, 6, 12);
const controls = new OrbitControls(camera, canvas);
controls.target.set(7, 1.5, 0);
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
    style: id === TARGET ? 'melee' : 'cast',
    weapons: { mainHandType: id === CASTER ? 17 : 0, mainHandSubclass: 10, offHandType: 0, rangedSubclass: 0 },
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
let nextLoopAt = 0;

// Schedules one play of the spell from `at`; returns how long it takes.
function scheduleLoop(at: number): number {
  const spellId = Number(field('spell').value) || 0;
  const speed = Math.max(0, Number(field('speed').value) || 0);
  const castMs = Math.max(0, Number(field('cast').value) || 0);
  const channelMs = Math.max(0, Number(field('channel').value) || 0);
  const radius = Math.max(0, Number(field('area').value) || 0);
  const lastingMs = Math.max(0, Number(field('lasting').value) || 0);
  const ground = field('ground').checked;
  const auraMs = Math.max(0, Number(field('aura').value) || 0);
  const length = Math.max(MIN_LOOP_MS, castMs + Math.max(channelMs, lastingMs, auraMs) + 3000);
  const heal = field('heal').checked;
  const target = heal ? { targetGuid: 3, targetCreature: false } : { targetGuid: 2, targetCreature: true };
  const [from, to] = [positions.get(CASTER)!, positions.get(heal ? ALLY : TARGET)!];
  const travel = speed > 0 ? Math.hypot(to[0] - from[0], to[1] - from[1]) / speed * 1000 : 0;
  // The store plays events LIVE_RENDER_DELAY_MS after they arrive; ageMs
  // backdates them so they play at the times below.
  const push = (time: number, fields: Partial<StreamCombatEvent>) => {
    setTimeoutVirtual(time, () => store.push({ mapId: 0, instanceId: 0, serverTimeMs: 0, dropped: 0, events: [event({ spellId, ...target, ...fields })] }, virtualNow));
  };
  if (castMs > 0) push(at, { kind: 'castStart', value: castMs, helpful: heal });
  if (radius > 0) {
    // An area spell: at the target's feet, or round the caster.
    const point = positions.get(ground ? TARGET : CASTER)!;
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
    const bolt = Number(field('bolt').value) || 0;
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
    auraWindows.push({ unit: heal ? ALLY : TARGET, spellId, from: at + castMs + travel, to: at + castMs + travel + auraMs });
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

function frame(): void {
  const real = performance.now();
  const rate = Math.max(0.05, Number(field('rate').value) || 1);
  virtualNow += (real - lastReal) * rate;
  lastReal = real;
  if (virtualNow >= nextLoopAt) nextLoopAt += scheduleLoop(nextLoopAt);
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
  units.update([CASTER, TARGET, ALLY].map((id) => ({
    ...pose(id, id === CASTER ? casterUrl() : id === TARGET ? TARGET_URL : ALLY_URL),
    strike: strikes.get(id) ?? null,
    kitLoop: animations.get(id)?.loop ?? null,
    kitOnce: animations.get(id)?.once ?? null,
  })), virtualNow);
  visuals.update(store, virtualNow, {
    anchor,
    attachment: (unit, attachment, offset) => units.attachmentOf(unit, attachment, offset),
    isDrawn: (unit) => units.isDrawn(unit),
    scale: (unit) => units.scaleOf(unit) ?? 1,
    height: (unit) => units.heightOf(unit) ?? 2,
    facing: (unit) => facing.get(unit) ?? 0,
    // No scene: falling models land on the preview's flat floor, and the
    // ground is that floor (z 0).
    ground: (center, target) => [target[0], target[1], center[2]],
    releaseMs: (unit, clip) => units.releaseMsOf(unit, clip),
    intersect: (from, to) => (from[2] >= 0 && to[2] < 0 ? from[2] / (from[2] - to[2]) : null),
    blades: (unit) => units.bladesOf(unit),
    effectScales: (unit) => units.effectScalesOf(unit),
    attachmentTurn: (unit, attachment) => units.attachmentTurnOf(unit, attachment),
    creatureTypeFlags: () => 0,
  }, camera, currentAuras(virtualNow));
  glows.update(field('glows').checked ? store : null, virtualNow, anchor, (entry) => visuals.handles(entry));
  renderer.render(scene, camera);
  const status = document.getElementById('preview-status');
  if (status) status.textContent = `effects ${visuals.count} · particles ${visuals.particles}`;
  requestAnimationFrame(frame);
}

form.addEventListener('submit', (submitted) => {
  submitted.preventDefault();
  store.clear();
  timers.length = 0;
  auraWindows.length = 0;
  nextLoopAt = virtualNow;
});
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const preset = JSON.parse(button.dataset.preset!) as Record<string, number | boolean>;
    for (const name of ['spell', 'speed', 'cast', 'channel', 'bolt', 'area', 'lasting', 'aura', 'caster']) field(name).value = String(preset[name] ?? 0);
    field('heal').checked = Boolean(preset.heal);
    field('ground').checked = Boolean(preset.ground);
    form.requestSubmit();
  });
});
requestAnimationFrame(frame);
