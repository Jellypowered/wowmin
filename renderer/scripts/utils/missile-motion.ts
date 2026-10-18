import { DEGREES } from './vec3';

// Runs a missile motion script (SpellMissileMotion) from the syntax tree the
// spell art carries (scripts/scene/missile-motion.mjs), as the client runs
// the Lua: each frame, from the missile's progress and distances, it gives
// offsets that curve or spread the missile, a turn and scale for its model,
// and changes to its speed. Pure, so it can be tested without three.js.

export type MotionExpression =
  | ['num', number] | ['bool', boolean] | ['nil'] | ['var', string] | ['call', string, MotionExpression[]]
  | ['neg', MotionExpression] | ['not', MotionExpression] | ['op', string, MotionExpression, MotionExpression];
export type MotionStatement =
  | ['set', string, MotionExpression, boolean]
  | ['if', Array<[MotionExpression, MotionStatement[]]>, MotionStatement[] | null];

// A missile's motion: its script, and how many missiles each cast fires.
export interface MissileMotion {
  count: number;
  script: MotionStatement[];
}

// What the client hands the script each frame.
export interface MotionInputs {
  progress: number;
  time: number;
  missileIndex: number;
  missileCount: number;
  distanceToFirePos: number;
  distanceToImpactPos: number;
  startDistance: number;
  totalDistance: number;
  rand1: number;
  rand2: number;
  rand3: number;
  spellID: number;
}

// What it gives back: a sideways and up offset by angle (degrees) and size,
// offsets right, forward, and up (yards), the model's turn (degrees), and
// its speed (absolute, a multiple of the base, or added to it), and scale;
// 0 for any it leaves unset.
export interface MotionOutputs {
  transAngle: number;
  transMag: number;
  transRight: number;
  transFront: number;
  transUp: number;
  modelYaw: number;
  modelPitch: number;
  modelRoll: number;
  speedAbs: number;
  speedScalar: number;
  speedOffset: number;
  scale: number;
}

const OUTPUTS: Array<keyof MotionOutputs> = [
  'transAngle', 'transMag', 'transRight', 'transFront', 'transUp', 'modelYaw', 'modelPitch', 'modelRoll',
  'speedAbs', 'speedScalar', 'speedOffset', 'scale',
];

type Value = number | boolean | null;

// The client's script functions: sin and cos (and tan) take degrees, as in
// its interface Lua; math.* as in standard Lua.
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: (degrees) => Math.sin(degrees * DEGREES),
  cos: (degrees) => Math.cos(degrees * DEGREES),
  tan: (degrees) => Math.tan(degrees * DEGREES),
  abs: Math.abs, sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max,
  'math.sin': Math.sin, 'math.cos': Math.cos, 'math.tan': Math.tan, 'math.abs': Math.abs, 'math.sqrt': Math.sqrt,
  'math.floor': Math.floor, 'math.ceil': Math.ceil, 'math.min': Math.min, 'math.max': Math.max,
  'math.fmod': (a, b) => a % b,
  'math.random': () => Math.random(),
};

class Scope {
  readonly values = new Map<string, Value>();
  constructor(readonly parent: Scope | null) {}

  find(name: string): Scope | null {
    for (let scope: Scope | null = this; scope; scope = scope.parent) if (scope.values.has(name)) return scope;
    return null;
  }
}

const truthy = (value: Value): boolean => value !== null && value !== false;

function number(value: Value): number {
  if (typeof value !== 'number') throw new Error('Arithmetic on a non-number in a motion script.');
  return value;
}

function evaluate(expression: MotionExpression, scope: Scope): Value {
  switch (expression[0]) {
    case 'num': return expression[1];
    case 'bool': return expression[1];
    case 'nil': return null;
    case 'var': return scope.find(expression[1])?.values.get(expression[1]) ?? null;
    case 'neg': return -number(evaluate(expression[1], scope));
    case 'not': return !truthy(evaluate(expression[1], scope));
    case 'call': {
      const fn = FUNCTIONS[expression[1]];
      if (!fn) throw new Error(`Unknown function ${expression[1]} in a motion script.`);
      return fn(...expression[2].map((argument) => number(evaluate(argument, scope))));
    }
    case 'op': {
      const [, operator, left, right] = expression;
      if (operator === 'and') {
        const a = evaluate(left, scope);
        return truthy(a) ? evaluate(right, scope) : a;
      }
      if (operator === 'or') {
        const a = evaluate(left, scope);
        return truthy(a) ? a : evaluate(right, scope);
      }
      const a = evaluate(left, scope);
      const b = evaluate(right, scope);
      if (operator === '==') return a === b;
      if (operator === '~=') return a !== b;
      const x = number(a);
      const y = number(b);
      switch (operator) {
        case '+': return x + y;
        case '-': return x - y;
        case '*': return x * y;
        case '/': return x / y;
        // Lua's modulo takes the divisor's sign.
        case '%': return x - Math.floor(x / y) * y;
        case '^': return x ** y;
        case '<': return x < y;
        case '<=': return x <= y;
        case '>': return x > y;
        case '>=': return x >= y;
        default: throw new Error(`Unknown operator ${operator} in a motion script.`);
      }
    }
    default: throw new Error('Unknown expression in a motion script.');
  }
}

function run(statements: MotionStatement[], scope: Scope): void {
  for (const statement of statements) {
    if (statement[0] === 'set') {
      const [, name, expression, local] = statement;
      const value = evaluate(expression, scope);
      if (local) scope.values.set(name, value);
      else {
        let root = scope;
        while (root.parent) root = root.parent;
        (scope.find(name) ?? root).values.set(name, value);
      }
      continue;
    }
    const [, branches, otherwise] = statement;
    const taken = branches.find(([condition]) => truthy(evaluate(condition, scope)));
    const body = taken ? taken[1] : otherwise;
    if (body) run(body, new Scope(scope));
  }
}

// Runs a script once. Outputs that aren't finite numbers come back as 0, as
// the client reads them; a script that fails (arithmetic on nil, say)
// throws, and the client stops using it for that missile.
export function runMotionScript(script: MotionStatement[], inputs: MotionInputs): MotionOutputs {
  const globals = new Scope(null);
  for (const [name, value] of Object.entries(inputs)) globals.values.set(name, value);
  run(script, new Scope(globals));
  const outputs = {} as MotionOutputs;
  for (const name of OUTPUTS) {
    const value = globals.values.get(name);
    outputs[name] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return outputs;
}
