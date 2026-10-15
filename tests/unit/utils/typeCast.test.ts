import { describe, test, expect, mock } from 'bun:test';
import { createTypeCast, normaliseTimezone, parseDateTime, sessionTimezone } from 'utils/typeCast';

type FieldOpts = {
  type: string;
  length?: number;
  charset?: number;
  string?: () => string | null;
  buffer?: () => Buffer | null;
};

function field(opts: FieldOpts) {
  return {
    type: opts.type,
    length: opts.length ?? 0,
    charset: opts.charset ?? 33, // utf8 by default
    string: opts.string ?? (() => null),
    buffer: opts.buffer ?? (() => null),
  } as any;
}

const BINARY_CHARSET = 63;
const typeCast = createTypeCast('local');

describe('parseDateTime', () => {
  test('interprets values in the host timezone for "local"', () => {
    expect(parseDateTime('2024-01-02 03:04:05', 'local')).toBe(new Date(2024, 0, 2, 3, 4, 5).getTime());
    expect(parseDateTime('2024-01-02', 'local')).toBe(new Date(2024, 0, 2).getTime());
  });

  test('interprets values in a fixed zone independent of the host', () => {
    expect(parseDateTime('2024-01-02 03:04:05', 'Z')).toBe(Date.UTC(2024, 0, 2, 3, 4, 5));
    expect(parseDateTime('2024-01-02 03:04:05', '+02:00')).toBe(Date.UTC(2024, 0, 2, 1, 4, 5));
    expect(parseDateTime('2024-01-02 03:04:05', '-05:30')).toBe(Date.UTC(2024, 0, 2, 8, 34, 5));
  });

  test('keeps fractional seconds as milliseconds', () => {
    expect(parseDateTime('2024-01-02 03:04:05.123456', 'Z')).toBe(Date.UTC(2024, 0, 2, 3, 4, 5, 123));
    expect(parseDateTime('2024-01-02 03:04:05.5', 'Z')).toBe(Date.UTC(2024, 0, 2, 3, 4, 5, 500));
  });

  test('handles years below 100 instead of mapping them to 19xx', () => {
    expect(new Date(parseDateTime('0050-06-01 00:00:00', 'Z')!).getUTCFullYear()).toBe(50);
  });

  test('zero dates, NULL and garbage return null', () => {
    expect(parseDateTime('0000-00-00 00:00:00', 'Z')).toBeNull();
    expect(parseDateTime('2024-00-10', 'Z')).toBeNull();
    expect(parseDateTime(null, 'Z')).toBeNull();
    expect(parseDateTime('yesterday', 'Z')).toBeNull();
  });
});

describe('timezone helpers', () => {
  test('normaliseTimezone accepts mysql2 formats', () => {
    expect(normaliseTimezone(undefined)).toBe('local');
    expect(normaliseTimezone('Z')).toBe('Z');
    expect(normaliseTimezone(' 02:00')).toBe('+02:00');
    expect(normaliseTimezone('-07:00')).toBe('-07:00');
  });

  test('normaliseTimezone warns and falls back on invalid input', () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    expect(normaliseTimezone('Europe/Berlin')).toBe('local');
    console.warn = original;
    expect(warn).toHaveBeenCalled();
  });

  test('sessionTimezone maps to SET time_zone values', () => {
    expect(sessionTimezone('local')).toBeNull();
    expect(sessionTimezone('Z')).toBe('+00:00');
    expect(sessionTimezone('+02:00')).toBe('+02:00');
  });
});

describe('typeCast (shared by text and binary protocol)', () => {
  test('DATETIME/TIMESTAMP/DATE become epoch milliseconds', () => {
    const next = mock(() => 'unused');
    expect(typeCast(field({ type: 'DATETIME', string: () => '2024-01-02 03:04:05' }), next)).toBe(
      new Date(2024, 0, 2, 3, 4, 5).getTime(),
    );
    expect(typeCast(field({ type: 'DATE', string: () => '2024-01-02' }), next)).toBe(new Date(2024, 0, 2).getTime());
    expect(next).not.toHaveBeenCalled();
  });

  test('uses the configured timezone', () => {
    const utc = createTypeCast('Z');
    expect(utc(field({ type: 'TIMESTAMP', string: () => '2024-01-02 03:04:05' }), mock(() => 0))).toBe(
      Date.UTC(2024, 0, 2, 3, 4, 5),
    );
  });

  test('a null date returns null', () => {
    expect(typeCast(field({ type: 'TIMESTAMP', string: () => null }), mock(() => 0))).toBeNull();
  });

  test('TINY(1) maps to a boolean, wider TINY defers to next()', () => {
    expect(typeCast(field({ type: 'TINY', length: 1, string: () => '1' }), mock(() => 0))).toBe(true);
    expect(typeCast(field({ type: 'TINY', length: 1, string: () => '0' }), mock(() => 0))).toBe(false);
    expect(typeCast(field({ type: 'TINY', length: 3, string: () => '7' }), () => 7)).toBe(7);
    expect(typeCast(field({ type: 'TINY', length: 1, string: () => null }), () => null)).toBe(null);
  });

  test('a consumed TINY/BIT field never falls through to next()', () => {
    const tinyNull = mock(() => 'shifted');
    typeCast(field({ type: 'TINY', length: 1, string: () => null }), tinyNull);
    expect(tinyNull).not.toHaveBeenCalled();

    const bitWide = mock(() => 'shifted');
    typeCast(field({ type: 'BIT', length: 2, buffer: () => Buffer.from([3, 0]) }), bitWide);
    expect(bitWide).not.toHaveBeenCalled();
  });

  test('BIT(1) maps to a boolean, wider BIT returns all bytes', () => {
    expect(typeCast(field({ type: 'BIT', length: 1, buffer: () => Buffer.from([1]) }), mock(() => 0))).toBe(true);
    expect(typeCast(field({ type: 'BIT', length: 1, buffer: () => Buffer.from([0]) }), mock(() => 0))).toBe(false);
    expect(typeCast(field({ type: 'BIT', length: 1, buffer: () => null }), () => null)).toBe(null);
    expect(typeCast(field({ type: 'BIT', length: 16, buffer: () => Buffer.from([1, 2]) }), () => null)).toEqual(
      Buffer.from([1, 2]),
    );
  });

  test('binary BLOB/VARBINARY values stay Buffers (msgpack sends them to Lua as byte strings)', () => {
    const blob = typeCast(
      field({ type: 'BLOB', charset: BINARY_CHARSET, buffer: () => Buffer.from([1, 2, 3]) }),
      mock(() => 0),
    );
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect([...(blob as Buffer)]).toEqual([1, 2, 3]);

    const varbinary = typeCast(
      field({ type: 'VAR_STRING', charset: BINARY_CHARSET, buffer: () => Buffer.from('ab') }),
      mock(() => 0),
    );
    expect(Buffer.isBuffer(varbinary)).toBe(true);
  });

  test('a NULL binary BLOB returns null', () => {
    expect(typeCast(field({ type: 'BLOB', charset: BINARY_CHARSET, buffer: () => null }), mock(() => 0))).toBeNull();
  });

  test('text BLOB (TEXT) and other types defer to next()', () => {
    const next = mock(() => 'defaulted');
    expect(typeCast(field({ type: 'BLOB', charset: 33 }), next)).toBe('defaulted');
    expect(typeCast(field({ type: 'VARCHAR' }), next)).toBe('defaulted');
    expect(next).toHaveBeenCalledTimes(2);
  });
});
