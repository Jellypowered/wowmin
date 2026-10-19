import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, SRGBColorSpace } from 'three';

import type { Point3, UnitKey } from '../utils/spell-events';
import type { WeaponTrail } from '../utils/spell-kits';

// Draws the trails a unit's drawn weapons leave through a swing (kit
// procedure 8: Heroic Strike, Cleave, Rend), as the client draws them: the
// blade, from its bottom to its top, swept into an untextured strip in the
// kit's colour while the trail lasts; the strip keeps the last moment of
// the sweep, fainter towards its old end, and fades away over the second
// half of the trail's time. In the spell layer's server coordinates.

// The strip keeps this much of the sweep (ms), and fades by this much of its
// opacity a millisecond after half its time.
const TRAIL_SPAN_MS = 300;
const MAX_PAIRS = 128;
const MIN_ALPHA = 2 / 255;
const RENDER_ORDER = 4;

// A blade's bottom and top at one moment of its sweep, and when (ms).
interface SweepPair {
  at: number;
  bottom: Point3;
  top: Point3;
}

interface Swing {
  trail: WeaponTrail;
  startAt: number;
  lastAt: number;
  alpha: number;
  // Per blade: its sweep so far, newest last.
  sweeps: SweepPair[][];
  meshes: Array<Mesh<BufferGeometry, MeshBasicMaterial>>;
}

const vertexColor = new Color();

// An untextured strip with room for a whole sweep, a quad between each pair
// and the next, coloured per vertex.
function createTrailMesh(): Mesh<BufferGeometry, MeshBasicMaterial> {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(MAX_PAIRS * 2 * 3), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(MAX_PAIRS * 2 * 4), 4));
  const quads: number[] = [];
  for (let pair = 0; pair + 1 < MAX_PAIRS; pair += 1) {
    const at = pair * 2;
    quads.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
  }
  geometry.setIndex(quads);
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide }));
  mesh.renderOrder = RENDER_ORDER;
  mesh.frustumCulled = false;
  return mesh;
}

export class WeaponTrails {
  readonly group = new Group();
  private readonly swings = new Map<UnitKey, Swing>();

  get count(): number {
    return this.swings.size;
  }

  // Starts a trail on a unit's weapons, replacing any it has.
  start(unit: UnitKey, trail: WeaponTrail, now: number): void {
    this.end(unit);
    this.swings.set(unit, { trail, startAt: now, lastAt: now, alpha: trail.alpha, sweeps: [], meshes: [] });
  }

  // Sweeps each trail on with its unit's blades now (bottom and top), and
  // ends faded ones.
  update(now: number, blades: (unit: UnitKey) => Array<[Point3, Point3]>): void {
    for (const [unit, swing] of this.swings) {
      const elapsed = now - swing.startAt;
      const delta = Math.max(0, now - swing.lastAt);
      swing.lastAt = now;
      if (elapsed > swing.trail.durationMs / 2) swing.alpha *= Math.max(0, 1 - delta / TRAIL_SPAN_MS);
      if (swing.alpha < MIN_ALPHA) {
        this.end(unit);
        continue;
      }
      const held = blades(unit);
      held.forEach(([bottom, top], index) => {
        const sweep = swing.sweeps[index] ?? (swing.sweeps[index] = []);
        if (elapsed < swing.trail.durationMs) sweep.push({ at: now, bottom, top });
        while (sweep.length && (now - sweep[0].at > TRAIL_SPAN_MS || sweep.length > MAX_PAIRS)) sweep.shift();
      });
      swing.sweeps.forEach((sweep, index) => this.draw(swing, index, sweep, now));
    }
  }

  private draw(swing: Swing, index: number, sweep: SweepPair[], now: number): void {
    let mesh = swing.meshes[index];
    if (!mesh) {
      mesh = createTrailMesh();
      swing.meshes[index] = mesh;
      this.group.add(mesh);
    }
    const positions = mesh.geometry.getAttribute('position') as BufferAttribute;
    const colors = mesh.geometry.getAttribute('color') as BufferAttribute;
    vertexColor.setHex(swing.trail.color, SRGBColorSpace);
    sweep.forEach(({ at, bottom, top }, pair) => {
      const alpha = swing.alpha * Math.max(0, 1 - (now - at) / TRAIL_SPAN_MS);
      positions.setXYZ(pair * 2, ...bottom);
      positions.setXYZ(pair * 2 + 1, ...top);
      colors.setXYZW(pair * 2, vertexColor.r, vertexColor.g, vertexColor.b, alpha);
      colors.setXYZW(pair * 2 + 1, vertexColor.r, vertexColor.g, vertexColor.b, alpha);
    });
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    mesh.geometry.setDrawRange(0, Math.max(0, sweep.length - 1) * 6);
    mesh.visible = sweep.length >= 2;
  }

  private end(unit: UnitKey): void {
    const swing = this.swings.get(unit);
    if (!swing) return;
    for (const mesh of swing.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.swings.delete(unit);
  }
}
