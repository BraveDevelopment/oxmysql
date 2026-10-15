import { describe, test, expect } from 'bun:test';
import { compileNamedPlaceholders, countPlaceholders, parseQuery } from 'utils/sql';

describe('countPlaceholders', () => {
  test('skips quoted strings with escapes and doubled quotes', () => {
    expect(countPlaceholders("SELECT 'it''s ?', 'a\\'?' , ?")).toBe(1);
  });

  test('only treats "-- " followed by whitespace as a comment', () => {
    expect(countPlaceholders('SELECT 1--?')).toBe(1);
    expect(countPlaceholders('SELECT 1 -- ?')).toBe(0);
  });

  test('handles unterminated strings and comments gracefully', () => {
    expect(countPlaceholders("SELECT '?")).toBe(0);
    expect(countPlaceholders('SELECT ? /* ?')).toBe(1);
  });

  test('caches parsed queries', () => {
    expect(parseQuery('SELECT ? AS cached')).toBe(parseQuery('SELECT ? AS cached'));
  });
});

describe('compileNamedPlaceholders', () => {
  test('returns null when nothing applies', () => {
    expect(compileNamedPlaceholders('SELECT 1', { a: 1 })).toBeNull();
    expect(compileNamedPlaceholders('SELECT @var', { a: 1 })).toBeNull();
  });

  test('supports numeric :1 style keys', () => {
    expect(compileNamedPlaceholders('SELECT :1, :2', { 1: 'a', 2: 'b' })).toEqual(['SELECT ?, ?', ['a', 'b']]);
  });

  test('strict mode throws on a missing :name', () => {
    expect(() => compileNamedPlaceholders('SELECT :missing', {}, { strict: true })).toThrow(
      "Missing value for named placeholder ':missing'",
    );
  });

  test('ignores :name inside backtick identifiers and comments', () => {
    expect(compileNamedPlaceholders('SELECT `a:b` /* :c */ FROM t WHERE x = :x', { x: 1 })).toEqual([
      'SELECT `a:b` /* :c */ FROM t WHERE x = ?',
      [1],
    ]);
  });
});
