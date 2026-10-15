import { mysql_debug, mysql_log_size, mysql_slow_query_warning, mysql_ui } from '../config';
import type { CFXCallback, CFXParameters } from '../types';
import { dbVersion } from '../database/pool';

let loggerResource = '';
let loggerService = GetConvar('mysql_logger_service', '');

if (loggerService) {
  if (loggerService.startsWith('@')) {
    const [resource, ...path] = loggerService.slice(1).split('/');

    if (resource && path.length) {
      loggerResource = resource;
      loggerService = path.join('/');
    }
  } else loggerService = `logger/${loggerService}`;
}

export const logger: (data: { level: string; resource: string; message: string; metadata?: unknown }) => void =
  (loggerService &&
    new Function(LoadResourceFile(loggerResource || GetCurrentResourceName(), `${loggerService}.js`))()) ||
  (() => {});

/** Invokes a callback from another resource, reporting script errors instead of letting them escape. */
export function invokeCallback(invokingResource: string, cb: CFXCallback, result: unknown, err?: string) {
  try {
    return err === undefined ? cb(result) : cb(result, err);
  } catch (e) {
    const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
    if (message.includes('SCRIPT ERROR:')) return console.log(message);
    console.log(`^1SCRIPT ERROR in invoking resource ${invokingResource}: ${message}^0`);
  }
}

/**
 * Reports a failed query. The callback is always invoked with `(null, message)` so callers never hang:
 * promise/await callers reject, callback-style callers receive the error as their second argument.
 */
export function logError(
  invokingResource: string,
  cb: CFXCallback | undefined,
  isPromise: boolean | undefined,
  err: any = '',
  query?: string,
  parameters?: CFXParameters,
  includeParameters?: boolean,
) {
  const message =
    typeof err === 'object' && err !== null
      ? err.message
      : String(err).replace(/SCRIPT ERROR: citizen:[\w\/\.]+:\d+[:\s]+/, '');

  const output = `${invokingResource} was unable to execute a query!${query ? `\nQuery: ${query}` : ''}${
    includeParameters ? `\n${JSON.stringify(parameters)}` : ''
  }\n${message}`;

  TriggerEvent('oxmysql:error', {
    query: query,
    parameters: parameters,
    message: message,
    err: err,
    resource: invokingResource,
  });

  if (typeof err === 'object' && err?.message) delete err.sqlMessage;

  logger({
    level: 'error',
    resource: invokingResource,
    message: message,
    metadata: err,
  });

  // awaiting callers get the error thrown at the call site, so don't print it twice
  if (!isPromise) console.error(output);

  if (cb) invokeCallback(invokingResource, cb, null, output);
}

const warnedMultiRow = new Set<string>();

/** Warns once per query when single/scalar transferred more rows than it uses. */
export function warnMultiRow(invokingResource: string, type: string, query: string, rows: number) {
  const key = `${invokingResource}\0${query}`;

  if (warnedMultiRow.has(key)) return;
  if (warnedMultiRow.size > 1000) warnedMultiRow.clear();

  warnedMultiRow.add(key);

  console.warn(
    `^3${invokingResource} used ${type}() on a query returning ${rows} rows; only the first is used. ` +
      `Add 'LIMIT 1' so the server stops after one row.\n${query}^0`,
  );
}

export interface QueryData {
  date: number;
  query: string;
  executionTime: number;
  slow?: boolean;
}

/** Fixed-size log per resource; pushing is O(1) instead of shifting the whole array. */
export class QueryRing {
  private items: QueryData[] = [];
  private head = 0;

  constructor(private capacity: number) {}

  push(item: QueryData, capacity: number) {
    if (capacity !== this.capacity) {
      const current = this.toArray().slice(-capacity);
      this.items = current;
      this.head = 0;
      this.capacity = capacity;
    }

    if (this.capacity <= 0) return;

    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }

    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
  }

  get length() {
    return this.items.length;
  }

  /** Oldest first. */
  toArray() {
    return this.head === 0 ? this.items.slice() : this.items.slice(this.head).concat(this.items.slice(0, this.head));
  }
}

