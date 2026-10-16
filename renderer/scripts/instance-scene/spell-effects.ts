import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three';

import {
  type AreaRing,
  type Beam,
  type CastGlow,
  type CombatEffectStore,
  type Impact,
  IMPACT_LIFETIME_MS,
  type Point3,
  type Projectile,
  type UnitKey,
} from '../utils/spell-events';
import { useServerAxes } from './iso-camera';

// Draws the combat effect store's live effects as glowing additive sprites
// and floor rings, in server coordinates under a Z-up group like the unit
// models. Effects are drawn without depth testing, like the unit floor rings,
// so walls never hide them.

// Where on a unit an effect sits.
export type { UnitAnchorRole } from '../utils/spell-kits';
import type { UnitAnchorRole } from '../utils/spell-kits';

// A unit's anchor point in server coordinates, or null if it isn't shown.
export type UnitAnchor = (unit: UnitKey, role: UnitAnchorRole) => Point3 | null;

const EFFECT_RENDER_ORDER = 3;
const RING_LIFT = 0.08;
// Area rings of one colour at about one height are drawn as one shape: a
// faint fill, and a thin outline only along the outer edge of the union
// (overlapping ghouls' taunts read as one area). Up to this many per shape.
const MAX_UNION_CIRCLES = 32;
// Areas further apart in height than this (other floors) are drawn apart.
const AREA_MERGE_HEIGHT = 8;
const AREA_FILL_STRENGTH = 0.07;
const AREA_EDGE_STRENGTH = 0.5;
const BEAM_SPACING = 1.2;
const MAX_BEAM_SPRITES = 40;
const TRAIL_SPRITES = 3;
// WowMin's own spell aids, which aren't the client's art, each shown or
// not: the glows (casts, beams, missiles, and hits of spells without art),
// and the floor circles (harmful areas, taunts, and steady areas round an
// aura's bearer).
export interface SpellAids {
  glows: boolean;
  circles: boolean;
}

export const ALL_SPELL_AIDS: SpellAids = { glows: true, circles: true };

const NO_EFFECTS: Pick<CombatEffectStore, 'casts' | 'beams' | 'projectiles' | 'impacts' | 'rings'> = {
  casts: [], beams: [], projectiles: [], impacts: [], rings: [],
};

function createGlowTexture(): Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

