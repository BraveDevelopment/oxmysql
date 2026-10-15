/**
 * Small SQL tokenizer used to find placeholders outside of string literals, quoted identifiers and comments.
 * Results are cached per query string, since FiveM resources run the same statements over and over.
 */

export type PlaceholderToken =
  | { kind: 'positional'; start: number; end: number }
  | { kind: 'identifier'; start: number; end: number }
  | { kind: 'named'; prefix: ':' | '@'; name: string; start: number; end: number };

export interface ParsedQuery {
  tokens: PlaceholderToken[];
  /** Number of `?` / `??` placeholders. */
  positional: number;
  /** Number of `:name` / `@name` candidates. */
  named: number;
}

const CACHE_SIZE = 1000;
const cache = new Map<string, ParsedQuery>();

const isIdentStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
const isIdentPart = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57) || c === 36; // + 0-9 $

function skipQuoted(sql: string, start: number, quote: string) {
  // handles backslash escapes and doubled quotes ('' / "" / ``)
  let i = start + 1;

  while (i < sql.length) {
    const char = sql[i];

    if (char === '\\' && quote !== '`') {
      i += 2;
      continue;
    }

    if (char === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }

      return i + 1;
    }

    i++;
  }

  return i;
}

function tokenize(sql: string): ParsedQuery {
  const tokens: PlaceholderToken[] = [];
  let positional = 0;
  let named = 0;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];

    if (char === "'" || char === '"' || char === '`') {
      i = skipQuoted(sql, i, char);
      continue;
    }

    // -- comment (MySQL requires whitespace or a control character after the dashes)
    if (char === '-' && sql[i + 1] === '-' && (i + 2 >= sql.length || sql.charCodeAt(i + 2) <= 32)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (char === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    if (char === '?') {
      if (sql[i + 1] === '?') {
        tokens.push({ kind: 'identifier', start: i, end: i + 2 });
        positional++;
        i += 2;
        continue;
      }

      tokens.push({ kind: 'positional', start: i, end: i + 1 });
      positional++;
      i++;
      continue;
    }

    if (char === ':' || char === '@') {
      const prev = i > 0 ? sql.charCodeAt(i - 1) : 0;
      const next = sql.charCodeAt(i + 1);

      // skip `@@system_var`, `a:b` inside identifiers and `:=`
      const prevIsWordish = isIdentPart(prev) || prev === 64 || prev === 58; // @ :
      const nextIsDigit = next >= 48 && next <= 57;

      if (!prevIsWordish && (isIdentStart(next) || (char === ':' && nextIsDigit))) {
        let end = i + 1;
        while (end < sql.length && isIdentPart(sql.charCodeAt(end))) end++;

        tokens.push({ kind: 'named', prefix: char, name: sql.slice(i + 1, end), start: i, end });
        named++;
        i = end;
        continue;
      }
    }

    i++;
  }

  return { tokens, positional, named };
}

export function parseQuery(sql: string): ParsedQuery {
  let parsed = cache.get(sql);

  if (parsed) {
    // refresh LRU position
    cache.delete(sql);
    cache.set(sql, parsed);
    return parsed;
  }

  parsed = tokenize(sql);

  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(sql, parsed);

  return parsed;
}

export function countPlaceholders(sql: string) {
  return parseQuery(sql).positional;
}

export interface CompileOptions {
  /** Throw on missing `:name` parameters instead of binding NULL. */
  strict?: boolean;
}

/**
 * Converts `:name` / `@name` placeholders into `?` and returns the ordered values.
 *
 * - `:name` and `:1` always become placeholders. A missing key binds NULL (Lua tables cannot hold nil),
 *   unless `strict` is enabled.
 * - `@name` only becomes a placeholder when the key exists in `params`; otherwise it is left untouched, so
 *   MySQL user variables (`@rank := @rank + 1`) keep working.
 * - Keys may be given with or without their prefix (`name`, `:name`, `@name`).
 *
 * Returns `null` when the query contains no named placeholders that apply.
 */
export function compileNamedPlaceholders(
  sql: string,
  params: Record<string, unknown>,
  options: CompileOptions = {},
): [string, unknown[]] | null {
  const parsed = parseQuery(sql);

  if (parsed.named === 0) return null;

  const lookup = (prefix: string, name: string): [boolean, unknown] => {
    if (name in params) return [true, params[name]];
    const prefixed = prefix + name;
    if (prefixed in params) return [true, params[prefixed]];
    return [false, undefined];
  };

  let output = '';
  let last = 0;
  let replaced = 0;
  const values: unknown[] = [];

  for (const token of parsed.tokens) {
    if (token.kind !== 'named') continue;

    const [found, value] = lookup(token.prefix, token.name);

    if (!found) {
      if (token.prefix === '@') continue; // MySQL user variable

      if (options.strict) throw new Error(`Missing value for named placeholder '${token.prefix}${token.name}'.`);
    }

    output += sql.slice(last, token.start) + '?';
    last = token.end;
    values.push(value === undefined ? null : value);
    replaced++;
  }

  if (replaced === 0) return null;

  if (parsed.positional > 0)
    throw new Error('Queries cannot mix positional (?) and named (:name / @name) placeholders.');

  return [output + sql.slice(last), values];
}

const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

/**
 * Returns 'insert' for INSERT/REPLACE, 'update' for UPDATE/DELETE and null otherwise.
 * Case-insensitive and tolerant of leading whitespace and comments.
 */
export function statementType(sql: string): 'insert' | 'update' | null {
  const start = sql.replace(LEADING_NOISE, '');
  const keyword = /^[a-z]+/i.exec(start)?.[0].toUpperCase();

  switch (keyword) {
    case 'INSERT':
    case 'REPLACE':
      return 'insert';
    case 'UPDATE':
    case 'DELETE':
      return 'update';
    default:
      return null;
  }
}
