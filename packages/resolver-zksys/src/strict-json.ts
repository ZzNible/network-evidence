/** Bounded duplicate-rejecting JSON and JSON-RPC parser for archived bytes. */

import { RESOURCE_LIMITS } from "@nec/core";

import { zksysFail } from "./errors.js";

class Cursor {
  readonly text: string;
  position = 0;
  nodes = 0;

  constructor(text: string, readonly path: string) {
    if (Buffer.byteLength(text, "utf8") > RESOURCE_LIMITS.MAX_CANONICAL_BYTES) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} exceeds the JSON byte limit`);
    }
    this.text = text;
  }

  fail(detail: string): never {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${this.path}: ${detail} at character ${this.position}`);
  }

  whitespace(): void {
    while (this.position < this.text.length && /[\u0020\u0009\u000a\u000d]/.test(this.text[this.position]!)) {
      this.position += 1;
    }
  }

  take(expected: string): void {
    this.whitespace();
    if (this.text[this.position] !== expected) this.fail(`expected ${JSON.stringify(expected)}`);
    this.position += 1;
  }
}

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hexNibble(char: string | undefined, cursor: Cursor): number {
  if (char !== undefined && char >= "0" && char <= "9") return char.charCodeAt(0) - 0x30;
  if (char !== undefined && char >= "a" && char <= "f") return char.charCodeAt(0) - 0x61 + 10;
  if (char !== undefined && char >= "A" && char <= "F") return char.charCodeAt(0) - 0x41 + 10;
  return cursor.fail("invalid unicode escape");
}

function readString(cursor: Cursor): string {
  cursor.take('"');
  let output = "";
  while (cursor.position < cursor.text.length) {
    const char = cursor.text[cursor.position]!;
    cursor.position += 1;
    if (char === '"') {
      if (!wellFormed(output)) cursor.fail("unpaired unicode surrogate in string");
      if (Buffer.byteLength(output, "utf8") > RESOURCE_LIMITS.MAX_STRING_UTF8_BYTES) {
        cursor.fail("string exceeds the byte limit");
      }
      return output;
    }
    if (char.charCodeAt(0) < 0x20) cursor.fail("raw control character in string");
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = cursor.text[cursor.position];
    cursor.position += 1;
    switch (escaped) {
      case '"': output += '"'; break;
      case "\\": output += "\\"; break;
      case "/": output += "/"; break;
      case "b": output += "\b"; break;
      case "f": output += "\f"; break;
      case "n": output += "\n"; break;
      case "r": output += "\r"; break;
      case "t": output += "\t"; break;
      case "u": {
        let code = 0;
        for (let i = 0; i < 4; i++) {
          code = code * 16 + hexNibble(cursor.text[cursor.position], cursor);
          cursor.position += 1;
        }
        output += String.fromCharCode(code);
        break;
      }
      default: cursor.fail("invalid string escape");
    }
  }
  return cursor.fail("unterminated string");
}

function literal(cursor: Cursor, word: string, value: unknown): unknown {
  if (cursor.text.slice(cursor.position, cursor.position + word.length) !== word) {
    cursor.fail(`invalid literal (expected ${word})`);
  }
  cursor.position += word.length;
  return value;
}

function readNumber(cursor: Cursor): number {
  const start = cursor.position;
  if (cursor.text[cursor.position] === "-") cursor.position += 1;
  if (cursor.text[cursor.position] === "0") {
    cursor.position += 1;
    const next = cursor.text[cursor.position];
    if (next !== undefined && next >= "0" && next <= "9") cursor.fail("leading zero in number");
  } else {
    const first = cursor.text[cursor.position];
    if (first === undefined || first < "1" || first > "9") cursor.fail("invalid number");
    while (cursor.text[cursor.position] !== undefined && cursor.text[cursor.position]! >= "0" && cursor.text[cursor.position]! <= "9") {
      cursor.position += 1;
    }
  }
  const raw = cursor.text.slice(start, cursor.position);
  if (raw === "-0") cursor.fail("negative zero is outside this RPC profile");
  if (cursor.text[cursor.position] === "." || cursor.text[cursor.position] === "e" || cursor.text[cursor.position] === "E") {
    cursor.fail("non-integer JSON numbers are outside this RPC profile");
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) cursor.fail("unsafe integer is outside this RPC profile");
  return number;
}

