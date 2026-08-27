/**
 * Strict JSON parser for captured provider result texts.
 *
 * Distinct from JSON.parse: rejects DUPLICATE object keys (standard
 * JSON.parse silently keeps the last), enforces the resource bounds while
 * parsing (depth, node count, string size), and rejects trailing content.
 * Values are produced as inert plain data (JSON.parse-style own
 * properties); downstream strict field readers and the core plain-record
 * walker provide the remaining hostile-input gates.
 */

import { RESOURCE_LIMITS } from "@nec/core";

import { NecResolverEvmError } from "./errors.js";

interface ParseState {
  readonly source: string;
  pos: number;
  depth: number;
  nodes: number;
}

function parseFail(reason: string): never {
  throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `result json: ${reason}`);
}

function limitFail(limit: string, reason: string): never {
  throw new NecResolverEvmError("EVM_LIMIT_EXCEEDED", `result json: ${limit}: ${reason}`);
}

function skipWhitespace(state: ParseState): void {
  while (state.pos < state.source.length) {
    const c = state.source.charCodeAt(state.pos);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) state.pos += 1;
    else break;
  }
}

function expect(state: ParseState, ch: string): void {
  skipWhitespace(state);
  if (state.source[state.pos] !== ch) {
    parseFail(`expected "${ch}" at ${state.pos}`);
  }
  state.pos += 1;
}

function readString(state: ParseState): string {
  expect(state, '"');
  let out = "";
  while (true) {
    if (state.pos >= state.source.length) parseFail("unterminated string");
    const c = state.source[state.pos] as string;
    if (c === '"') {
      state.pos += 1;
      return out;
    }
    if (c === "\\") {
      state.pos += 1;
      const e = state.source[state.pos];
      if (state.pos >= state.source.length) parseFail("unterminated escape");
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          if (state.pos + 4 >= state.source.length) parseFail("incomplete \\u escape");
          let code = 0;
          for (let i = 1; i <= 4; i++) {
            const hex = state.source[state.pos + i] as string;
            const nibble =
              hex >= "0" && hex <= "9"
                ? hex.charCodeAt(0) - 0x30
                : hex >= "a" && hex <= "f"
                  ? hex.charCodeAt(0) - 0x61 + 10
                  : hex >= "A" && hex <= "F"
                    ? hex.charCodeAt(0) - 0x41 + 10
                    : -1;
            if (nibble < 0) parseFail("invalid \\u escape");
            code = code * 16 + nibble;
          }
          out += String.fromCharCode(code);
          state.pos += 4;
          break;
        }
        default:
          parseFail("invalid escape sequence");
      }
      state.pos += 1;
      continue;
    }
    if (c.charCodeAt(0) < 0x20) parseFail("raw control character in string");
    out += c;
    state.pos += 1;
  }
}

function readNumber(state: ParseState): number {
  const start = state.pos;
  if (state.source[state.pos] === "-") state.pos += 1;
  const intStart = state.pos;
  while (state.pos < state.source.length && state.source[state.pos]! >= "0" && state.source[state.pos]! <= "9") {
    state.pos += 1;
  }
  if (state.pos === intStart) parseFail(`invalid number near ${start}`);
  // Leading zeros are invalid JSON.
  if (state.source[intStart] === "0" && state.pos - intStart > 1) {
    parseFail("leading zero in number");
  }
  if (state.source[state.pos] === ".") {
    state.pos += 1;
    const fracStart = state.pos;
    while (state.pos < state.source.length && state.source[state.pos]! >= "0" && state.source[state.pos]! <= "9") {
      state.pos += 1;
    }
    if (state.pos === fracStart) parseFail("number missing fraction digits");
  }
  const e = state.source[state.pos];
  if (e === "e" || e === "E") {
    state.pos += 1;
    const sign = state.source[state.pos];
    if (sign === "+" || sign === "-") state.pos += 1;
    const expStart = state.pos;
    while (state.pos < state.source.length && state.source[state.pos]! >= "0" && state.source[state.pos]! <= "9") {
      state.pos += 1;
    }
    if (state.pos === expStart) parseFail("number missing exponent digits");
  }
  const value = Number(state.source.slice(start, state.pos));
  if (!Number.isFinite(value)) parseFail(`non-finite number near ${start}`);
  return value;
}

function readValue(state: ParseState): unknown {
  if (state.depth > RESOURCE_LIMITS.MAX_DEPTH) {
    limitFail("MAX_DEPTH", `exceeds maximum depth of ${RESOURCE_LIMITS.MAX_DEPTH}`);
  }
  state.nodes += 1;
  if (state.nodes > RESOURCE_LIMITS.MAX_TOTAL_NODES) {
    limitFail("MAX_TOTAL_NODES", `exceeds ${RESOURCE_LIMITS.MAX_TOTAL_NODES} values`);
  }
  skipWhitespace(state);
  const c = state.source[state.pos];
  switch (c) {
    case "{": {
      state.depth += 1;
      state.pos += 1;
      // Null-prototype record: an own "__proto__" data key can never route
      // through the Object.prototype setter, so hostile documents can
      // neither lose fields nor pollute prototypes.
      const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      skipWhitespace(state);
      if (state.source[state.pos] === "}") {
        state.pos += 1;
        state.depth -= 1;
        return record;
      }
      while (true) {
        const key = readString(state);
        if (seen.has(key)) {
          parseFail(`duplicate key ${JSON.stringify(key)}`);
        }
        seen.add(key);
        expect(state, ":");
        record[key] = readValue(state);
        skipWhitespace(state);
        const next = state.source[state.pos];
        state.pos += 1;
        if (next === "}") break;
        if (next !== ",") parseFail(`expected "," or "}" at ${state.pos - 1}`);
      }
      state.depth -= 1;
      return record;
    }
    case "[": {
      state.depth += 1;
      state.pos += 1;
      const array: unknown[] = [];
      skipWhitespace(state);
      if (state.source[state.pos] === "]") {
        state.pos += 1;
        state.depth -= 1;
        return array;
      }
      while (true) {
        array.push(readValue(state));
        skipWhitespace(state);
        const next = state.source[state.pos];
        state.pos += 1;
        if (next === "]") break;
        if (next !== ",") parseFail(`expected "," or "]" at ${state.pos - 1}`);
      }
      state.depth -= 1;
      return array;
    }
    case '"':
      return readString(state);
    case "t":
      consumeWord(state, "true");
      return true;
    case "f":
      consumeWord(state, "false");
      return false;
    case "n":
      consumeWord(state, "null");
      return null;
    default:
      return readNumber(state);
  }
}

function consumeWord(state: ParseState, word: string): void {
  for (let i = 0; i < word.length; i++) {
    if (state.source[state.pos + i] !== word[i]) parseFail(`invalid literal near ${state.pos}`);
  }
  state.pos += word.length;
}

/**
 * Parse one complete JSON document strictly: duplicate keys, trailing
 * content, malformed syntax and resource-bound violations all fail closed
 * with resolver-controlled errors.
 */
export function parseResultJsonStrict(text: string): unknown {
  if (text.length > RESOURCE_LIMITS.MAX_CANONICAL_BYTES) {
    limitFail("MAX_CANONICAL_BYTES", `document exceeds ${RESOURCE_LIMITS.MAX_CANONICAL_BYTES} bytes`);
  }
  const state: ParseState = { source: text, pos: 0, depth: 0, nodes: 0 };
  const value = readValue(state);
  skipWhitespace(state);
  if (state.pos !== text.length) parseFail("trailing content after JSON value");
  return value;
}
