/**
 * Strict JSON-RPC response envelope scanner.
 *
 * Purpose: extract the EXACT raw text of the `result` member (byte-exact,
 * including the provider's key order and whitespace) without ever parsing
 * it into JS values first — so no integer precision, ordering or formatting
 * evidence is silently lost by an intermediate representation.
 *
 * The scanner is a bounded, hand-written walker (explicit depth budget, no
 * eval, no unbounded recursion): hostile bodies fail closed with controlled
 * errors.
 *
 * Envelope acceptance domain (v1):
 *   {"jsonrpc":"2.0","id":<number|string|null>,"result":<value>} or
 *   {"jsonrpc":"2.0","id":<number|string|null>,"error":{"code":<int>,"message":<string>, ...}}
 * Unknown members are skipped; duplicate `result`/`error`/`id`/`jsonrpc`
 * members, a `jsonrpc` version other than exactly "2.0", an id outside the
 * number|string|null domain, and trailing content all fail closed.
 * The scanned `id` is exposed for request/response binding.
 */

import { RESOURCE_LIMITS } from "@nec/core";

import { NecResolverEvmError } from "./errors.js";

/** JSON-RPC 2.0 response id as scanned from raw text (absent = undefined). */
export type RpcResponseId = string | number | null | undefined;

export type RpcEnvelope =
  | { kind: "result"; resultText: string; id: RpcResponseId }
  | { kind: "error"; error: { code: number; message: string }; id: RpcResponseId };

const MAX_DEPTH = RESOURCE_LIMITS.MAX_DEPTH;

class Cursor {
  readonly text: string;
  pos: number;

  constructor(text: string) {
    this.text = text;
    this.pos = 0;
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.pos += 1;
      } else {
        break;
      }
    }
  }

  peek(): string {
    if (this.pos >= this.text.length) {
      throw new NecResolverEvmError(
        "EVM_MALFORMED_RESPONSE",
        `rpc envelope: unexpected end of body at ${this.pos}`,
      );
    }
    return this.text[this.pos] as string;
  }

  expect(ch: string): void {
    this.skipWhitespace();
    if (this.peek() !== ch) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `rpc envelope: expected "${ch}" at ${this.pos}`);
    }
    this.pos += 1;
  }

  atEnd(): boolean {
    this.skipWhitespace();
    return this.pos >= this.text.length;
  }
}

function decodeEscape(cursor: Cursor): string {
  // Cursor sits on the backslash.
  cursor.pos += 1;
  const c = cursor.peek();
  switch (c) {
    case '"':
      cursor.pos += 1;
      return '"';
    case "\\":
      cursor.pos += 1;
      return "\\";
    case "/":
      cursor.pos += 1;
      return "/";
    case "b":
      cursor.pos += 1;
      return "\b";
    case "f":
      cursor.pos += 1;
      return "\f";
    case "n":
      cursor.pos += 1;
      return "\n";
    case "r":
      cursor.pos += 1;
      return "\r";
    case "t":
      cursor.pos += 1;
      return "\t";
    case "u": {
      cursor.pos += 1;
      let code = 0;
      for (let i = 0; i < 4; i++) {
        const hex = cursor.peek();
        const nibble =
          hex >= "0" && hex <= "9"
            ? hex.charCodeAt(0) - 0x30
            : hex >= "a" && hex <= "f"
              ? hex.charCodeAt(0) - 0x61 + 10
              : hex >= "A" && hex <= "F"
                ? hex.charCodeAt(0) - 0x41 + 10
                : -1;
        if (nibble < 0) {
          throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: invalid \\u escape");
        }
        code = code * 16 + nibble;
        cursor.pos += 1;
      }
      return String.fromCharCode(code);
    }
    default:
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: invalid escape sequence");
  }
}

/** Reads a JSON string starting at the opening quote; returns decoded value. */
function readString(cursor: Cursor): string {
  cursor.expect('"');
  let out = "";
  while (true) {
    if (cursor.pos >= cursor.text.length) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: unterminated string");
    }
    const c = cursor.text[cursor.pos] as string;
    if (c === '"') {
      cursor.pos += 1;
      return out;
    }
    if (c === "\\") {
      out += decodeEscape(cursor);
      continue;
    }
    if (c.charCodeAt(0) < 0x20) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: raw control character in string");
    }
    out += c;
    cursor.pos += 1;
  }
}

function consumeWord(cursor: Cursor, word: string): void {
  for (let i = 0; i < word.length; i++) {
    if (cursor.text[cursor.pos + i] !== word[i]) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `rpc envelope: invalid literal near ${cursor.pos}`);
    }
  }
  cursor.pos += word.length;
}

