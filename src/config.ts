import type { PoolOptions } from 'mysql2';
import { createTypeCast, normaliseTimezone } from './utils/typeCast';

export const mysql_connection_string =
  GetConvar('mysql_connection_string', '') || process.env.DB_CONNECTION || 'mysql://root@localhost';

export let mysql_ui = GetConvar('mysql_ui', 'false') === 'true';
export let mysql_slow_query_warning = GetConvarInt('mysql_slow_query_warning', 200);
export let mysql_debug: boolean | string[] = false;

/** Max entries kept per resource for the query log UI. */
export let mysql_log_size = 0;

/** Hard limit for `startTransaction` callbacks; the connection is destroyed (and rolled back by the server) afterwards. */
export const mysql_transaction_timeout = Math.max(0, GetConvarInt('mysql_transaction_timeout', 30000));

/** How long a query may wait for a free pool connection before failing. 0 disables the timeout. */
export const mysql_acquire_timeout = Math.max(0, GetConvarInt('mysql_acquire_timeout', 10000));

/** Automatic retries on InnoDB deadlocks (1213). Lock wait timeouts (1205) are retried at most once. */
export const mysql_deadlock_retries = Math.max(0, GetConvarInt('mysql_deadlock_retries', 3));

/** Throw on missing parameters instead of binding NULL. Off by default because Lua tables cannot hold nil. */
export const mysql_strict_params = GetConvar('mysql_strict_params', 'false') === 'true';

export function setDebug() {
  mysql_ui = GetConvar('mysql_ui', 'false') === 'true';
  mysql_slow_query_warning = GetConvarInt('mysql_slow_query_warning', 200);

  try {
    const debug = GetConvar('mysql_debug', 'false');
    mysql_debug = debug === 'false' ? false : JSON.parse(debug);
  } catch (e) {
    mysql_debug = true;
  }

  mysql_log_size = mysql_debug ? 10000 : GetConvarInt('mysql_log_size', 100);
}

const isolationLevels: Record<number, string> = {
  1: 'REPEATABLE READ',
  2: 'READ COMMITTED',
  3: 'READ UNCOMMITTED',
  4: 'SERIALIZABLE',
};

/**
 * Without SESSION, `SET TRANSACTION ISOLATION LEVEL` only applies to the next transaction on the connection;
 * every later transaction silently falls back to the server default.
 */
export function getIsolationLevelStatement(level: number) {
  return `SET SESSION TRANSACTION ISOLATION LEVEL ${isolationLevels[level] ?? isolationLevels[2]}`;
}

export const mysql_transaction_isolation_level = getIsolationLevelStatement(
  GetConvarInt('mysql_transaction_isolation_level', 2),
);

/** Whether `:name` / `@name` placeholders are converted (disable with `namedPlaceholders=false`). */
export let namedPlaceholdersEnabled = true;

/** Timezone used to convert DATE/DATETIME/TIMESTAMP values ('local', 'Z' or '+HH:MM'). */
export let connectionTimezone = 'local';

const BOOLEAN_OPTIONS = new Set([
  'bigNumberStrings',
  'compress',
  'debug',
  'decimalNumbers',
  'enableKeepAlive',
  'insecureAuth',
  'jsonStrings',
  'multipleStatements',
  'namedPlaceholders',
  'rowsAsArray',
  'supportBigNumbers',
  'trace',
  'waitForConnections',
]);

const NUMBER_OPTIONS = new Set([
  'connectionLimit',
  'connectTimeout',
  'idleTimeout',
  'keepAliveInitialDelay',
  'maxIdle',
  'maxPreparedStatements',
  'port',
  'queueLimit',
]);

const JSON_OPTIONS = new Set(['dateStrings', 'flags', 'ssl']);

const STRING_OPTIONS = new Set(['user', 'password', 'host', 'database', 'socketPath', 'charset', 'timezone']);

const KEY_ALIASES: Record<string, string> = {
  hostname: 'host',
  ip: 'host',
  server: 'host',
  datasource: 'host',
  addr: 'host',
  address: 'host',
  userid: 'user',
  username: 'user',
  uid: 'user',
  pwd: 'password',
  pass: 'password',
  db: 'database',
};

