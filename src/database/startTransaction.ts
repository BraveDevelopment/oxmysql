import { getConnection } from './connection';
import { invokeCallback, logError } from '../logger';
import type { CFXCallback, CFXParameters } from '../types';
import { parseArguments } from 'utils/parseArguments';
import { mysql_transaction_timeout } from 'config';

class TransactionTimeoutError extends Error {
  constructor(ms: number) {
    super(`Transaction timed out after ${ms}ms; the connection was closed and the transaction rolled back.`);
  }
}

/**
 * Runs `queries` inside a transaction on a dedicated connection.
 * Commits unless the callback returns false or throws.
 *
 * When the callback exceeds `mysql_transaction_timeout`, the connection is destroyed instead of waiting for the
 * callback: the server rolls the transaction back, releases its row locks, and the pool gets a fresh connection.
 * Further queries from the abandoned callback fail.
 *
 * Not retried on deadlock: the callback may have side effects outside the database.
 */
export const startTransaction = async (
  invokingResource: string,
  queries: (query: (sql: string, values?: CFXParameters) => Promise<unknown>) => Promise<boolean | void>,
  cb?: CFXCallback,
  _isPromise?: boolean,
) => {
  let response = false;

  try {
    await using conn = await getConnection();
    let closed = false;
    let timer: NodeJS.Timeout | undefined;

    const query = async (sql: string, values?: CFXParameters) => {
      if (closed) throw new Error(`Transaction is no longer active.\nQuery: ${sql}`);

      [sql, values] = parseArguments(sql, values);

      try {
        return await conn.query(sql, values);
      } catch (err: any) {
        throw new Error(`Query: ${sql}\n${JSON.stringify(values)}\n${err.message}`);
      }
    };

    try {
      await conn.beginTransaction();

      const work = Promise.resolve(queries(query));

      // an abandoned callback may reject later; don't surface that as an unhandled rejection
      work.catch(() => {});

      const result = mysql_transaction_timeout
        ? await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new TransactionTimeoutError(mysql_transaction_timeout)), mysql_transaction_timeout);
            }),
          ])
        : await work;

      closed = true;

      if (result === false) await conn.rollback();
      else {
        await conn.commit();
        response = true;
      }
    } catch (err) {
      closed = true;

      if (err instanceof TransactionTimeoutError) conn.destroy();
      else await conn.rollback().catch(() => {});

      throw err;
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    response = false;
    // the result is `false`, not an exception, so always print the reason
    logError(invokingResource, undefined, false, err);
  }

  return cb ? invokeCallback(invokingResource, cb, response) : response;
};