const logStorage: Record<string, QueryRing> = {};

export const logQuery = (
  invokingResource: string,
  query: string,
  executionTime: number,
  parameters?: CFXParameters,
) => {
  if (
    executionTime >= mysql_slow_query_warning ||
    (mysql_debug && (!Array.isArray(mysql_debug) || mysql_debug.includes(invokingResource)))
  ) {
    console.log(
      `${dbVersion} ^3${invokingResource} took ${executionTime.toFixed(4)}ms to execute a query!\n${query}${
        parameters ? ` ${JSON.stringify(parameters)}` : ''
      }^0`,
    );
  }

  if (!mysql_ui) return;

  const log = (logStorage[invokingResource] ??= new QueryRing(mysql_log_size));

  log.push(
    {
      query,
      executionTime,
      date: Date.now(),
      slow: executionTime >= mysql_slow_query_warning ? true : undefined,
    },
    mysql_log_size,
  );
};

RegisterCommand(
  'mysql',
  (source: number) => {
    if (!mysql_ui) return;

    if (source < 1) {
      console.log('^3This command cannot run server side^0');
      return;
    }

    let totalQueries = 0;
    let totalTime = 0;
    let slowQueries = 0;
    const chartData: { labels: string[]; data: { queries: number; time: number }[] } = {
      labels: [],
      data: [],
    };

    for (const resource in logStorage) {
      const queries = logStorage[resource].toArray();
      let resourceTime = 0;

      for (const query of queries) {
        resourceTime += query.executionTime;
        if (query.slow) slowQueries++;
      }

      totalQueries += queries.length;
      totalTime += resourceTime;
      chartData.labels.push(resource);
      chartData.data.push({ queries: queries.length, time: resourceTime });
    }

    emitNet(`oxmysql:openUi`, source, {
      resources: Object.keys(logStorage),
      totalQueries,
      slowQueries,
      totalTime,
      chartData,
    });
  },
  true,
);

const sortQueries = (queries: QueryData[], sort: { id: 'query' | 'executionTime'; desc: boolean }) => {
  const sortedQueries = [...queries].sort((a, b) => {
    switch (sort.id) {
      case 'query':
        return a.query > b.query ? 1 : -1;
      case 'executionTime':
        return a.executionTime - b.executionTime;
      default:
        return 0;
    }
  });

  return sort.desc ? sortedQueries.reverse() : sortedQueries;
};

onNet(
  `oxmysql:fetchResource`,
  (data: {
    resource: string;
    pageIndex: number;
    search: string;
    sortBy?: { id: 'query' | 'executionTime'; desc: boolean }[];
  }) => {
    if (typeof data.resource !== 'string' || !IsPlayerAceAllowed(source as unknown as string, 'command.mysql')) return;

    const storedQueries = logStorage[data.resource]?.toArray();

    if (!storedQueries) return;

    if (data.search) data.search = data.search.toLowerCase();

    const resourceLog = data.search
      ? storedQueries.filter((q) => q.query.toLowerCase().includes(data.search))
      : storedQueries;

    const sort = data.sortBy && data.sortBy.length > 0 ? data.sortBy[0] : false;
    const startRow = data.pageIndex * 10;
    const endRow = startRow + 10;
    const queries = sort ? sortQueries(resourceLog, sort).slice(startRow, endRow) : resourceLog.slice(startRow, endRow);
    const pageCount = Math.ceil(resourceLog.length / 10);

    let resourceTime = 0;
    let resourceSlowQueries = 0;

    for (const query of resourceLog) {
      resourceTime += query.executionTime;
      if (query.slow) resourceSlowQueries += 1;
    }

    emitNet(`oxmysql:loadResource`, source, {
      queries,
      pageCount,
      resourceQueriesCount: resourceLog.length,
      resourceSlowQueries,
      resourceTime,
    });
  },
);
