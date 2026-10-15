import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { resetNatives } from '../../setup';
import { resetDb, setPoolCreationError, getConnectionHandler, createFakeConnection } from '../../helpers/db';

const poolModule = await import('database/pool');
await poolModule.createConnectionPool();

beforeEach(() => {
  resetNatives();
  resetDb();
});

describe('createConnectionPool', () => {
  test('establishes the pool and records the server version banner', () => {
    expect(poolModule.pool).toBeDefined();
    expect(poolModule.dbVersion).toContain('8.0.0-test');
  });

  test('sets the configured transaction isolation level on each new connection', async () => {
    await poolModule.createConnectionPool();
    const handler = getConnectionHandler();
    expect(handler).toBeInstanceOf(Function);

    const conn = createFakeConnection();
    handler!(conn as any);
    expect(conn.calls[0].arg.sql).toBe('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    // errors are reported through a callback instead of becoming unhandled
    expect(typeof conn.calls[0].arg.values).toBe('function');
  });

  test('pins the session time_zone when a timezone is configured', async () => {
    const config = await import('config');

    config.getConnectionOptions('mysql://localhost/db?timezone=Z');
    expect(poolModule.sessionStatements()).toContain("SET time_zone = '+00:00'");

    config.getConnectionOptions('mysql://localhost/db?timezone=-05:00');
    expect(poolModule.sessionStatements()).toContain("SET time_zone = '-05:00'");

    config.getConnectionOptions('mysql://localhost/db');
    expect(poolModule.sessionStatements()).toEqual(['SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED']);
  });

  test('warns when cached prepared statements could exceed max_prepared_stmt_count', async () => {
    const { fakePool } = await import('../../helpers/db');
    const original = fakePool.query;
    fakePool.query = async () => [[{ version: '8.0.0-test', maxStatements: 1000 }]] as any;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    await poolModule.createConnectionPool();

    expect(warn.mock.calls.some((c) => String(c[0]).includes('max_prepared_stmt_count'))).toBe(true);
    warn.mockRestore();
    fakePool.query = original;
  });

  test('logs a diagnostic instead of throwing when the pool cannot be created', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    setPoolCreationError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

    await poolModule.createConnectionPool(); // must not throw

    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Unable to establish a connection'))).toBe(true);
    logSpy.mockRestore();
  });
});