function skipNumber(cursor: Cursor): void {
  const start = cursor.pos;
  if (cursor.peek() === "-") cursor.pos += 1;
  let digits = 0;
  while (cursor.pos < cursor.text.length) {
    const c = cursor.text[cursor.pos] as string;
    if (c >= "0" && c <= "9") {
      cursor.pos += 1;
      digits += 1;
    } else {
      break;
    }
  }
  if (digits === 0) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `rpc envelope: invalid number near ${start}`);
  }
  if (cursor.text[cursor.pos] === ".") {
    cursor.pos += 1;
    let frac = 0;
    while (cursor.pos < cursor.text.length && cursor.text[cursor.pos]! >= "0" && cursor.text[cursor.pos]! <= "9") {
      cursor.pos += 1;
      frac += 1;
    }
    if (frac === 0) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: number missing fraction digits");
    }
  }
  const e = cursor.text[cursor.pos];
  if (e === "e" || e === "E") {
    cursor.pos += 1;
    const sign = cursor.text[cursor.pos];
    if (sign === "+" || sign === "-") cursor.pos += 1;
    let expDigits = 0;
    while (cursor.pos < cursor.text.length && cursor.text[cursor.pos]! >= "0" && cursor.text[cursor.pos]! <= "9") {
      cursor.pos += 1;
      expDigits += 1;
    }
    if (expDigits === 0) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: number missing exponent digits");
    }
  }
}

function skipValue(cursor: Cursor, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new NecResolverEvmError("EVM_LIMIT_EXCEEDED", `rpc envelope: exceeds maximum depth of ${MAX_DEPTH}`);
  }
  cursor.skipWhitespace();
  const c = cursor.peek();
  switch (c) {
    case '"':
      readString(cursor);
      return;
    case "{": {
      cursor.pos += 1;
      cursor.skipWhitespace();
      if (cursor.peek() === "}") {
        cursor.pos += 1;
        return;
      }
      while (true) {
        readString(cursor); // key
        cursor.expect(":");
        skipValue(cursor, depth + 1);
        cursor.skipWhitespace();
        const next = cursor.peek();
        cursor.pos += 1;
        if (next === "}") return;
        if (next !== ",") {
          throw new NecResolverEvmError(
            "EVM_MALFORMED_RESPONSE",
            `rpc envelope: expected "," or "}" at ${cursor.pos - 1}`,
          );
        }
      }
    }
    case "[": {
      cursor.pos += 1;
      cursor.skipWhitespace();
      if (cursor.peek() === "]") {
        cursor.pos += 1;
        return;
      }
      while (true) {
        skipValue(cursor, depth + 1);
        cursor.skipWhitespace();
        const next = cursor.peek();
        cursor.pos += 1;
        if (next === "]") return;
        if (next !== ",") {
          throw new NecResolverEvmError(
            "EVM_MALFORMED_RESPONSE",
            `rpc envelope: expected "," or "]" at ${cursor.pos - 1}`,
          );
        }
      }
    }
    case "t":
      consumeWord(cursor, "true");
      return;
    case "f":
      consumeWord(cursor, "false");
      return;
    case "n":
      consumeWord(cursor, "null");
      return;
    default:
      skipNumber(cursor);
  }
}

interface TopLevelMembers {
  jsonrpcSeen: boolean;
  id?: RpcResponseId;
  sawId: boolean;
  resultText?: string;
  sawResult: boolean;
  errorCode?: unknown;
  errorMessage?: unknown;
  sawError: boolean;
}

/**
 * Read a JSON-RPC `id` value from raw text. Accepted domain:
 * string | integer (safe) | null. Anything else fails closed.
 */
