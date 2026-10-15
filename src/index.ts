import type { CFXCallback, CFXParameters, TransactionQuery } from './types';
import { rawQuery, rawExecute, rawTransaction, startTransaction, pool, poolReady } from './database';
import './update';

type QueryExport = (
  query: any,
  parameters: CFXParameters | CFXCallback | undefined,
  cb: CFXCallback | undefined,
  invokingResource?: string,
  isPromise?: boolean,
) => void;

/**
 * Query exports share one signature: (query, parameters?, callback?, invokingResource?, isPromise?).
 * The Lua (lib/MySQL.lua) and JS (lib/MySQL.ts) wrappers fill in the last two arguments.
 */
const queries: Record<string, QueryExport> = {
  query: (query, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawQuery(null, invokingResource, query, parameters as CFXParameters, cb, isPromise),

  single: (query, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawQuery('single', invokingResource, query, parameters as CFXParameters, cb, isPromise),

  scalar: (query, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawQuery('scalar', invokingResource, query, parameters as CFXParameters, cb, isPromise),

  update: (query, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawQuery('update', invokingResource, query, parameters as CFXParameters, cb, isPromise),

  insert: (query, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawQuery('insert', invokingResource, query, parameters as CFXParameters, cb, isPromise),

  transaction: (queries: TransactionQuery, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawTransaction(invokingResource, queries, parameters as CFXParameters, cb, isPromise),

  prepare: (query, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawExecute(invokingResource, query, parameters as CFXParameters, cb, isPromise, true),

  rawExecute: (query, parameters = [], cb, invokingResource = GetInvokingResource(), isPromise) =>
    rawExecute(invokingResource, query, parameters as CFXParameters, cb, isPromise),
};

const MySQL = {
  ...queries,

  isReady: () => !!pool,

  awaitConnection: async () => {
    await poolReady;
    return true;
  },

  startTransaction: (fn: Parameters<typeof startTransaction>[1], invokingResource = GetInvokingResource()) =>
    startTransaction(invokingResource, fn),
};

const exportFn = global.exports as unknown as (name: string, fn: Function) => void;

for (const [name, fn] of Object.entries(MySQL)) exportFn(name, fn);

// promise-returning variants used by the JS wrapper (lib/MySQL.ts)
for (const [name, fn] of Object.entries(queries)) {
  exportFn(
    `${name}_async`,
    (query: any, parameters: CFXParameters = [], invokingResource = GetInvokingResource()) =>
      new Promise((resolve, reject) => {
        fn(
          query,
          parameters,
          (result: unknown, err?: string) => (err ? reject(new Error(err)) : resolve(result)),
          invokingResource,
          true,
        );
      }),
  );
}

export default MySQL;
