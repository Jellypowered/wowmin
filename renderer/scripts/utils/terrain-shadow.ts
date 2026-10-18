// The ground's baked shadow (MCSH) by position, as the client asks it of a
// unit or a prop: which texel of its chunk's 64 x 64 shadow map lies under
// a point. Scenes carry the shadow in each tile's alpha atlas (A: 255 lit,
// less in shadow; scripts/scene/terrain.mjs), 16 x 16 chunks of 64 texels.
// Pure but for reading the atlas, which the caller supplies.

export const TILE_SIZE = 1600 / 3;
const CHUNK_SIZE = TILE_SIZE / 16;
const TEXELS_PER_CHUNK = 64;
export const ATLAS_SIZE = TEXELS_PER_CHUNK * 16;
// Atlas alpha below this is shadow (older and newer scenes store 150).
const SHADOW_ALPHA_BELOW = 200;

// The atlas texel (row * ATLAS_SIZE + column) under server point (x, y) in
// the tile whose north-west corner is `origin` (server x, y), or null if
// the point is not in that tile. Rows run south (decreasing x), columns
// east (decreasing y), each texel 1/64 of a chunk, counted down from the
// corner as the client does.
export function shadowTexel([originX, originY]: readonly [number, number], x: number, y: number): number | null {
  const row = Math.floor(((originX - x) / CHUNK_SIZE) * TEXELS_PER_CHUNK);
  const column = Math.floor(((originY - y) / CHUNK_SIZE) * TEXELS_PER_CHUNK);
  if (row < 0 || column < 0 || row >= ATLAS_SIZE || column >= ATLAS_SIZE) return null;
  return row * ATLAS_SIZE + column;
}

// The map's tiles' shadows, each read from its atlas the first time a point
// in it is asked about.
export class TerrainShadows {
  private readonly tiles: Array<{ origin: readonly [number, number]; read: () => Uint8Array | null; alpha?: Uint8Array | null }> = [];

  // `read` gives the atlas's alpha channel, ATLAS_SIZE squared bytes.
  addTile(origin: readonly [number, number], read: () => Uint8Array | null): void {
    this.tiles.push({ origin, read });
  }

  // Whether the ground's baked shadow covers the texel under (x, y); false
  // off the map's tiles.
  isShadowed(x: number, y: number): boolean {
    for (const tile of this.tiles) {
      const texel = shadowTexel(tile.origin, x, y);
      if (texel === null) continue;
      if (tile.alpha === undefined) tile.alpha = tile.read();
      return Boolean(tile.alpha && tile.alpha[texel] < SHADOW_ALPHA_BELOW);
    }
    return false;
  }
}