function normaliseKey(key: string) {
  const compact = key.trim().replace(/\s+/g, '');
  return KEY_ALIASES[compact.toLowerCase()] ?? compact;
}

/** Converts string values from the connection string into the types mysql2 expects. */
export function coerceOption(key: string, value: string): unknown {
  if (STRING_OPTIONS.has(key)) return value;

  if (BOOLEAN_OPTIONS.has(key) || value === 'true' || value === 'false') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    console.warn(`^3Ignoring invalid boolean '${value}' for connection option '${key}'.^0`);
    return undefined;
  }

  if (NUMBER_OPTIONS.has(key)) {
    const number = Number(value);
    if (value.trim() !== '' && Number.isFinite(number)) return number;
    console.warn(`^3Ignoring invalid number '${value}' for connection option '${key}'.^0`);
    return undefined;
  }

  if (JSON_OPTIONS.has(key)) {
    try {
      return JSON.parse(value);
    } catch (err) {
      console.warn(`^3Failed to parse connection option '${key}' (${err}).^0`);
      return undefined;
    }
  }

  return value;
}

function parseUri(connectionString: string) {
  let url: URL;

  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`mysql_connection_string structure was invalid (${connectionString.replace(/:[^:@/]*@/, ':******@')})`);
  }

  const options: Record<string, string> = {};

  if (url.username) options.user = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.hostname) options.host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (url.port) options.port = url.port;

  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (database) options.database = database;

  for (const [key, value] of url.searchParams) options[normaliseKey(key)] = value;

  return options;
}

function parseKeyValue(connectionString: string) {
  const options: Record<string, string> = {};

  for (const parameter of connectionString.split(';')) {
    const index = parameter.indexOf('=');
    if (index === -1) continue;

    const key = normaliseKey(parameter.slice(0, index));
    if (key) options[key] = parameter.slice(index + 1).trim();
  }

  return options;
}

export const DEFAULT_MAX_PREPARED_STATEMENTS = 250;
export const DEFAULT_QUEUE_LIMIT = 2000;

export function getConnectionOptions(connectionString: string = mysql_connection_string): PoolOptions {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(connectionString)
    ? parseUri(connectionString)
    : parseKeyValue(connectionString);

  const options: Record<string, any> = {};

  for (const key in raw) {
    const value = coerceOption(key, raw[key]);
    if (value !== undefined) options[key] = value;
  }

  namedPlaceholdersEnabled = options.namedPlaceholders !== false;
  connectionTimezone = normaliseTimezone(options.timezone);

  const flags: string[] = Array.isArray(options.flags) ? options.flags : [];
  flags.push(options.database ? 'CONNECT_WITH_DB' : '-CONNECT_WITH_DB');

  return {
    connectTimeout: 60000,
    trace: false,
    supportBigNumbers: true,
    jsonStrings: true,
    maxPreparedStatements: DEFAULT_MAX_PREPARED_STATEMENTS,
    queueLimit: DEFAULT_QUEUE_LIMIT,
    ...options,
    timezone: connectionTimezone,
    typeCast: createTypeCast(connectionTimezone),
    namedPlaceholders: false, // handled by utils/sql
    flags,
  };
}

RegisterCommand(
  'oxmysql_debug',
  (source: number, args: string[]) => {
    if (source !== 0) return console.log('^3This command can only be run server side^0');

    switch (args[0]) {
      case 'add':
        if (!args[1]) break;
        if (!Array.isArray(mysql_debug)) mysql_debug = [];
        if (!mysql_debug.includes(args[1])) mysql_debug.push(args[1]);
        SetConvar('mysql_debug', JSON.stringify(mysql_debug));
        return console.log(`^3Added ${args[1]} to mysql_debug^0`);

      case 'remove': {
        if (!Array.isArray(mysql_debug)) break;
        const index = mysql_debug.indexOf(args[1]);
        if (index === -1) return;
        mysql_debug.splice(index, 1);
        if (mysql_debug.length === 0) mysql_debug = false;
        SetConvar('mysql_debug', mysql_debug ? JSON.stringify(mysql_debug) : 'false');
        return console.log(`^3Removed ${args[1]} from mysql_debug^0`);
      }
    }

    console.log(`^3Usage: oxmysql_debug add|remove <resource>^0`);
  },
  true,
);
