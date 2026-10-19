// How the client colours and animates its liquids, pure so it can be tested
// without three.js: water's depth ramps (a texture whose rows run from the
// shallow colour and alpha to the deep, picked by each vertex's depth byte),
// the animated sheets' frame, and magma's scroll.

import type { Rgb, WaterColors } from './map-light';

export type WaterRamp = 'river' | 'ocean' | 'wmo';

// A ramp is 8 texels wide and 64 tall, RGBA bytes, row 0 the shallowest.
export const RAMP_WIDTH = 8;
export const RAMP_HEIGHT = 64;
// The deepest row of the ocean's ramp is a tenth darker (and opaque).
const OCEAN_DEEPEST_VALUE = 0.9;

// Water with no light to colour it: a dull blue-green, partly see-through.
export const NEUTRAL_WATER_COLOR: Rgb = [0.2, 0.3, 0.3];
export const NEUTRAL_WATER_ALPHA = 0.7;
export const NEUTRAL_WATER: WaterColors = {
  oceanShallow: NEUTRAL_WATER_COLOR, oceanDeep: NEUTRAL_WATER_COLOR,
  riverShallow: NEUTRAL_WATER_COLOR, riverDeep: NEUTRAL_WATER_COLOR,
  sunCloud: [0, 0, 0],
  alphas: [NEUTRAL_WATER_ALPHA, NEUTRAL_WATER_ALPHA, NEUTRAL_WATER_ALPHA, NEUTRAL_WATER_ALPHA],
};

const WHITE = [255, 255, 255];
const toByte = (value: number): number => Math.min(255, Math.max(0, Math.round(value * 255)));

// Row y of 64 between two bytes, in the client's 8.8 fixed point: the
// deepest row stops a step short of the deep value.
function rampByte(shallow: number, deep: number, row: number): number {
  const step = ((deep - shallow) << 8) >> 6;
  return ((shallow << 8) + row * step) >> 8;
}

// A ramp's texels as the client builds them, into `texels`: river and
// ocean from their shallow colour and alpha to their deep; WMO water's left
// half the river's deep colour, its right half white (interior water's),
// with the river's alphas.
export function waterRampTexels(
  ramp: WaterRamp, water: WaterColors, texels: Uint8Array = new Uint8Array(RAMP_WIDTH * RAMP_HEIGHT * 4),
): Uint8Array {
  const ocean = ramp === 'ocean';
  const shallow = (ocean ? water.oceanShallow : water.riverShallow).map(toByte);
  const deep = (ocean ? water.oceanDeep : water.riverDeep).map(toByte);
  const [shallowAlpha, deepAlpha] = (ocean ? water.alphas.slice(2, 4) : water.alphas.slice(0, 2)).map(toByte);
  const wmoColor = water.riverDeep.map(toByte);
  for (let row = 0; row < RAMP_HEIGHT; row += 1) {
    const alpha = rampByte(shallowAlpha, deepAlpha, row);
    let color = [0, 1, 2].map((channel) => rampByte(shallow[channel], deep[channel], row));
    let rowAlpha = alpha;
    if (ocean && row === RAMP_HEIGHT - 1) {
      color = color.map((channel) => Math.round(channel * OCEAN_DEEPEST_VALUE));
      rowAlpha = 255;
    }
    for (let column = 0; column < RAMP_WIDTH; column += 1) {
      const texel = (row * RAMP_WIDTH + column) * 4;
      const rgb = ramp === 'wmo' ? (column < RAMP_WIDTH / 2 ? wmoColor : WHITE) : color;
      texels[texel] = rgb[0];
      texels[texel + 1] = rgb[1];
      texels[texel + 2] = rgb[2];
      texels[texel + 3] = rowAlpha;
    }
  }
  return texels;
}

// The frame of an animated sheet of `count` frames at `now` (ms), the sheet
// running through them every `period` ms.
export function liquidFrameIndex(now: number, period: number, count: number): number {
  if (count <= 0) return 0;
  const along = ((now % period) + period) % period / period * count;
  return Math.min(count - 1, Math.max(0, Math.round(along - 0.5)));
}

// How far magma's sheet has scrolled along one axis at `now` (ms), in
// texture widths: `speed` widths a second, wrapping each whole width (the
// client counts whole milliseconds of a whole-millisecond period). 0 for
// none.
export function liquidScrollOffset(now: number, speed: number): number {
  if (!speed) return 0;
  const period = Math.trunc(1000 / speed);
  return period > 0 ? (Math.floor(now) % period) / period : 0;
}
