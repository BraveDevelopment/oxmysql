import { logError, logQuery, invokeCallback } from '../logger';
import type { CFXCallback, CFXParameters, QueryResponse } from '../types';
import { parseResponse } from '../utils/parseResponse';
import { executeType, parseExecute } from '../utils/parseExecute';
import { countPlaceholders } from '../utils/sql';
import { getConnection, type MySql } from './connection';
import { setCallback } from '../utils/setCallback';
import validateResultSet from 'utils/validateResultSet';
import { profileBatchStatements, runProfiler } from 'profiler';
import { withRetry } from './retry';
import { logRetry } from './logRetry';

async function executeSets(connection: MySql, invokingResource: string, query: string, sets: unknown[][]) {
  const hasProfiler = await runProfiler(connection, invokingResource);
  const results: QueryResponse[] = [];

  for (let index = 0; index < sets.length; index++) {
    const values = sets[index];
    const startTime = hasProfiler ? 0 : performance.now();
    const result = (await connection.execute(query, values)) as QueryResponse;

    if (hasProfiler && ((index > 0 && index % 100 === 0) || index === sets.length - 1)) {
      await profileBatchStatements(connection, invokingResource, query, sets, index < 100 ? 0 : index);
    } else if (!hasProfiler) {
      logQuery(invokingResource, query, performance.now() - startTime, values);
    }

    validateResultSet(invokingResource, query, result);
    results.push(result);
  }

  return results;
}

/**
 * Runs a statement through the binary protocol (server-side prepared statement).
 *
 * Batches (several parameter sets) run inside one transaction: they are atomic and InnoDB only flushes
 * the redo log once instead of once per row.
 *
 * Return values are stable:
 * - `prepare`: rows for SELECT, insertId for INSERT/REPLACE, affectedRows for UPDATE/DELETE
 * - `rawExecute`: the unprocessed mysql2 result
 * - batches return one entry per parameter set, in order
 */
export const rawExecute = async (
  invokingResource: string,
  query: string,
  parameters: CFXParameters,
  cb?: CFXCallback,
  isPromise?: boolean,
  unpack?: boolean,
) => {
  cb = setCallback(parameters, cb);

  let type: ReturnType<typeof executeType>;
  let sets: unknown[][];

  try {
    if (typeof query !== 'string')
      throw new Error(`Expected query to be a string but received ${typeof query} instead.`);

    type = executeType(query);
    sets = parseExecute(countPlaceholders(query), parameters);
  } catch (err: any) {
    return logError(invokingResource, cb, isPromise, err, query, parameters);
  }

  const isBatch = sets.length > 1;
  let results: QueryResponse[];

  try {
    await using connection = await getConnection();

    results = await withRetry(
      async () => {
        if (!isBatch) return executeSets(connection, invokingResource, query, sets);

        await connection.beginTransaction();

        try {
          const batchResults = await executeSets(connection, invokingResource, query, sets);
          await connection.commit();
          return batchResults;
        } catch (err) {
          await connection.rollback().catch(() => {});
          throw err;
        }
      },
      (err, attempt) => logRetry(invokingResource, query, err, attempt),
    );
  } catch (err: any) {
    return logError(invokingResource, cb, isPromise, err, query, parameters);
  }

  const formatted = unpack ? results.map((result) => parseResponse(type, result)) : results;
  const response = isBatch ? formatted : formatted[0];

  if (!cb) return response;

  invokeCallback(invokingResource, cb, response);
};
