import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  type Blending,
  Color,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  Group,
  Mesh,
  MeshBasicMaterial,
  MultiplyBlending,
  NormalBlending,
  OneFactor,
  RepeatWrapping,
  SRGBColorSpace,
  SrcColorFactor,
  type Texture,
  TextureLoader,
} from 'three';

import { LightningBolt, type SpellChain } from '../utils/lightning';
import type { Point3 } from '../utils/spell-events';
import type { EffectView } from './m2-effect';

// Draws spells' chains (SpellChainEffects: Chain Heal, Chain Lightning,
// Drain Life) as the client's lightning bolts between units, in the spell
// layer's server coordinates. Each bolt keeps its state (joints, wave,
// flicker, pulse) from frame to frame while it is drawn.

// One bolt to draw this frame: `key` and `index` name it from frame to
// frame (a chain link, and which of its chain's effects).
export interface ChainDraw {
  key: object;
  index: number;
  chain: SpellChain;
  from: Point3;
  to: Point3;
}

// Chains draw after the other effects, in the order of their layer.
const RENDER_ORDER = 4;
const MAX_BOLTS = 64;

interface DrawnBolt {
  bolt: LightningBolt;
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  capacity: number;
}

// The client's blend modes as three.js blending.
function applyBlend(material: MeshBasicMaterial, mode: number): void {
  const custom = (source: typeof DstColorFactor, destination: typeof SrcColorFactor | typeof OneFactor): Blending => {
    material.blendSrc = source;
    material.blendDst = destination;
    return CustomBlending;
  };
  switch (mode) {
    case 0: material.blending = NormalBlending; material.transparent = false; return;
    case 1: material.blending = NormalBlending; material.transparent = false; material.alphaTest = 0.5; return;
    case 2: material.blending = NormalBlending; material.depthWrite = true; return;
    case 4: material.blending = MultiplyBlending; return;
    case 5: material.blending = custom(DstColorFactor, SrcColorFactor); return;
    case 6: material.blending = custom(DstColorFactor, OneFactor); return;
    default: material.blending = AdditiveBlending;
  }
}

const vertexColor = new Color();

export class ChainLightning {
  readonly group = new Group();
  private readonly bolts = new Map<object, Map<number, DrawnBolt>>();
  private readonly textures = new Map<number, Texture | null>();
  private readonly loader = new TextureLoader();
  private drawn = 0;

  constructor(private readonly onLoaded: () => void) {}

  get count(): number {
    return this.drawn;
  }

  // Steps each bolt on by `seconds` and draws this frame's; bolts not
  // drawn this frame are dropped, their state with them. Bolts whose
  // texture is still loading wait.
  update(draws: ChainDraw[], view: EffectView, seconds: number): void {
    const seen = new Set<DrawnBolt>();
    const looking: Point3 = [-view.toCamera[0], -view.toCamera[1], -view.toCamera[2]];
    this.drawn = 0;
    for (const draw of draws.slice(0, MAX_BOLTS)) {
      const texture = this.texture(draw.chain.id);
      if (!texture) continue;
      let byIndex = this.bolts.get(draw.key);
      if (!byIndex) this.bolts.set(draw.key, byIndex = new Map());
      let drawn = byIndex.get(draw.index);
      if (!drawn) byIndex.set(draw.index, drawn = this.createBolt(draw.chain, texture));
      seen.add(drawn);
      drawn.bolt.update(seconds, draw.from, draw.to);
      const strip = drawn.bolt.build(looking);
      drawn.mesh.visible = Boolean(strip);
      if (!strip) continue;
      this.fill(drawn, strip.positions, strip.uvs, strip.alphas, strip.start, strip.count);
      this.drawn += 1;
    }
    for (const [key, byIndex] of this.bolts) {
      for (const [index, drawn] of byIndex) {
        if (seen.has(drawn)) continue;
        drawn.mesh.removeFromParent();
        drawn.mesh.geometry.dispose();
        drawn.mesh.material.dispose();
        byIndex.delete(index);
      }
      if (!byIndex.size) this.bolts.delete(key);
    }
  }

  private createBolt(chain: SpellChain, texture: Texture): DrawnBolt {
    const material = new MeshBasicMaterial({
      map: texture, vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide,
    });
    applyBlend(material, chain.blendMode);
    const mesh = new Mesh(new BufferGeometry(), material);
    mesh.renderOrder = RENDER_ORDER + Math.max(0, Math.min(3, chain.renderLayer)) / 10;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return { bolt: new LightningBolt(chain), mesh, capacity: 0 };
  }

  // The strip's vertices, coloured by the chain's colour and each vertex's
  // opacity, and the quads from `start` for `count` vertices.
  private fill(drawn: DrawnBolt, positions: Float32Array, uvs: Float32Array, alphas: Float32Array, start: number, count: number): void {
    const geometry = drawn.mesh.geometry;
    const vertexCount = positions.length / 3;
    if (vertexCount > drawn.capacity) {
      drawn.capacity = vertexCount;
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(vertexCount * 2), 2));
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(vertexCount * 4), 4));
      const index: number[] = [];
      for (let vertex = 0; vertex + 3 < vertexCount; vertex += 2) index.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2);
      geometry.setIndex(index);
    }
    const position = geometry.getAttribute('position') as BufferAttribute;
    const uv = geometry.getAttribute('uv') as BufferAttribute;
    const color = geometry.getAttribute('color') as BufferAttribute;
    (position.array as Float32Array).set(positions);
    (uv.array as Float32Array).set(uvs);
    // The client multiplies colours as stored (sRGB).
    vertexColor.setHex(drawn.bolt.chain.color, SRGBColorSpace);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) color.setXYZW(vertex, vertexColor.r, vertexColor.g, vertexColor.b, alphas[vertex]);
    position.needsUpdate = true;
    uv.needsUpdate = true;
    color.needsUpdate = true;
    const firstQuad = Math.floor(start / 2);
    const lastQuad = Math.floor((start + count - 4) / 2);
    geometry.setDrawRange(firstQuad * 6, Math.max(0, lastQuad - firstQuad + 1) * 6);
  }

  private texture(chainId: number): Texture | null {
    if (this.textures.has(chainId)) return this.textures.get(chainId) ?? null;
    this.textures.set(chainId, null);
    this.loader.load(`assets/models/icon/chain-${chainId}.png`, (texture) => {
      texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      this.textures.set(chainId, texture);
      this.onLoaded();
    });
    return null;
  }
}
