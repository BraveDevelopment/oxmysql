import { parseArguments } from '../utils/parseArguments';
import { setCallback } from '../utils/setCallback';
import { parseResponse } from '../utils/parseResponse';
import { logQuery, logError, invokeCallback, warnMultiRow } from '../logger';
import type { CFXCallback, CFXParameters, QueryType } from '../types';
import { getConnection, type MySql } from './connection';
import type { RowDataPacket } from 'mysql2';
import validateResultSet from 'utils/validateResultSet';
import { markProfilerUnsupported, runProfiler } from 'profiler';
import { withRetry } from './retry';
import { logRetry } from './logRetry';

async function timedQuery(connection: MySql, invokingResource: string, query: string, parameters: CFXParameters) {
  const hasProfiler = await runProfiler(connection, invokingResource);
  const startTime = hasProfiler ? 0 : performance.now();
  const result = await connection.query(query, parameters);

  if (hasProfiler) {
    try {
      const profiler = <RowDataPacket[]>(
        await connection.query('SELECT FORMAT(SUM(DURATION) * 1000, 4) AS `duration` FROM INFORMATION_SCHEMA.PROFILING')
      );

      if (profiler[0]) logQuery(invokingResource, query, parseFloat(profiler[0].duration), parameters);
    } catch {
      // e.g. TiDB accepts the SET profiling statements but has no INFORMATION_SCHEMA.PROFILING
      markProfilerUnsupported();
    }
  } else {
    logQuery(invokingResource, query, performance.now() - startTime, parameters);
  }

  return result;
}

export const rawQuery = async (
  type: QueryType,
  invokingResource: string,
  query: string,
  parameters: CFXParameters,
  cb?: CFXCallback,
  isPromise?: boolean,
) => {
  cb = setCallback(parameters, cb);

  try {
    [query, parameters] = parseArguments(query, parameters);
  } catch (err: any) {
    return logError(invokingResource, cb, isPromise, err, query, parameters);
  }

  let result: Awaited<ReturnType<MySql['query']>>;

  try {
    await using connection = await getConnection();

    // a single autocommit statement is its own transaction; InnoDB rolls it back fully on deadlock
    result = await withRetry(
      () => timedQuery(connection, invokingResource, query, parameters),
      (err, attempt) => logRetry(invokingResource, query, err, attempt),
    );
  } catch (err: any) {
    return logError(invokingResource, cb, isPromise, err, query, parameters, true);
  }

  validateResultSet(invokingResource, query, result);

  if ((type === 'single' || type === 'scalar') && Array.isArray(result) && result.length > 1)
    warnMultiRow(invokingResource, type, query, result.length);

  const response = parseResponse(type, result);

  if (!cb) return response;

  invokeCallback(invokingResource, cb, response);
};
