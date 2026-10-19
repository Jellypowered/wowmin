// Parses a missile motion script (SpellMissileMotion: the small Lua bodies
// that curve, spiral, and spread a spell's missiles) into a syntax tree the
// renderer runs (renderer/scripts/utils/missile-motion.ts); the page can't
// run code it is sent. Only the Lua the client's scripts use is understood:
// local and plain assignments, if / elseif / else, arithmetic, comparisons,
// and / or / not, and calls such as sin, cos, and math.fmod.
//
// The tree, as plain arrays:
//   statements: ['set', name, expression, isLocal]  (local name alone: nil)
//               ['if', [[condition, statements], ...], elseStatements | null]
//   expressions: ['num', value] ['bool', value] ['nil'] ['var', name]
//                ['call', name, [arguments]] ['neg', a] ['not', a]
//                ['op', operator, a, b]   (+ - * / % ^ == ~= < <= > >= and or)

const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'then', 'elseif', 'else', 'end', 'local', 'true', 'false', 'nil']);
const SYMBOLS = ['==', '~=', '<=', '>=', '+', '-', '*', '/', '%', '^', '<', '>', '=', '(', ')', ',', ';'];

function tokenize(source) {
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) { at += space[0].length; continue; }
    if (rest.startsWith('--[[')) {
      const end = source.indexOf(']]', at + 4);
      at = end < 0 ? source.length : end + 2;
      continue;
    }
    if (rest.startsWith('--')) {
      const end = source.indexOf('\n', at);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
    if (number) { tokens.push({ type: 'num', value: Number(number[0]) }); at += number[0].length; continue; }
    const name = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?/.exec(rest);
    if (name) {
      tokens.push(KEYWORDS.has(name[0]) ? { type: name[0] } : { type: 'name', value: name[0] });
      at += name[0].length;
      continue;
    }
    const symbol = SYMBOLS.find((candidate) => rest.startsWith(candidate));
    if (!symbol) throw new Error(`Unexpected "${rest[0]}" in motion script.`);
    tokens.push({ type: symbol });
    at += symbol.length;
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

// Lua's binary operators by precedence, loosest first; ^ binds tighter than
// a unary minus and groups from the right.
const LEVELS = [['or'], ['and'], ['<', '>', '<=', '>=', '~=', '=='], ['+', '-'], ['*', '/', '%']];

export function parseMotionScript(source) {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const take = (type) => {
    const token = tokens[at];
    if (type && token.type !== type) throw new Error(`Expected ${type}, found ${token.type} in motion script.`);
    at += 1;
    return token;
  };

  const primary = () => {
    const token = take();
    switch (token.type) {
      case 'num': return ['num', token.value];
      case 'true': return ['bool', true];
      case 'false': return ['bool', false];
      case 'nil': return ['nil'];
      case '(': {
        const inner = expression(0);
        take(')');
        return inner;
      }
      case 'name': {
        if (peek().type !== '(') return ['var', token.value];
        take('(');
        const args = [];
        if (peek().type !== ')') {
          args.push(expression(0));
          while (peek().type === ',') { take(','); args.push(expression(0)); }
        }
        take(')');
        return ['call', token.value, args];
      }
      default: throw new Error(`Unexpected ${token.type} in motion script.`);
    }
  };
  const power = () => {
    const base = primary();
    if (peek().type !== '^') return base;
    take('^');
    return ['op', '^', base, unary()];
  };
  const unary = () => {
    if (peek().type === '-') { take('-'); return ['neg', unary()]; }
    if (peek().type === 'not') { take('not'); return ['not', unary()]; }
    return power();
  };
  const expression = (level) => {
    if (level === LEVELS.length) return unary();
    let left = expression(level + 1);
    while (LEVELS[level].includes(peek().type)) {
      const operator = take().type;
      left = ['op', operator, left, expression(level + 1)];
    }
    return left;
  };

  const block = (enders) => {
    const statements = [];
    while (!enders.includes(peek().type)) {
      const token = take();
      if (token.type === ';') continue;
      if (token.type === 'local' || token.type === 'name') {
        const local = token.type === 'local';
        const name = local ? take('name').value : token.value;
        // `local name` alone declares it nil.
        if (local && peek().type !== '=') {
          statements.push(['set', name, ['nil'], true]);
          continue;
        }
        take('=');
        statements.push(['set', name, expression(0), local]);
        continue;
      }
      if (token.type === 'if') {
        const branches = [];
        let otherwise = null;
        let condition = expression(0);
        for (;;) {
          take('then');
          branches.push([condition, block(['elseif', 'else', 'end'])]);
          const next = take().type;
          if (next === 'elseif') { condition = expression(0); continue; }
          if (next === 'else') { otherwise = block(['end']); take('end'); }
          break;
        }
        statements.push(['if', branches, otherwise]);
        continue;
      }
      throw new Error(`Unexpected ${token.type} in motion script.`);
    }
    return statements;
  };

  return block(['eof']);
}
