import { describe, test, expect } from 'bun:test';
import { executeType, parseExecute } from 'utils/parseExecute';

describe('executeType', () => {
  test('maps INSERT/REPLACE and UPDATE/DELETE', () => {
    expect(executeType('INSERT INTO t VALUES (?)')).toBe('insert');
    expect(executeType('REPLACE INTO t VALUES (?)')).toBe('insert');
    expect(executeType('UPDATE t SET a = ?')).toBe('update');
    expect(executeType('DELETE FROM t WHERE id = ?')).toBe('update');
  });

  test('returns null for SELECT and other verbs', () => {
    expect(executeType('SELECT * FROM t')).toBeNull();
    expect(executeType('CALL proc()')).toBeNull();
  });

  test('is case-insensitive and skips leading whitespace and comments', () => {
    expect(executeType('insert into t values (?)')).toBe('insert');
    expect(executeType('\n\t  Update t set a = 1')).toBe('update');
    expect(executeType('-- note\n/* block */ # hash\nDELETE FROM t')).toBe('update');
    expect(executeType('INSERT')).toBe('insert');
  });
});

describe('parseExecute', () => {
  test('missing parameters run once, padded with null', () => {
    expect(parseExecute(2, null as any)).toEqual([[null, null]]);
    expect(parseExecute(0, [])).toEqual([[]]);
  });

  test('array-of-arrays is a batch', () => {
    expect(parseExecute(2, [[1, 2], [3, 4]])).toEqual([[1, 2], [3, 4]]);
  });

  test('array-of-objects becomes positional rows with missing values as null', () => {
    expect(parseExecute(2, [{ 1: 'a', 2: 'b' }, { 1: 'c' }] as any)).toEqual([['a', 'b'], ['c', null]]);
  });

  test('a flat scalar array is a single set', () => {
    expect(parseExecute(2, [1, 2])).toEqual([[1, 2]]);
  });

  test('null values do not turn a single set into a batch', () => {
    expect(parseExecute(2, [null, null])).toEqual([[null, null]]);
  });

  test('Buffers and Dates are values, not parameter sets', () => {
    const buffer = Buffer.from([1, 2]);
    const date = new Date(0);
    expect(parseExecute(2, [buffer, date])).toEqual([[buffer, date]]);
  });

  test('a single positional object is normalised', () => {
    expect(parseExecute(2, { 1: 'a', 2: 'b' } as any)).toEqual([['a', 'b']]);
  });

  test('rejects too many values and non-numeric keys', () => {
    expect(() => parseExecute(1, [[1, 2]])).toThrow('Expected 1 parameters');
    expect(() => parseExecute(1, [{ name: 'x' }] as any)).toThrow("Invalid parameter key 'name'");
  });
});
