// Arithmetic in every money box. The owner types "24.36+45.72" into an
// amount field and gets $70.08 -- this is the ONE evaluator entry point
// every such field types through (register add/edit amount, AssignedCell,
// MoveMoneyDialog, TargetEditor), so the behaviour can't fork per field.
//
// parseUSD (lib/money.ts) is the existing, well-tested contract for a single
// typed amount -- $, commas, decimals, its own accounting "(5.75)" ->
// -575 negative convention, "" -> 0, garbage -> null. This module does not
// reimplement any of that: every leaf number in an expression, and every
// input that isn't shaped like an expression at all, is handed to parseUSD
// verbatim. That is what makes the parity claim ("a lone number behaves
// EXACTLY like parseUSD") true by construction rather than by how well a
// test table happens to cover it.
//
// No '@/' imports, no JSX, relative '.ts' imports only -- this runs in a
// plain `node --test`, same doctrine as lib/money.ts and lib/ledgerRules.ts.

import { parseUSD, roundCents } from './money.ts'

// --- Is this even an expression? ------------------------------------------
//
// parseUSD itself already accepts strings built from: an optional single
// wrapping "(...)" (its negative convention -- and, per its own quirk,
// combines with a leading "-" inside to cancel back to positive), an
// optional single leading "-", then $/commas/digits/one decimal point.
// Stripping exactly that shape and checking what's left for a real
// operator character is how we tell "plain parseUSD input" apart from
// "an actual expression" -- and it means EVERY input parseUSD accepts or
// rejects, not just the cases sampled in a test file, round-trips through
// parseUSD directly, untouched.
function looksLikeExpression(s: string): boolean {
  let t = s
  if (t.startsWith('(') && t.endsWith(')') && t.length > 1) t = t.slice(1, -1)
  if (t.startsWith('-')) t = t.slice(1)
  return /[+\-*/()]/.test(t)
}

// --- Tokenizer --------------------------------------------------------
//
// Numbers are captured as raw substrings (optional leading "$", digits,
// commas, one decimal point) and handed to parseUSD verbatim when they're
// evaluated as a primary -- so a token like "$1,234.56" or ".5" or "5." is
// parsed by parseUSD, not by logic re-derived here. A token never includes
// a sign or parens: those are structural (unary '-'/'+', grouping '(' ')')
// and are the parser's job, not the tokenizer's.

type Token = { type: 'num'; text: string } | { type: '+' | '-' | '*' | '/' | '(' | ')' }

const OPERATORS = new Set(['+', '-', '*', '/', '(', ')'])

function tokenize(s: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (OPERATORS.has(c)) {
      tokens.push({ type: c as '+' | '-' | '*' | '/' | '(' | ')' })
      i++
      continue
    }
    if (c === '$' || c === '.' || (c >= '0' && c <= '9')) {
      let j = i
      if (s[j] === '$') j++
      let sawDigitOrDot = false
      while (j < s.length && (s[j] === ',' || s[j] === '.' || (s[j] >= '0' && s[j] <= '9'))) {
        if (s[j] !== ',') sawDigitOrDot = true
        j++
      }
      if (!sawDigitOrDot) return null // a lone "$" (or nothing consumable)
      tokens.push({ type: 'num', text: s.slice(i, j) })
      i = j
      continue
    }
    return null // unrecognized character
  }
  return tokens
}

// --- Evaluator --------------------------------------------------------
//
// The rounding rule, stated once: "+"/"-" combine values that are ALREADY
// exact integer cents (parseUSD guarantees that for every leaf) with plain
// integer addition/subtraction -- no floating point involved, so no
// rounding is needed, ever, for an expression built only from + and -.
// "*"/"/" taint a value: from that point on it's carried as a floating
// DOLLAR amount, and every further +, -, *, / on it stays in float dollars.
// Only once, at the very end of evaluating the whole expression, does a
// tainted value get turned back into cents, via roundCents. This is
// lib/money.ts's own doctrine (see computeTotals' lineTotal/taxOn, which
// round once per line rather than per intermediate step) applied to a
// nested expression: rounding a `*`/`/` node before combining it with its
// siblings compounds error into the final total (three even splits of $100
// rounded individually lose a cent: $33.33 x 3 = $99.99, not $100.00);
// rounding only the finished tree's boundary value does not.
type Value = { cents: number } | { dollars: number }

function toDollars(v: Value): number {
  return 'cents' in v ? v.cents / 100 : v.dollars
}

