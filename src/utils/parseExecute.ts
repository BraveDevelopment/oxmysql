import type { CFXParameters } from '../types';
import { normaliseValues } from './parseArguments';

export { statementType as executeType } from './sql';

/** Arrays and plain objects (Lua tables) are parameter sets; Buffers, Dates etc. are values. */
const isParameterSet = (value: unknown): value is object =>
  Array.isArray(value) ||
  (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype);

/** Converts a Lua-style `{ [1] = a, [3] = c }` object into a positional array. */
function toArray(value: object, placeholders: number) {
  if (Array.isArray(value)) return value;

  const arr: unknown[] = new Array(placeholders);

  for (const key in value) {
    const index = parseInt(key, 10);
    if (!Number.isInteger(index) || index < 1) throw new Error(`Invalid parameter key '${key}', expected 1-based indexes.`);
    arr[index - 1] = (value as Record<string, unknown>)[key];
  }

  return arr;
}

/**
 * Normalises prepare/rawExecute parameters into a list of parameter sets.
 * - `[a, b]` / `{ [1] = a, [2] = b }` -> one set
 * - `[[a, b], [c, d]]` / `[{ [1] = a }, ...]` -> one set per entry (batch)
 */
export const parseExecute = (placeholders: number, parameters: CFXParameters): unknown[][] => {
  if (!parameters || typeof parameters !== 'object') return [normaliseValues([], placeholders)];

  let list: unknown[] = toArray(parameters, placeholders);

  if (list.length === 0) return [normaliseValues([], placeholders)];

  const isBatch = placeholders > 0 && list.every(isParameterSet);

  if (!isBatch) list = [list];

  return list.map((set) => {
    const values = toArray(set as object, placeholders);

    if (placeholders > 0 && values.length > placeholders)
      throw new Error(`Expected ${placeholders} parameters, but received ${values.length}.`);

    return normaliseValues(values, placeholders);
  });
};