function readIdValue(cursor: Cursor): string | number | null {
  cursor.skipWhitespace();
  const c = cursor.peek();
  if (c === '"') return readString(cursor);
  if (c === "n") {
    consumeWord(cursor, "null");
    return null;
  }
  if (c === "-" || (c >= "0" && c <= "9")) {
    const start = cursor.pos;
    skipNumber(cursor);
    const raw = cursor.text.slice(start, cursor.pos);
    // Integers only; floats/exponents/overflowing magnitudes are rejected.
    if (!/^-?(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new NecResolverEvmError(
        "EVM_MALFORMED_RESPONSE",
        'rpc envelope: "id" must be a number, string or null',
      );
    }
    return Number(raw);
  }
  throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", 'rpc envelope: "id" must be a number, string or null');
}

function readTopLevelObject(cursor: Cursor): TopLevelMembers {
  cursor.expect("{");
  cursor.skipWhitespace();
  const members: TopLevelMembers = { jsonrpcSeen: false, sawId: false, sawResult: false, sawError: false };
  if (cursor.peek() === "}") {
    cursor.pos += 1;
    return members;
  }
  while (true) {
    const key = readString(cursor);
    cursor.expect(":");
    if (key === "jsonrpc") {
      if (members.jsonrpcSeen) {
        duplicateMember(key);
      }
      members.jsonrpcSeen = true;
      cursor.skipWhitespace();
      const start = cursor.pos;
      skipValue(cursor, 1);
      if (cursor.text.slice(start, cursor.pos).trim() !== '"2.0"') {
        throw new NecResolverEvmError(
          "EVM_MALFORMED_RESPONSE",
          'rpc envelope: "jsonrpc" must be exactly "2.0"',
        );
      }
    } else if (key === "id") {
      if (members.sawId) {
        duplicateMember(key);
      }
      members.sawId = true;
      members.id = readIdValue(cursor);
    } else if (key === "result") {
      if (members.sawResult || members.sawError) {
        duplicateMember(key);
      }
      cursor.skipWhitespace();
      const start = cursor.pos;
      skipValue(cursor, 1);
      members.resultText = cursor.text.slice(start, cursor.pos);
      members.sawResult = true;
    } else if (key === "error") {
      if (members.sawResult || members.sawError) {
        duplicateMember(key);
      }
      const parsed = readErrorObject(cursor, 1);
      members.errorCode = parsed.code;
      members.errorMessage = parsed.message;
      members.sawError = true;
    } else {
      skipValue(cursor, 1);
    }
    cursor.skipWhitespace();
    const next = cursor.peek();
    cursor.pos += 1;
    if (next === "}") return members;
    if (next !== ",") {
      throw new NecResolverEvmError(
        "EVM_MALFORMED_RESPONSE",
        `rpc envelope: expected "," or "}" at ${cursor.pos - 1}`,
      );
    }
  }
}

function duplicateMember(key: string): never {
  throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", `rpc envelope: duplicate "${key}" member`);
}

function readErrorObject(cursor: Cursor, depth: number): { code: unknown; message: unknown } {
  if (depth > MAX_DEPTH) {
    throw new NecResolverEvmError("EVM_LIMIT_EXCEEDED", "rpc envelope: error object nested too deeply");
  }
  cursor.expect("{");
  cursor.skipWhitespace();
  let code: unknown;
  let message: unknown;
  let sawCode = false;
  let sawMessage = false;
  if (cursor.peek() === "}") {
    cursor.pos += 1;
  } else {
    while (true) {
      const key = readString(cursor);
      cursor.expect(":");
      if (key === "code" && !sawCode) {
        cursor.skipWhitespace();
        const start = cursor.pos;
        skipValue(cursor, depth + 1);
        const raw = cursor.text.slice(start, cursor.pos).trim();
        code = /^-?(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : Number.NaN;
        sawCode = true;
      } else if (key === "message" && !sawMessage) {
        message = readString(cursor);
        sawMessage = true;
      } else {
        skipValue(cursor, depth + 1);
      }
      cursor.skipWhitespace();
      const next = cursor.peek();
      cursor.pos += 1;
      if (next === "}") break;
      if (next !== ",") {
        throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: malformed error object");
      }
    }
  }
  if (!sawCode || !sawMessage) {
    throw new NecResolverEvmError(
      "EVM_MALFORMED_RESPONSE",
      'rpc envelope: JSON-RPC error requires "code" and "message"',
    );
  }
  return { code, message };
}

/**
 * Scan a complete HTTP response body as ONE strict JSON-RPC 2.0 response
 * envelope and classify it. The body must be exactly one envelope object
 * carrying either `result` or `error`.
 */
export function scanRpcEnvelope(bodyText: string): RpcEnvelope {
  if (bodyText.length > RESOURCE_LIMITS.MAX_CANONICAL_BYTES) {
    throw new NecResolverEvmError(
      "EVM_LIMIT_EXCEEDED",
      `rpc envelope: response body exceeds ${RESOURCE_LIMITS.MAX_CANONICAL_BYTES} bytes`,
    );
  }
  const cursor = new Cursor(bodyText);
  const members = readTopLevelObject(cursor);
  if (!cursor.atEnd()) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", "rpc envelope: trailing content after JSON value");
  }
  if (!members.jsonrpcSeen) {
    throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", 'rpc envelope: missing "jsonrpc" member');
  }
  const id: RpcResponseId = members.sawId ? members.id : undefined;
  if (members.sawResult && members.resultText !== undefined) {
    return { kind: "result", resultText: members.resultText, id };
  }
  if (members.sawError) {
    const code = members.errorCode;
    const message = members.errorMessage;
    if (typeof code !== "number" || !Number.isSafeInteger(code)) {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", 'rpc envelope: "error.code" must be an integer');
    }
    if (typeof message !== "string") {
      throw new NecResolverEvmError("EVM_MALFORMED_RESPONSE", 'rpc envelope: "error.message" must be a string');
    }
    return { kind: "error", error: { code, message }, id };
  }
  throw new NecResolverEvmError(
    "EVM_MALFORMED_RESPONSE",
    'rpc envelope: response carries neither "result" nor "error"',
  );
}
