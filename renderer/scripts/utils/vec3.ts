import type { Point3 } from './spell-events';

// Small vector maths for the spell art's plain (three.js-free) modules.

// The smallest length or difference the client's maths treats as non-zero.
export const EPSILON = 2.3841858e-7;

// Degrees to radians.
export const DEGREES = Math.PI / 180;

export const sub = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const length3 = (a: Point3): number => Math.hypot(a[0], a[1], a[2]);
export const cross = (a: Point3, b: Point3): Point3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
