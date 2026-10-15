type Params = Record<string, unknown> | unknown[];
type Callback<T> = (result: T | null, error?: string) => void;

type Transaction =
  | string[]
  | [string, Params][]
  | { query: string; values: Params }[]
  | { query: string; parameters: Params }[];

interface Result {
  [column: string | number]: any;
  affectedRows?: number;
  fieldCount?: number;
  info?: string;
  insertId?: number;
  serverStatus?: number;
  warningStatus?: number;
  changedRows?: number;
}

interface Row {
  [column: string | number]: unknown;
}

type QueryFn<T> = (query: string, params?: Params | Callback<T>, cb?: Callback<T>) => Promise<T>;

interface OxMySQL {
  ready: (callback: () => void) => void;
  /** Rows for SELECT, otherwise the result header. */
  query: <T = Row[] | Result>(...args: Parameters<QueryFn<T>>) => Promise<T>;
  /** First row or null. Add `LIMIT 1` to the query. */
  single: <T = Row | null>(...args: Parameters<QueryFn<T>>) => Promise<T>;
  /** First column of the first row or null. */
  scalar: <T = unknown>(...args: Parameters<QueryFn<T>>) => Promise<T>;
  /** affectedRows */
  update: (...args: Parameters<QueryFn<number | null>>) => Promise<number | null>;
  /** insertId */
  insert: (...args: Parameters<QueryFn<number | null>>) => Promise<number | null>;
  /**
   * Prepared statement. Rows for SELECT, insertId for INSERT/REPLACE, affectedRows for UPDATE/DELETE.
   * An array of parameter sets runs as one atomic batch and returns one entry per set.
   */
  prepare: <T = any>(...args: Parameters<QueryFn<T>>) => Promise<T>;
  /** Prepared statement returning the unprocessed result (one entry per set for batches). */
  rawExecute: <T = Result | Row[]>(...args: Parameters<QueryFn<T>>) => Promise<T>;
  transaction: (
    queries: Transaction,
    params?: Params | Callback<boolean>,
    cb?: Callback<boolean>,
  ) => Promise<boolean>;
  isReady: () => boolean;
  awaitConnection: () => Promise<true>;
  /** Return false or throw to roll back. */
  startTransaction: (
    cb: (query: <T = Row[] | Result>(statement: string, params?: Params) => Promise<T>) => Promise<boolean | void>,
  ) => Promise<boolean>;
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new TypeError(message);
}

const safeArgs = (query: string | Transaction, params?: any, cb?: Function, transaction?: true) => {
  if (transaction) {
    assert(typeof query === 'object', `First argument expected object, received ${typeof query}`);
  } else {
    assert(typeof query === 'string', `First argument expected string, received ${typeof query}`);
  }

  if (params !== undefined) {
    const paramType = typeof params;

    assert(
      paramType === 'object' || paramType === 'function',
      `Second argument expected object or function, received ${paramType}`,
    );

    if (paramType === 'function') {
      assert(cb === undefined, 'Received a callback as both the second and third argument');
      cb = params;
      params = undefined;
    }
  }

  if (cb !== undefined) assert(typeof cb === 'function', `Third argument expected function, received ${typeof cb}`);

  return [query, params, cb] as const;
};

declare var global: any;
const exp = global.exports.oxmysql;
const currentResourceName = GetCurrentResourceName();

function execute(method: string, query: string | Transaction, params?: Params) {
  return new Promise((resolve, reject) => {
    exp[method](
      query,
      params,
      (result: unknown, error?: string) => {
        if (error) return reject(new Error(error));
        resolve(result);
      },
      currentResourceName,
      true,
    );
  }) as any;
}

function method(name: string, transaction?: true) {
  return async (query: any, params?: any, cb?: Function) => {
    [query, params, cb] = safeArgs(query, params, cb, transaction);

    let result: unknown;

    try {
      result = await execute(name, query, params);
    } catch (err) {
      // callback style receives errors as the second argument instead of an unhandled rejection
      if (cb) return cb(null, (err as Error).message);
      throw err;
    }

    return cb ? cb(result) : result;
  };
}

export const oxmysql: OxMySQL = {
  ready(callback) {
    setImmediate(async () => {
      while (GetResourceState('oxmysql') !== 'started') await new Promise((resolve) => setTimeout(resolve, 50, null));
      await exp.awaitConnection();
      callback();
    });
  },
  query: method('query'),
  single: method('single'),
  scalar: method('scalar'),
  update: method('update'),
  insert: method('insert'),
  prepare: method('prepare'),
  rawExecute: method('rawExecute'),
  transaction: method('transaction', true),
  isReady() {
    return exp.isReady();
  },
  async awaitConnection() {
    return await exp.awaitConnection();
  },
  async startTransaction(cb) {
    return exp.startTransaction(cb, currentResourceName);
  },
};

export default oxmysql;
