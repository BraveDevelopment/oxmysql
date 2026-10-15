import { describe, test, expect, beforeEach, spyOn, afterEach } from 'bun:test';
import { resetNatives, setConvar, getCommand } from '../setup';
import * as config from 'config';

beforeEach(() => resetNatives());

describe('getIsolationLevelStatement', () => {
  test('maps each level to its SQL statement', () => {
    // SESSION scope: without it the level only applies to the next transaction
    expect(config.getIsolationLevelStatement(1)).toBe('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(config.getIsolationLevelStatement(2)).toBe('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(config.getIsolationLevelStatement(3)).toBe('SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED');
    expect(config.getIsolationLevelStatement(4)).toBe('SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  });

  test('falls back to READ COMMITTED for unknown levels', () => {
    expect(config.getIsolationLevelStatement(99)).toBe('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
  });
});

describe('getConnectionOptions', () => {
  test('parses a full mysql:// URI', () => {
    const opts = config.getConnectionOptions('mysql://user:pass@db.host:3306/mydb?charset=utf8mb4') as any;
    expect(opts).toMatchObject({
      user: 'user',
      password: 'pass',
      host: 'db.host',
      port: 3306,
      database: 'mydb',
      charset: 'utf8mb4',
    });
  });

  test('parses a URI without credentials', () => {
    const opts = config.getConnectionOptions('mysql://localhost/mydb') as any;
    expect(opts.user).toBeUndefined();
    expect(opts.password).toBeUndefined();
    expect(opts.host).toBe('localhost');
    expect(opts.database).toBe('mydb');
  });

  test('normalises key-value aliases (server/uid/pwd/db) to canonical keys', () => {
    const opts = config.getConnectionOptions('server=127.0.0.1;uid=root;pwd=secret;db=app') as any;
    expect(opts).toMatchObject({ host: '127.0.0.1', user: 'root', password: 'secret', database: 'app' });
  });

  test('applies the documented default options', () => {
    const opts = config.getConnectionOptions('mysql://localhost/db') as any;
    expect(opts).toMatchObject({
      connectTimeout: 60000,
      trace: false,
      supportBigNumbers: true,
      jsonStrings: true,
      namedPlaceholders: false,
    });
    expect(typeof opts.typeCast).toBe('function');
  });

  test('adds CONNECT_WITH_DB when a database is set, negated otherwise', () => {
    expect((config.getConnectionOptions('mysql://localhost/db') as any).flags).toContain('CONNECT_WITH_DB');
    expect((config.getConnectionOptions('host=localhost') as any).flags).toContain('-CONNECT_WITH_DB');
  });

  test('JSON-parses ssl/flags string properties', () => {
    const opts = config.getConnectionOptions('host=h;database=db;ssl={"rejectUnauthorized":false}') as any;
    expect(opts.ssl).toEqual({ rejectUnauthorized: false });
  });

  test('warns and drops malformed ssl JSON instead of throwing', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const opts = config.getConnectionOptions('host=h;ssl={bad json') as any;
    expect(opts.ssl).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('disables named placeholders when namedPlaceholders=false', () => {
    config.getConnectionOptions('host=h;database=db;namedPlaceholders=false');
    expect(config.namedPlaceholdersEnabled).toBe(false);

    config.getConnectionOptions('mysql://localhost/db');
    expect(config.namedPlaceholdersEnabled).toBe(true);
  });

  test('coerces "false"/"true" strings into booleans (a non-empty string is truthy)', () => {
    const opts = config.getConnectionOptions(
      'mysql://localhost/db?waitForConnections=false&decimalNumbers=true&supportBigNumbers=false&someFlag=false',
    ) as any;
    expect(opts.waitForConnections).toBe(false);
    expect(opts.decimalNumbers).toBe(true);
    expect(opts.supportBigNumbers).toBe(false);
    expect(opts.someFlag).toBe(false);
  });

  test('coerces numeric options and keeps numeric-looking strings for string options', () => {
    const opts = config.getConnectionOptions('host=h;user=1234;password=0042;connectionLimit=25;queueLimit=0') as any;
    expect(opts.connectionLimit).toBe(25);
    expect(opts.queueLimit).toBe(0);
    expect(opts.user).toBe('1234');
    expect(opts.password).toBe('0042');
  });

  test('decodes URI-encoded credentials, including : @ and / in the password', () => {
    const opts = config.getConnectionOptions('mysql://us%40er:p%40ss%3Aw%2Frd@db.host/my%20db') as any;
    expect(opts.user).toBe('us@er');
    expect(opts.password).toBe('p@ss:w/rd');
    expect(opts.database).toBe('my db');
  });

  test('keeps "=" inside key-value passwords', () => {
    const opts = config.getConnectionOptions('host=h;user=u;password=a=b==;database=d') as any;
    expect(opts.password).toBe('a=b==');
  });

  test('accepts IPv6 hosts and mariadb:// URIs', () => {
    const opts = config.getConnectionOptions('mariadb://root@[::1]:3307/db') as any;
    expect(opts.host).toBe('::1');
    expect(opts.port).toBe(3307);
  });

  test('applies prepared statement and queue defaults, overridable', () => {
    const defaults = config.getConnectionOptions('mysql://localhost/db') as any;
    expect(defaults.maxPreparedStatements).toBe(config.DEFAULT_MAX_PREPARED_STATEMENTS);
    expect(defaults.queueLimit).toBe(config.DEFAULT_QUEUE_LIMIT);

    const custom = config.getConnectionOptions('mysql://localhost/db?maxPreparedStatements=100') as any;
    expect(custom.maxPreparedStatements).toBe(100);
  });

  test('normalises the timezone option ("+" in a URI decodes to a space)', () => {
    expect((config.getConnectionOptions('mysql://localhost/db?timezone=+02:00') as any).timezone).toBe('+02:00');
    expect((config.getConnectionOptions('mysql://localhost/db?timezone=Z') as any).timezone).toBe('Z');
    expect((config.getConnectionOptions('mysql://localhost/db') as any).timezone).toBe('local');
  });
});

describe('setDebug', () => {
  afterEach(() => spyOn(console, 'log').mockRestore());

  test('disables debug and uses the configured log size when mysql_debug=false', () => {
    setConvar('mysql_debug', 'false');
    setConvar('mysql_log_size', '250');
    config.setDebug();
    expect(config.mysql_debug).toBe(false);
    expect(config.mysql_log_size).toBe(250);
  });

  test('parses a JSON array of resources and forces a large log size', () => {
    setConvar('mysql_debug', '["resA","resB"]');
    config.setDebug();
    expect(config.mysql_debug).toEqual(['resA', 'resB']);
    expect(config.mysql_log_size).toBe(10000);
  });

  test('falls back to debug=true on malformed JSON', () => {
    setConvar('mysql_debug', 'not-json');
    config.setDebug();
    expect(config.mysql_debug).toBe(true);
  });

  test('reads ui and slow-query convars', () => {
    setConvar('mysql_ui', 'true');
    setConvar('mysql_slow_query_warning', '500');
    config.setDebug();
    expect(config.mysql_ui).toBe(true);
    expect(config.mysql_slow_query_warning).toBe(500);
  });
});

describe('oxmysql_debug command', () => {
  afterEach(() => spyOn(console, 'log').mockRestore());

  test('add then remove a resource toggles the debug list', () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const handler = getCommand('oxmysql_debug')!;

    handler(0, ['add', 'my-resource']);
    expect(Array.isArray(config.mysql_debug) && config.mysql_debug.includes('my-resource')).toBe(true);

    handler(0, ['remove', 'my-resource']);
    expect(Array.isArray(config.mysql_debug) ? config.mysql_debug.includes('my-resource') : false).toBe(false);
  });

  test('refuses to run client-side (source !== 0)', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    getCommand('oxmysql_debug')!(5, ['add', 'x']);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('can only be run server side'))).toBe(true);
  });
});
