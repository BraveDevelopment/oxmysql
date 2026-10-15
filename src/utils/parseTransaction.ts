import type { CFXParameters, TransactionQuery, TransactionStatement } from '../types';
import { parseArguments } from './parseArguments';

/**
 * Accepts every transaction form, also mixed:
 * - `'sql'` (uses the shared `parameters`)
 * - `['sql', params]`
 * - `{ query: 'sql', parameters | values: params }`
 */
export const parseTransaction = (queries: TransactionQuery, parameters: CFXParameters) => {
  if (!Array.isArray(queries)) throw new Error(`Transaction queries must be array, received '${typeof queries}'.`);
  if (queries.length === 0) throw new Error('Transaction requires at least one query.');

  if (!parameters || typeof parameters === 'function') parameters = [];

  return queries.map((entry) => {
    let query: unknown;
    let params: CFXParameters;

    if (typeof entry === 'string') {
      query = entry;
      params = parameters;
    } else if (Array.isArray(entry)) {
      if (entry[1] !== undefined && typeof entry[1] !== 'object')
        throw new Error(`Transaction parameters must be array or object, received '${typeof entry[1]}'.`);

      query = entry[0];
      params = entry[1] ?? [];
    } else if (entry && typeof entry === 'object') {
      const statement = entry as TransactionStatement;
      query = statement.query;
      params = statement.parameters ?? statement.values ?? parameters;
    } else {
      throw new Error(`Invalid transaction entry of type '${typeof entry}'.`);
    }

    const [parsedQuery, parsedParameters] = parseArguments(query as string, params);

    return { query: parsedQuery, params: parsedParameters };
  });
};
