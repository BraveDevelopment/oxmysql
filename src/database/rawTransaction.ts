import { getConnection, type MySql } from './connection';
import { invokeCallback, logError, logger, logQuery } from '../logger';
import type { CFXCallback, CFXParameters, TransactionQuery } from '../types';
import { parseTransaction } from '../utils/parseTransaction';
import { setCallback } from '../utils/setCallback';
import { profileBatchStatements, runProfiler } from 'profiler';
import { withRetry } from './retry';
import { logRetry } from './logRetry';

type ParsedTransaction = ReturnType<typeof parseTransaction>;

const transactionError = (queries: ParsedTransaction, parameters: CFXParameters) =>
  `${queries.map((query) => `${query.query} ${JSON.stringify(query.params || [])}`).join('\n')}\n${JSON.stringify(
    parameters,
  )}`;

async function runTransaction(connection: MySql, invokingResource: string, transactions: ParsedTransaction) {
  const hasProfiler = await runProfiler(connection, invokingResource);

  await connection.beginTransaction();

  try {
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      const startTime = hasProfiler ? 0 : performance.now();

      await connection.query(transaction.query, transaction.params);

      if (hasProfiler && ((i > 0 && i % 100 === 0) || i === transactions.length - 1)) {
        await profileBatchStatements(connection, invokingResource, transactions, null, i < 100 ? 0 : i);
      } else if (!hasProfiler) {
        logQuery(invokingResource, transaction.query, performance.now() - startTime, transaction.params);
      }
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback().catch(() => {});
    throw err;
  }
}

export const rawTransaction = async (
  invokingResource: string,
  queries: TransactionQuery,
  parameters: CFXParameters,
  cb?: CFXCallback,
  isPromise?: boolean,
) => {
  cb = setCallback(parameters, cb);

  let transactions: ParsedTransaction;

  try {
    transactions = parseTransaction(queries, parameters);
  } catch (err: any) {
    return logError(invokingResource, cb, isPromise, err);
  }

  let response = false;

  try {
    await using connection = await getConnection();

    // the statement list is known up front, so the whole transaction can be repeated after a deadlock
    await withRetry(
      () => runTransaction(connection, invokingResource, transactions),
      (err, attempt) => logRetry(invokingResource, transactions.map((t) => t.query).join('\n'), err, attempt),
    );

    response = true;
  } catch (err: any) {
    const transactionErrorMessage = err.sql || transactionError(transactions, parameters);
    const msg = `${invokingResource} was unable to complete a transaction!\n${transactionErrorMessage}\n${err.message}`;

    console.error(msg);

    TriggerEvent('oxmysql:transaction-error', {
      query: transactionErrorMessage,
      parameters: parameters,
      message: err.message,
      err: err,
      resource: invokingResource,
    });

    if (typeof err === 'object' && err.message) delete err.sqlMessage;

    logger({
      level: 'error',
      resource: invokingResource,
      message: msg,
      metadata: err,
    });
  }

  if (!cb) return response;

  invokeCallback(invokingResource, cb, response);
};
