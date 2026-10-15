import { describe, test, expect } from 'bun:test';
import { normaliseValues, parseArguments } from 'utils/parseArguments';

describe('parseArguments', () => {
  test('throws on a non-string query', () => {
    expect(() => parseArguments(123 as any, [])).toThrow('Expected query to be a string but received number');
  });

  describe('placeholder counting', () => {
    test('counts value placeholders', () => {
      expect(parseArguments('SELECT ?, ?', [1, 2])[1]).toEqual([1, 2]);
    });

    test('counts an identifier placeholder (??) once', () => {
      expect(parseArguments('SELECT * FROM ??', ['users'])[1]).toEqual(['users']);
    });

    test('ignores ? inside strings, identifiers and comments', () => {
      const sql = "SELECT '?', \"?\", `a?b` -- ?\n/* ? */ # ?\nFROM t WHERE a = ?";
      expect(parseArguments(sql, [1])[1]).toEqual([1]);
    });

    test('no placeholders leaves an empty array untouched', () => {
      expect(parseArguments('SELECT 1', [])).toEqual(['SELECT 1', []]);
    });
  });

  describe('array parameters', () => {
    test('empty array is filled with nulls to the placeholder count', () => {
      expect(parseArguments('SELECT ?, ?', [])[1]).toEqual([null, null]);
    });

    test('too few parameters are padded with null', () => {
      expect(parseArguments('SELECT ?, ?, ?', ['a'])[1]).toEqual(['a', null, null]);
    });

    test('undefined values (JS sparse arrays) become null', () => {
      // eslint-disable-next-line no-sparse-arrays
      expect(parseArguments('SELECT ?, ?', [, 'b'])[1]).toEqual([null, 'b']);
    });

    test('too many parameters throw with the expected/received counts', () => {
      expect(() => parseArguments('SELECT ?', [1, 2])).toThrow('Expected 1 parameters, but received 2.');
    });

    test('bulk insert with VALUES ? and nested rows is passed through', () => {
      const rows = [
        [1, 'a'],
        [2, 'b'],
      ];
      expect(parseArguments('INSERT INTO t (id, name) VALUES ?', [rows])[1]).toEqual([rows]);
    });
  });

  describe('numeric-keyed object parameters (Lua tables with holes)', () => {
    test('maps 1-based keys to positional values, missing keys become null', () => {
      expect(parseArguments('SELECT ?, ?', { 1: 'a', 2: 'b' } as any)[1]).toEqual(['a', 'b']);
      expect(parseArguments('SELECT ?, ?', { 1: 'a' } as any)[1]).toEqual(['a', null]);
    });
  });

  describe('named placeholders', () => {
    test('converts :name and @name, with or without prefixed keys', () => {
      expect(parseArguments('SELECT :a, @b, :a', { a: 1, '@b': 2 } as any)).toEqual(['SELECT ?, ?, ?', [1, 2, 1]]);
    });

    test('a missing :name binds NULL (Lua tables cannot hold nil)', () => {
      expect(parseArguments('UPDATE t SET a = :a WHERE id = :id', { id: 5 } as any)).toEqual([
        'UPDATE t SET a = ? WHERE id = ?',
        [null, 5],
      ]);
    });

    test('leaves MySQL user and system variables alone', () => {
      const sql = 'SELECT @rank := @rank + 1, @@version, name FROM t WHERE id = :id';
      expect(parseArguments(sql, { id: 1 } as any)).toEqual([
        'SELECT @rank := @rank + 1, @@version, name FROM t WHERE id = ?',
        [1],
      ]);
    });

    test('does not touch colons inside strings', () => {
      expect(parseArguments("SELECT '12:30', ':x' FROM t WHERE id = :id", { id: 1 } as any)).toEqual([
        "SELECT '12:30', ':x' FROM t WHERE id = ?",
        [1],
      ]);
    });

    test('refuses to mix ? and named placeholders', () => {
      expect(() => parseArguments('SELECT ? , :a', { a: 1 } as any)).toThrow('cannot mix');
    });
  });
});

describe('normaliseValues (strict mode)', () => {
  test('throws on too few values or undefined', () => {
    expect(() => normaliseValues([1], 2, true)).toThrow('Expected 2 parameters, but received 1.');
    expect(() => normaliseValues([1, undefined], 2, true)).toThrow('Parameter 2 is undefined.');
  });

  test('lenient mode pads with null', () => {
    expect(normaliseValues([1], 2, false)).toEqual([1, null]);
  });
});