function finite(n: number): boolean {
  return Number.isFinite(n)
}

function add(a: Value, b: Value): Value | null {
  if ('cents' in a && 'cents' in b) return { cents: a.cents + b.cents }
  const d = toDollars(a) + toDollars(b)
  return finite(d) ? { dollars: d } : null
}

function sub(a: Value, b: Value): Value | null {
  if ('cents' in a && 'cents' in b) return { cents: a.cents - b.cents }
  const d = toDollars(a) - toDollars(b)
  return finite(d) ? { dollars: d } : null
}

function mul(a: Value, b: Value): Value | null {
  const d = toDollars(a) * toDollars(b)
  return finite(d) ? { dollars: d } : null
}

function div(a: Value, b: Value): Value | null {
  const bd = toDollars(b)
  if (bd === 0) return null // division by zero
  const d = toDollars(a) / bd
  return finite(d) ? { dollars: d } : null
}

function negate(a: Value): Value {
  return 'cents' in a ? { cents: -a.cents } : { dollars: -a.dollars }
}

// Recursive-descent parser, evaluating as it goes (no separate AST) --
// standard precedence (* / bind tighter than + -), left-associative,
// parentheses group. Total: every parse function returns null instead of
// throwing on anything malformed (unexpected token, missing operand,
// unbalanced parens, division by zero, or a NaN/Infinity anywhere).
type Cursor = { tokens: Token[]; pos: number }

function peek(c: Cursor): Token | undefined {
  return c.tokens[c.pos]
}

function parsePrimary(c: Cursor): Value | null {
  const t = peek(c)
  if (!t) return null
  if (t.type === 'num') {
    c.pos++
    const cents = parseUSD(t.text)
    return cents === null ? null : { cents }
  }
  if (t.type === '(') {
    c.pos++
    const inner = parseExpr(c)
    if (inner === null) return null
    const close = peek(c)
    if (!close || close.type !== ')') return null
    c.pos++
    return inner
  }
  return null
}

function parseUnary(c: Cursor): Value | null {
  const t = peek(c)
  if (t && t.type === '-') {
    c.pos++
    const v = parseUnary(c)
    return v === null ? null : negate(v)
  }
  if (t && t.type === '+') {
    c.pos++
    return parseUnary(c)
  }
  return parsePrimary(c)
}

function parseTerm(c: Cursor): Value | null {
  let v = parseUnary(c)
  if (v === null) return null
  for (;;) {
    const t = peek(c)
    if (t && t.type === '*') {
      c.pos++
      const rhs = parseUnary(c)
      if (rhs === null) return null
      v = mul(v, rhs)
      if (v === null) return null
      continue
    }
    if (t && t.type === '/') {
      c.pos++
      const rhs = parseUnary(c)
      if (rhs === null) return null
      v = div(v, rhs)
      if (v === null) return null
      continue
    }
    return v
  }
}

function parseExpr(c: Cursor): Value | null {
  let v = parseTerm(c)
  if (v === null) return null
  for (;;) {
    const t = peek(c)
    if (t && t.type === '+') {
      c.pos++
      const rhs = parseTerm(c)
      if (rhs === null) return null
      v = add(v, rhs)
      if (v === null) return null
      continue
    }
    if (t && t.type === '-') {
      c.pos++
      const rhs = parseTerm(c)
      if (rhs === null) return null
      v = sub(v, rhs)
      if (v === null) return null
      continue
    }
    return v
  }
}

function finalize(v: Value): number | null {
  const cents = 'cents' in v ? v.cents : roundCents(v.dollars * 100)
  return Number.isFinite(cents) && Number.isSafeInteger(cents) ? cents : null
}

/**
 * '24.36+45.72' -> 7008. Plain '24.36' behaves exactly like parseUSD (a
 * lone number delegates to it, verbatim -- see looksLikeExpression above).
 * null on anything unparseable. Integer cents out, always. Never throws.
 */
export function parseUSDMath(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return parseUSD(input)
  if (typeof input === 'number') return parseUSD(input)

  const s = input.trim()
  if (s === '') return 0
  if (!looksLikeExpression(s)) return parseUSD(s)

  const tokens = tokenize(s)
  if (tokens === null || tokens.length === 0) return null

  const cursor: Cursor = { tokens, pos: 0 }
  const result = parseExpr(cursor)
  if (result === null) return null
  if (cursor.pos !== tokens.length) return null // trailing garbage

  return finalize(result)
}
