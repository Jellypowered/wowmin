import { type Camera, Group } from 'three';

import type { Point3 } from '../utils/spell-events';
import { useServerAxes } from './iso-camera';
import { EffectInstance, type EffectTemplate, EffectTemplateCache, type EffectView, getEffectView } from './m2-effect';

// Game objects (battleground banners and flags, doors, chests) as the
// client's models, from the module's game object lists: each plays its idle
// loop (a banner waves, an aura glows) where the server put it, and goes
// when the server despawns it, so banners follow who holds a node. Models are
// built from the client like spell effects (assets/models/gameobject/<id>.glb).

export interface GameObjectPose {
  guid: number;
  displayId: number;
  position: Point3;
  // Turn about Z, in radians.
  yaw: number;
  scale: number;
}

const PARTICLE_BUDGET = 3000;

export class GameObjectLayer {
  readonly group = new Group();
  // No template for a display without a model (a building, an invisible marker).
  private readonly templates: EffectTemplateCache;
  private readonly shown = new Map<number, { displayId: number; instance: EffectInstance }>();

  // `groundBelow` finds the ground for particles that start on it.
  constructor(onLoaded: () => void, private readonly groundBelow: EffectView['ground'] = null) {
    this.templates = new EffectTemplateCache(onLoaded);
    useServerAxes(this.group);
  }

  get count(): number {
    return this.shown.size;
  }

  update(poses: GameObjectPose[], now: number, camera: Camera): void {
    // Effects bring their own nodes up to date; the scene view does the rest.
    this.group.updateWorldMatrix(true, false);
    const view = getEffectView(camera, this.group, this.groundBelow);
    const budget = { left: PARTICLE_BUDGET };
    const wanted = new Set<number>();
    for (const pose of poses) {
      const template = this.template(pose.displayId);
      if (!template) continue;
      wanted.add(pose.guid);
      let entry = this.shown.get(pose.guid);
      if (entry && entry.displayId !== pose.displayId) {
        this.remove(pose.guid);
        entry = undefined;
      }
      if (!entry) {
        const instance = new EffectInstance(template, now, true);
        this.group.add(instance.root, instance.particles);
        entry = { displayId: pose.displayId, instance };
        this.shown.set(pose.guid, entry);
      }
      entry.instance.update(now, { position: pose.position, yaw: pose.yaw, scale: pose.scale }, view, this.group, budget);
    }
    for (const guid of [...this.shown.keys()]) if (!wanted.has(guid)) this.remove(guid);
  }

  private remove(guid: number): void {
    this.shown.get(guid)?.instance.dispose();
    this.shown.delete(guid);
  }

  private template(displayId: number): EffectTemplate | null | undefined {
    return this.templates.get(`assets/models/gameobject/${displayId}.glb`);
  }
}