function readValue(cursor: Cursor, depth: number): unknown {
  if (depth > RESOURCE_LIMITS.MAX_DEPTH) cursor.fail("JSON nesting limit exceeded");
  cursor.nodes += 1;
  if (cursor.nodes > RESOURCE_LIMITS.MAX_TOTAL_NODES) cursor.fail("JSON node limit exceeded");
  cursor.whitespace();
  const char = cursor.text[cursor.position];
  if (char === '"') return readString(cursor);
  if (char === "{") return readObject(cursor, depth + 1);
  if (char === "[") return readArray(cursor, depth + 1);
  if (char === "t") return literal(cursor, "true", true);
  if (char === "f") return literal(cursor, "false", false);
  if (char === "n") return literal(cursor, "null", null);
  if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return readNumber(cursor);
  return cursor.fail("invalid JSON value");
}

function readArray(cursor: Cursor, depth: number): unknown[] {
  cursor.take("[");
  cursor.whitespace();
  const output: unknown[] = [];
  if (cursor.text[cursor.position] === "]") {
    cursor.position += 1;
    return output;
  }
  while (true) {
    if (output.length >= RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) cursor.fail("array entry limit exceeded");
    output.push(readValue(cursor, depth));
    cursor.whitespace();
    const separator = cursor.text[cursor.position];
    cursor.position += 1;
    if (separator === "]") return output;
    if (separator !== ",") cursor.fail('expected "," or "]"');
  }
}

function readObject(cursor: Cursor, depth: number): Record<string, unknown> {
  cursor.take("{");
  cursor.whitespace();
  const output: Record<string, unknown> = {};
  const seen = new Set<string>();
  if (cursor.text[cursor.position] === "}") {
    cursor.position += 1;
    return output;
  }
  while (true) {
    if (seen.size >= RESOURCE_LIMITS.MAX_CONTAINER_ENTRIES) cursor.fail("object member limit exceeded");
    const key = readString(cursor);
    if (seen.has(key)) cursor.fail(`duplicate object member ${JSON.stringify(key)}`);
    seen.add(key);
    cursor.take(":");
    Object.defineProperty(output, key, {
      value: readValue(cursor, depth), enumerable: true, writable: true, configurable: true,
    });
    cursor.whitespace();
    const separator = cursor.text[cursor.position];
    cursor.position += 1;
    if (separator === "}") return output;
    if (separator !== ",") cursor.fail('expected "," or "}"');
  }
}

export function parseStrictJson(text: string, path: string): unknown {
  const cursor = new Cursor(text, path);
  const value = readValue(cursor, 1);
  cursor.whitespace();
  if (cursor.position !== text.length) cursor.fail("trailing content after JSON value");
  return value;
}

function exactMembers(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} has unexpected member ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} is missing ${JSON.stringify(key)}`);
    }
  }
  return record;
}

export type RpcId = string | number | null;

export interface StrictRpcExchange {
  readonly requestText: string;
  readonly responseText: string;
  readonly request: Record<string, unknown>;
  readonly response: Record<string, unknown>;
  readonly observationKind: "historical_replay";
}

function rpcId(value: unknown, path: string): RpcId {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} must be a safe number, string, or null`);
}

export function parseStrictRpcExchange(text: string, path: string): StrictRpcExchange {
  const envelope = exactMembers(
    parseStrictJson(text, path),
    ["request", "response", "observationKind"],
    ["request", "response", "observationKind"],
    path,
  );
  if (typeof envelope.request !== "string" || typeof envelope.response !== "string") {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} request/response must contain exact JSON strings`);
  }
  if (envelope.observationKind !== "historical_replay") {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} must be historical_replay`);
  }
  const request = exactMembers(
    parseStrictJson(envelope.request, `${path}.request`),
    ["jsonrpc", "id", "method", "params"],
    ["jsonrpc", "id", "method", "params"],
    `${path}.request`,
  );
  const response = exactMembers(
    parseStrictJson(envelope.response, `${path}.response`),
    ["jsonrpc", "id", "result"],
    ["jsonrpc", "id", "result"],
    `${path}.response`,
  );
  if (request.jsonrpc !== "2.0" || response.jsonrpc !== "2.0") {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} requires JSON-RPC 2.0`);
  }
  const requestId = rpcId(request.id, `${path}.request.id`);
  const responseId = rpcId(response.id, `${path}.response.id`);
  if (typeof requestId !== typeof responseId || requestId !== responseId) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} request/response IDs do not match exactly`);
  }
  if (typeof request.method !== "string" || !Array.isArray(request.params)) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} request method/params shape is invalid`);
  }
  if (response.result === null) {
    zksysFail("ZKSYS_OBSERVATION_INCOMPLETE", `${path} positive result must not be null`);
  }
  return {
    requestText: envelope.request,
    responseText: envelope.response,
    request,
    response,
    observationKind: "historical_replay",
  };
}
