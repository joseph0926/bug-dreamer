import { createHash } from 'node:crypto';

import canonicalize from 'canonicalize';

export const WIRE_LIMITS = Object.freeze({
  inputBytes: 256 * 1024,
  actors: 16,
  actions: 64,
  fixtures: 16,
  scheduleControls: 128,
  depth: 16,
  stringBytes: 8 * 1024,
  collectionEntries: 128,
});

export class V03WireError extends Error {}

function fail(message) {
  throw new V03WireError(message);
}

function stringBytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('Invalid Unicode surrogate');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail('Invalid Unicode surrogate');
    }
  }
}

class StrictJsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse() {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) fail('Trailing JSON data');
    return value;
  }

  skipWhitespace() {
    while (' \n\r\t'.includes(this.source[this.index])) this.index += 1;
  }

  parseValue(depth) {
    this.skipWhitespace();
    const token = this.source[this.index];
    if (token === '{') return this.parseObject(depth + 1);
    if (token === '[') return this.parseArray(depth + 1);
    if (token === '"') return this.parseString();
    if (token === 't') return this.parseLiteral('true', true);
    if (token === 'f') return this.parseLiteral('false', false);
    if (token === 'n') return this.parseLiteral('null', null);
    if (token === '-' || (token >= '0' && token <= '9')) return this.parseNumber();
    fail(`Invalid JSON token at ${this.index}`);
  }

  parseObject(depth) {
    if (depth > WIRE_LIMITS.depth) fail('JSON nesting depth exceeded');
    this.index += 1;
    this.skipWhitespace();
    const value = {};
    const keys = new Set();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return value;
    }
    let entries = 0;
    while (true) {
      if (this.source[this.index] !== '"') fail('Object key must be a string');
      const key = this.parseString();
      if (keys.has(key)) fail(`Duplicate JSON key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ':') fail('Object key is missing a colon');
      this.index += 1;
      Object.defineProperty(value, key, {
        value: this.parseValue(depth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      entries += 1;
      if (entries > WIRE_LIMITS.collectionEntries) fail('JSON collection entry limit exceeded');
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === '}') {
        this.index += 1;
        return value;
      }
      if (separator !== ',') fail('Object entry is missing a comma');
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseArray(depth) {
    if (depth > WIRE_LIMITS.depth) fail('JSON nesting depth exceeded');
    this.index += 1;
    this.skipWhitespace();
    const value = [];
    if (this.source[this.index] === ']') {
      this.index += 1;
      return value;
    }
    while (true) {
      value.push(this.parseValue(depth));
      if (value.length > WIRE_LIMITS.collectionEntries) fail('JSON collection entry limit exceeded');
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === ']') {
        this.index += 1;
        return value;
      }
      if (separator !== ',') fail('Array entry is missing a comma');
      this.index += 1;
    }
  }

  parseString() {
    this.index += 1;
    let value = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        assertUnicode(value);
        if (stringBytes(value) > WIRE_LIMITS.stringBytes) fail('JSON string byte limit exceeded');
        return value;
      }
      if (character === '\\') {
        this.index += 1;
        value += this.parseEscape();
        continue;
      }
      const unit = this.source.charCodeAt(this.index);
      if (unit < 0x20) fail('Unescaped control character in JSON string');
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = this.source.charCodeAt(this.index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('Invalid Unicode surrogate');
        value += this.source.slice(this.index, this.index + 2);
        this.index += 2;
      } else {
        if (unit >= 0xdc00 && unit <= 0xdfff) fail('Invalid Unicode surrogate');
        value += character;
        this.index += 1;
      }
    }
    fail('Unterminated JSON string');
  }

  parseEscape() {
    const escape = this.source[this.index];
    this.index += 1;
    const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (Object.hasOwn(simple, escape)) return simple[escape];
    if (escape !== 'u') fail('Invalid JSON escape');
    const first = this.parseHexUnit();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.source.slice(this.index, this.index + 2) !== '\\u') fail('Invalid Unicode surrogate escape');
      this.index += 2;
      const second = this.parseHexUnit();
      if (!(second >= 0xdc00 && second <= 0xdfff)) fail('Invalid Unicode surrogate escape');
      return String.fromCharCode(first, second);
    }
    if (first >= 0xdc00 && first <= 0xdfff) fail('Invalid Unicode surrogate escape');
    return String.fromCharCode(first);
  }

  parseHexUnit() {
    const hex = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Invalid Unicode escape');
    this.index += 4;
    return Number.parseInt(hex, 16);
  }

  parseLiteral(source, value) {
    if (this.source.slice(this.index, this.index + source.length) !== source) fail('Invalid JSON literal');
    this.index += source.length;
    return value;
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) fail('Invalid JSON number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail('JSON number is not finite');
    if (Object.is(value, -0)) fail('Negative zero is forbidden');
    return value;
  }
}

export function parseJsonBytes(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength > WIRE_LIMITS.inputBytes) fail('JSON input byte limit exceeded');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('JSON input is not valid UTF-8');
  }
  return new StrictJsonParser(source).parse();
}

export function validateJsonValueLimits(value, depth = 0) {
  if (typeof value === 'string') {
    assertUnicode(value);
    if (stringBytes(value) > WIRE_LIMITS.stringBytes) fail('JSON string byte limit exceeded');
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('Invalid JSON number value');
    return value;
  }
  if (Array.isArray(value)) {
    if (depth + 1 > WIRE_LIMITS.depth) fail('JSON nesting depth exceeded');
    if (value.length > WIRE_LIMITS.collectionEntries) fail('JSON collection entry limit exceeded');
    for (const item of value) validateJsonValueLimits(item, depth + 1);
    return value;
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (depth + 1 > WIRE_LIMITS.depth) fail('JSON nesting depth exceeded');
    const entries = Object.entries(value);
    if (entries.length > WIRE_LIMITS.collectionEntries) fail('JSON collection entry limit exceeded');
    for (const [key, item] of entries) {
      validateJsonValueLimits(key, depth + 1);
      validateJsonValueLimits(item, depth + 1);
    }
    return value;
  }
  fail('Value is not JSON data');
}

export function canonicalJson(value) {
  validateJsonValueLimits(value);
  try {
    return canonicalize(value);
  } catch (error) {
    fail(`JCS canonicalization failed: ${error.message}`);
  }
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function domainDigest(domain, value) {
  if (typeof domain !== 'string' || domain.length === 0 || domain.includes('\0')) fail('Invalid digest domain');
  return createHash('sha256').update(`${domain}\0`, 'utf8').update(canonicalBytes(value)).digest('hex');
}
