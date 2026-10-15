import type { CFXParameters } from '../types';
import { mysql_strict_params, namedPlaceholdersEnabled } from '../config';
import { compileNamedPlaceholders, countPlaceholders } from './sql';

/** Replaces undefined with null (JS sparse arrays / missing values); throws instead in strict mode. */
export function normaliseValues(values: unknown[], placeholders: number, strict = mysql_strict_params) {
  if (strict && values.length < placeholders)
    throw new Error(`Expected ${placeholders} parameters, but received ${values.length}.`);

  const length = Math.max(values.length, placeholders);
  const output = new Array(length);

  for (let i = 0; i < length; i++) {
    const value = values[i];

    if (value === undefined) {
      if (strict) throw new Error(`Parameter ${i + 1} is undefined.`);
      output[i] = null;
    } else output[i] = value;
  }

  return output;
}

export const parseArguments = (query: string, parameters?: CFXParameters): [string, CFXParameters] => {
  if (typeof query !== 'string') throw new Error(`Expected query to be a string but received ${typeof query} instead.`);

  if (!parameters || typeof parameters === 'function') parameters = [];

  if (namedPlaceholdersEnabled && typeof parameters === 'object' && !Array.isArray(parameters)) {
    const compiled = compileNamedPlaceholders(query, parameters, { strict: mysql_strict_params });
    if (compiled) return compiled as [string, CFXParameters];
  }

  const placeholders = countPlaceholders(query);

  // Lua tables with holes arrive as objects keyed by 1-based index
  if (!Array.isArray(parameters)) {
    const arr: unknown[] = [];

    for (let i = 0; i < placeholders; i++) arr[i] = (parameters as Record<number, unknown>)[i + 1];

    parameters = arr;
  }

  if (parameters.length > placeholders && placeholders > 0)
    throw new Error(`Expected ${placeholders} parameters, but received ${parameters.length}.`);

  return [query, normaliseValues(parameters, placeholders)];
};
