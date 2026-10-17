// A mesh's triangles sorted into a grid over X and Y, so a ray tests only
// the triangles in the cells it crosses rather than every one: a ray
// straight down tests one cell's few. Positions and rays share one space
// with Z up (the scene's server coordinates). No three.js, so it can be
// tested on its own.

// Cells are at least this wide (yards; a terrain quad is about 4.2), and a
// side has at most this many.
const MIN_CELL = 4;
const MAX_CELLS_PER_SIDE = 256;

// Which faces a ray can hit: both, only those facing it (a triangle whose
// corners run anticlockwise seen from the ray's start), or only those facing
// away.
export type FaceCulling = 'none' | 'back' | 'front';

export class TriangleGrid {
  private constructor(
    private readonly positions: Float32Array,
    private readonly indices: ArrayLike<number> | null,
    private readonly minX: number,
    private readonly minY: number,
    private readonly cell: number,
    private readonly columns: number,
    private readonly rows: number,
    // Cell k's triangles are triangles[starts[k]] up to triangles[starts[k + 1]].
    private readonly starts: Uint32Array,
    private readonly triangles: Uint32Array,
  ) {}

  // A grid of the triangles `indices` makes of `positions` (x, y, z each),
  // or of every three positions in turn without indices.
  static build(positions: Float32Array, indices: ArrayLike<number> | null, minCell = MIN_CELL): TriangleGrid {
    const count = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
    const corner = (triangle: number, which: number): number => (indices ? indices[triangle * 3 + which] : triangle * 3 + which) * 3;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let triangle = 0; triangle < count; triangle += 1) {
      for (let which = 0; which < 3; which += 1) {
        const at = corner(triangle, which);
        minX = Math.min(minX, positions[at]);
        maxX = Math.max(maxX, positions[at]);
        minY = Math.min(minY, positions[at + 1]);
        maxY = Math.max(maxY, positions[at + 1]);
      }
    }
    if (!count) return new TriangleGrid(positions, indices, 0, 0, minCell, 1, 1, new Uint32Array(2), new Uint32Array(0));
    const cell = Math.max(minCell, Math.max(maxX - minX, maxY - minY) / MAX_CELLS_PER_SIDE);
    const columns = Math.max(1, Math.ceil((maxX - minX) / cell));
    const rows = Math.max(1, Math.ceil((maxY - minY) / cell));
    const columnOf = (x: number) => Math.min(columns - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const rowOf = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));
    // Each triangle goes in every cell its box covers.
    const spans = new Uint32Array(count * 4);
    const starts = new Uint32Array(columns * rows + 1);
    for (let triangle = 0; triangle < count; triangle += 1) {
      const a = corner(triangle, 0);
      const b = corner(triangle, 1);
      const c = corner(triangle, 2);
      const column0 = columnOf(Math.min(positions[a], positions[b], positions[c]));
      const column1 = columnOf(Math.max(positions[a], positions[b], positions[c]));
      const row0 = rowOf(Math.min(positions[a + 1], positions[b + 1], positions[c + 1]));
      const row1 = rowOf(Math.max(positions[a + 1], positions[b + 1], positions[c + 1]));
      spans[triangle * 4] = column0;
      spans[triangle * 4 + 1] = column1;
      spans[triangle * 4 + 2] = row0;
      spans[triangle * 4 + 3] = row1;
      for (let row = row0; row <= row1; row += 1) {
        for (let column = column0; column <= column1; column += 1) starts[row * columns + column + 1] += 1;
      }
    }
    for (let index = 1; index < starts.length; index += 1) starts[index] += starts[index - 1];
    const next = starts.slice(0, -1);
    const triangles = new Uint32Array(starts[starts.length - 1]);
    for (let triangle = 0; triangle < count; triangle += 1) {
      for (let row = spans[triangle * 4 + 2]; row <= spans[triangle * 4 + 3]; row += 1) {
        for (let column = spans[triangle * 4]; column <= spans[triangle * 4 + 1]; column += 1) {
          triangles[next[row * columns + column]] = triangle;
          next[row * columns + column] += 1;
        }
      }
    }
    return new TriangleGrid(positions, indices, minX, minY, cell, columns, rows, starts, triangles);
  }

  // How far along the ray from (ox, oy, oz) along the unit direction
  // (dx, dy, dz) its nearest hit is, up to `far`, or null. The cells are
  // walked from the start; the first cell to hold a hit no further than its
  // far edge ends the walk, since every triangle under a point is in that
  // point's cell.
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, far: number, culling: FaceCulling = 'none'): number | null {
    if (!this.triangles.length) return null;
    const { minX, minY, cell, columns, rows } = this;
    const maxX = minX + columns * cell;
    const maxY = minY + rows * cell;
    // The stretch of the ray over the grid.
    let enter = 0;
    let leave = far;
    if (dx === 0) {
      if (ox < minX || ox > maxX) return null;
    } else {
      const a = (minX - ox) / dx;
      const b = (maxX - ox) / dx;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
    if (dy === 0) {
      if (oy < minY || oy > maxY) return null;
    } else {
      const a = (minY - oy) / dy;
      const b = (maxY - oy) / dy;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
    if (enter > leave) return null;
    let column = Math.min(columns - 1, Math.max(0, Math.floor((ox + dx * enter - minX) / cell)));
    let row = Math.min(rows - 1, Math.max(0, Math.floor((oy + dy * enter - minY) / cell)));
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    // Where the ray crosses the cell's next edge across X and across Y.
    let nextX = stepX ? (minX + (column + (stepX > 0 ? 1 : 0)) * cell - ox) / dx : Infinity;
    let nextY = stepY ? (minY + (row + (stepY > 0 ? 1 : 0)) * cell - oy) / dy : Infinity;
    const acrossX = stepX ? cell / Math.abs(dx) : Infinity;
    const acrossY = stepY ? cell / Math.abs(dy) : Infinity;
    let best = Infinity;
    for (;;) {
      const at = row * columns + column;
      for (let index = this.starts[at]; index < this.starts[at + 1]; index += 1) {
        const distance = this.hit(this.triangles[index], ox, oy, oz, dx, dy, dz, culling);
        if (distance >= 0 && distance < best) best = distance;
      }
      const exit = Math.min(nextX, nextY);
      if (best <= exit || exit > leave) break;
      if (nextX < nextY) {
        column += stepX;
        nextX += acrossX;
      } else {
        row += stepY;
        nextY += acrossY;
      }
      if (column < 0 || column >= columns || row < 0 || row >= rows) break;
    }
    return best <= far ? best : null;
  }

  // How far along the ray it meets the triangle, or -1, by the same sums as
  // three.js's Ray.intersectTriangle.
  private hit(triangle: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, culling: FaceCulling): number {
    const positions = this.positions;
    const indices = this.indices;
    const a = (indices ? indices[triangle * 3] : triangle * 3) * 3;
    const b = (indices ? indices[triangle * 3 + 1] : triangle * 3 + 1) * 3;
    const c = (indices ? indices[triangle * 3 + 2] : triangle * 3 + 2) * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const e1x = positions[b] - ax;
    const e1y = positions[b + 1] - ay;
    const e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax;
    const e2y = positions[c + 1] - ay;
    const e2z = positions[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    let facing = dx * nx + dy * ny + dz * nz;
    let sign: number;
    if (facing > 0) {
      // The ray meets its back.
      if (culling === 'back') return -1;
      sign = 1;
    } else if (facing < 0) {
      if (culling === 'front') return -1;
      sign = -1;
      facing = -facing;
    } else {
      return -1;
    }
    const qx = ox - ax;
    const qy = oy - ay;
    const qz = oz - az;
    const u = sign * (dx * (qy * e2z - qz * e2y) + dy * (qz * e2x - qx * e2z) + dz * (qx * e2y - qy * e2x));
    if (u < 0) return -1;
    const v = sign * (dx * (e1y * qz - e1z * qy) + dy * (e1z * qx - e1x * qz) + dz * (e1x * qy - e1y * qx));
    if (v < 0 || u + v > facing) return -1;
    const along = -sign * (qx * nx + qy * ny + qz * nz);
    return along < 0 ? -1 : along / facing;
  }
}