const lerp = (from: Point3, to: Point3, t: number): Point3 =>
  [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

interface AreaCircle {
  center: Point3;
  radius: number;
  color: string;
  opacity: number;
}

// Plain GLSL: the shape's quad carries server coordinates, and each pixel
// finds its signed distance to the union of the circles (negative inside).
// The outline is about 1.5 pixels wide at any zoom.
const AREA_VERTEX = `
varying vec2 vServer;
void main() {
  vServer = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const AREA_FRAGMENT = `
uniform vec3 uColor;
uniform vec3 uCircles[${MAX_UNION_CIRCLES}];
uniform float uOpacity[${MAX_UNION_CIRCLES}];
uniform int uCount;
varying vec2 vServer;
void main() {
  float distanceToEdge = 1e9;
  float edgeOpacity = 0.0;
  float fillOpacity = 0.0;
  for (int index = 0; index < ${MAX_UNION_CIRCLES}; index++) {
    if (index >= uCount) break;
    float d = length(vServer - uCircles[index].xy) - uCircles[index].z;
    if (d < distanceToEdge) {
      distanceToEdge = d;
      edgeOpacity = uOpacity[index];
    }
    if (d < 0.0) fillOpacity = max(fillOpacity, uOpacity[index]);
  }
  float pixel = max(fwidth(distanceToEdge), 1e-4);
  float inside = 1.0 - smoothstep(-pixel, pixel, distanceToEdge);
  float edge = 1.0 - smoothstep(0.75 * pixel, 1.5 * pixel, abs(distanceToEdge + pixel));
  float alpha = inside * fillOpacity * ${AREA_FILL_STRENGTH.toFixed(3)} + edge * edgeOpacity * ${AREA_EDGE_STRENGTH.toFixed(3)};
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

type AreaShape = Mesh<BufferGeometry, ShaderMaterial>;

function createAreaShape(): AreaShape {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new ShaderMaterial({
    vertexShader: AREA_VERTEX,
    fragmentShader: AREA_FRAGMENT,
    uniforms: {
      uColor: { value: new Color() },
      uCircles: { value: Array.from({ length: MAX_UNION_CIRCLES }, () => new Vector3()) },
      uOpacity: { value: new Float32Array(MAX_UNION_CIRCLES) },
      uCount: { value: 0 },
    },
    blending: AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = EFFECT_RENDER_ORDER;
  mesh.frustumCulled = false;
  return mesh;
}

// Groups area circles into shapes: one colour, heights within
// AREA_MERGE_HEIGHT, at most MAX_UNION_CIRCLES each.
export function groupAreaCircles<T extends { center: Point3; color: string }>(circles: T[]): T[][] {
  const byColor = new Map<string, T[]>();
  for (const circle of circles) {
    const list = byColor.get(circle.color) ?? [];
    list.push(circle);
    byColor.set(circle.color, list);
  }
  const groups: T[][] = [];
  for (const list of byColor.values()) {
    list.sort((left, right) => left.center[2] - right.center[2]);
    let group: T[] = [];
    for (const circle of list) {
      if (group.length && (circle.center[2] - group[0].center[2] > AREA_MERGE_HEIGHT || group.length >= MAX_UNION_CIRCLES)) {
        groups.push(group);
        group = [];
      }
      group.push(circle);
    }
    if (group.length) groups.push(group);
  }
  return groups;
}

export class SpellEffectLayer {
  readonly group = new Group();
  private readonly texture = createGlowTexture();
  private readonly sprites: Sprite[] = [];
  private readonly areaShapes: AreaShape[] = [];
  private spritesUsed = 0;
  private drawn = 0;

  constructor() {
    useServerAxes(this.group);
  }

  // Effects drawn in the last update, for the debug overlay.
  get count(): number {
    return this.drawn;
  }

  // Draws the store's effects, or none for a null store, except missiles and
  // impacts `skip` says are drawn elsewhere (the client's own art), and the
  // aids turned off.
  update(store: CombatEffectStore | null, now: number, anchor: UnitAnchor,
    skip: (entry: Projectile | Impact | CastGlow | AreaRing | Beam) => boolean = () => false, aids: SpellAids = ALL_SPELL_AIDS): void {
    this.spritesUsed = 0;
    let drawn = 0;
    const effects = store ?? NO_EFFECTS;
    const glows = aids.glows ? effects : NO_EFFECTS;

    for (const cast of glows.casts) {
      if (!cast.glow || cast.startAt > now || skip(cast)) continue;
      const right = anchor(cast.caster, 'handRight');
      if (!right) continue;
      drawn += 1;
      if (cast.release) {
        const t = clamp01((now - cast.startAt) / (cast.endAt - cast.startAt));
        this.sprite(right, cast.color, 1.6 + 1.6 * t, 1 - t);
        continue;
      }
      // Grows as the cast fills, with a gentle pulse.
      const progress = clamp01((now - cast.startAt) / Math.max(1, cast.endAt - cast.startAt));
      const size = (0.8 + 0.8 * progress) * (1 + 0.12 * Math.sin(now / 90));
      this.sprite(right, cast.color, size, 0.9);
      const left = anchor(cast.caster, 'handLeft');
      if (left) this.sprite(left, cast.color, size * 0.85, 0.75);
    }

    for (const beam of glows.beams) {
      if (beam.startAt > now || skip(beam)) continue;
      const from = anchor(beam.source, 'handRight');
      const to = anchor(beam.target, 'chest');
      if (!from || !to) continue;
      drawn += 1;
      const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      const count = Math.min(MAX_BEAM_SPRITES, Math.max(2, Math.ceil(length / BEAM_SPACING)));
      // Flows from the caster to the target.
      const flow = (now / 400) % 1;
      for (let index = 0; index < count; index += 1) {
        this.sprite(lerp(from, to, (index + flow) / count), beam.color, 0.8, 0.65);
      }
    }

    for (const projectile of glows.projectiles) {
      if (projectile.startAt > now || skip(projectile)) continue;
      const from = anchor(projectile.source, 'handRight');
      const to = anchor(projectile.target, 'chest');
      if (!from || !to) continue;
      drawn += 1;
      const t = clamp01((now - projectile.startAt) / projectile.travelMs);
      if (projectile.streak) {
        for (let index = 0; index < 4; index += 1) {
          this.sprite(lerp(from, to, clamp01(t - index * 0.12)), projectile.color, 0.9 - index * 0.15, 0.9 - index * 0.2);
        }
        continue;
      }
      const head = projectile.physical ? 0.6 : 1.4;
      this.sprite(lerp(from, to, t), projectile.color, head, 1);
      for (let index = 1; index <= TRAIL_SPRITES; index += 1) {
        const behind = clamp01(t - index * 0.05);
        this.sprite(lerp(from, to, behind), projectile.color, head * (1 - index * 0.22), 0.7 - index * 0.18);
      }
    }

    for (const impact of glows.impacts) {
      if (!impact.glow || impact.at > now || skip(impact)) continue;
      const t = clamp01((now - impact.at) / IMPACT_LIFETIME_MS);
      const scale = impact.small ? 0.5 : 1;
      if (impact.heal) {
        const feet = anchor(impact.target, 'feet');
        const top = anchor(impact.target, 'overhead');
        if (!feet || !top) continue;
        drawn += 1;
        // Sparkles rising up the body.
        for (let index = 0; index < 3; index += 1) {
          const rise = clamp01(t + index * 0.2);
          const point = lerp(feet, top, rise);
          point[0] += Math.cos(index * 2.1) * 0.35;
          point[1] += Math.sin(index * 2.1) * 0.35;
          this.sprite(point, impact.color, 0.8 * scale, (1 - t) * 0.9);
        }
        continue;
      }
      const chest = anchor(impact.target, 'chest');
      if (!chest) continue;
      drawn += 1;
      this.sprite(chest, impact.color, (1 + 2 * t) * scale, 1 - t);
    }

    const circles: AreaCircle[] = [];
    for (const area of aids.circles ? effects.rings : NO_EFFECTS.rings) {
      if (area.startAt > now || skip(area)) continue;
      const center = area.point ?? anchor(area.caster, 'feet');
      // The caster must be shown, even for a ring at a ground point.
      if (!center || !anchor(area.caster, 'feet')) continue;
      drawn += 1;
      const total = area.endAt - area.startAt;
      const elapsed = now - area.startAt;
      const left = area.endAt - now;
      // A flash fades out; a long-lived area pulses and fades at the end.
      const opacity = total <= 1000
        ? 0.85 * (1 - clamp01(elapsed / total))
        : (0.45 + 0.1 * Math.sin(now / 250)) * clamp01(left / 300) * clamp01(elapsed / 200);
      if (opacity > 0 && area.radius > 0) circles.push({ center, radius: area.radius, color: area.color, opacity });
    }
    const shapes = groupAreaCircles(circles);
    shapes.forEach((shape, index) => this.areaShape(index, shape));

    for (let index = this.spritesUsed; index < this.sprites.length; index += 1) this.sprites[index].visible = false;
    for (let index = shapes.length; index < this.areaShapes.length; index += 1) this.areaShapes[index].visible = false;
    this.drawn = drawn;
  }

  private sprite(position: Point3, color: string, size: number, opacity: number): void {
    if (opacity <= 0 || size <= 0) return;
    let sprite = this.sprites[this.spritesUsed];
    if (!sprite) {
      sprite = new Sprite(new SpriteMaterial({
        map: this.texture, blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
      }));
      sprite.renderOrder = EFFECT_RENDER_ORDER;
      sprite.frustumCulled = false;
      this.sprites.push(sprite);
      this.group.add(sprite);
    }
    this.spritesUsed += 1;
    sprite.visible = true;
    sprite.position.set(position[0], position[1], position[2]);
    sprite.scale.set(size, size, 1);
    sprite.material.color.set(color);
    sprite.material.opacity = Math.min(1, opacity);
  }

  // One merged area shape on the floor, at its circles' mean height.
  private areaShape(index: number, circles: AreaCircle[]): void {
    let shape = this.areaShapes[index];
    if (!shape) {
      shape = createAreaShape();
      this.areaShapes.push(shape);
      this.group.add(shape);
    }
    shape.visible = true;
    const minX = Math.min(...circles.map((circle) => circle.center[0] - circle.radius)) - 1;
    const maxX = Math.max(...circles.map((circle) => circle.center[0] + circle.radius)) + 1;
    const minY = Math.min(...circles.map((circle) => circle.center[1] - circle.radius)) - 1;
    const maxY = Math.max(...circles.map((circle) => circle.center[1] + circle.radius)) + 1;
    const z = circles.reduce((sum, circle) => sum + circle.center[2], 0) / circles.length + RING_LIFT;
    const position = shape.geometry.getAttribute('position') as BufferAttribute;
    position.set([minX, minY, z, maxX, minY, z, maxX, maxY, z, minX, maxY, z]);
    position.needsUpdate = true;
    const uniforms = shape.material.uniforms;
    (uniforms.uColor.value as Color).set(circles[0].color);
    circles.forEach((circle, slot) => {
      (uniforms.uCircles.value as Vector3[])[slot].set(circle.center[0], circle.center[1], circle.radius);
      (uniforms.uOpacity.value as Float32Array)[slot] = Math.min(1, circle.opacity);
    });
    uniforms.uCount.value = circles.length;
  }
}
