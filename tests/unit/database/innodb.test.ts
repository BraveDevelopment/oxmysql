import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { resetNatives, setConvar } from '../../setup';
import { resetDb, setConnectionFactory, createFakeConnection, type FakeConnection } from '../../helpers/db';
import * as config from 'config';

const { createConnectionPool } = await import('database/pool');
await createConnectionPool();
const { rawQuery } = await import('database/rawQuery');
const { rawTransaction } = await import('database/rawTransaction');
const { startTransaction } = await import('database/startTransaction');
const { isRetryable, ER_LOCK_DEADLOCK, ER_LOCK_WAIT_TIMEOUT } = await import('database/retry');

let conn: FakeConnection;

const lockError = (errno: number) => Object.assign(new Error(`lock error ${errno}`), { errno });

beforeEach(() => {
  resetNatives();
  setConvar('mysql_debug', 'false');
  config.setDebug();
  resetDb();
  conn = createFakeConnection();
  setConnectionFactory(() => conn);
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => mock.restore());

describe('isRetryable', () => {
  test('retries deadlocks up to mysql_deadlock_retries, lock wait timeouts once', () => {
    const deadlock = lockError(ER_LOCK_DEADLOCK);
    const timeout = lockError(ER_LOCK_WAIT_TIMEOUT);

    expect(isRetryable(deadlock, 0)).toBe(true);
    expect(isRetryable(deadlock, config.mysql_deadlock_retries - 1)).toBe(true);
    expect(isRetryable(deadlock, config.mysql_deadlock_retries)).toBe(false);

    expect(isRetryable(timeout, 0)).toBe(true);
    expect(isRetryable(timeout, 1)).toBe(false);

    expect(isRetryable(lockError(1062), 0)).toBe(false);
    expect(isRetryable(new Error('no errno'), 0)).toBe(false);
  });
});

describe('deadlock retry', () => {
  test('a single statement is repeated after a deadlock', async () => {
    let calls = 0;
    conn.failOn.query = () => (++calls === 1 ? lockError(ER_LOCK_DEADLOCK) : undefined);
    conn.queue.push({ affectedRows: 2 });

    expect(await rawQuery('update', 'res', 'UPDATE t SET a = 1', [])).toBe(2);
    expect(conn.ops()).toEqual(['query', 'query', 'release']);
  });

  test('gives up after the configured number of retries', async () => {
    conn.failOn.query = () => lockError(ER_LOCK_DEADLOCK);
    const args: any[] = [];

    await rawQuery('update', 'res', 'UPDATE t SET a = 1', [], (...a) => args.push(a), true);

    expect(conn.ops().filter((op) => op === 'query')).toHaveLength(config.mysql_deadlock_retries + 1);
    expect(args[0][0]).toBeNull();
  });

  test('transaction() repeats the whole transaction', async () => {
    let calls = 0;
    conn.failOn.query = () => (++calls === 2 ? lockError(ER_LOCK_DEADLOCK) : undefined);

    const result = await rawTransaction('res', ['UPDATE a SET x = 1', 'UPDATE b SET y = 2'], []);

    expect(result).toBe(true);
    expect(conn.ops()).toEqual(['begin', 'query', 'query', 'rollback', 'begin', 'query', 'query', 'commit', 'release']);
  });

  test('non-lock errors are not retried', async () => {
    conn.failOn.query = lockError(1062);
    expect(await rawTransaction('res', ['INSERT INTO a VALUES (1)'], [])).toBe(false);
    expect(conn.ops()).toEqual(['begin', 'query', 'rollback', 'release']);
  });
});

describe('single/scalar warnings', () => {
  test('warns once when single() transfers more than one row', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    conn.queue.push([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 2 }]);
    expect(await rawQuery('single', 'res', 'SELECT a FROM multi', [])).toEqual({ a: 1 });
    await rawQuery('single', 'res', 'SELECT a FROM multi', []);

    const warnings = warn.mock.calls.filter((c) => String(c[0]).includes('only the first is used'));
    expect(warnings).toHaveLength(1);
  });

  test('stays quiet for a single row', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    conn.queue.push([{ a: 1 }]);
    await rawQuery('scalar', 'res', 'SELECT a FROM t LIMIT 1', []);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('only the first is used'))).toBe(false);
  });
});

describe('startTransaction timeout', () => {
  test('destroys the connection instead of waiting for a stuck callback', async () => {
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: Function) => {
      queueMicrotask(() => fn());
      return 0 as any;
    }) as any);

    let lateQuery: Promise<unknown> | undefined;
    let release: () => void = () => {};

    const result = await startTransaction('res', async (query) => {
      await query('UPDATE t SET a = 1');
      await new Promise<void>((resolve) => (release = resolve)); // never finishes on its own
      lateQuery = query('UPDATE t SET a = 2');
      lateQuery.catch(() => {});
      return true;
    });

    timers.mockRestore();

    expect(result).toBe(false);
    expect(conn.ops()).toEqual(['begin', 'query', 'destroy']);

    // the abandoned callback can no longer use the connection
    release();
    await new Promise((r) => setImmediate(r));
    await expect(lateQuery!).rejects.toThrow('no longer active');
    expect(conn.ops()).not.toContain('commit');
  });

  test('a callback that throws rolls back and returns false', async () => {
    const result = await startTransaction('res', async () => {
      throw new Error('nope');
    });

    expect(result).toBe(false);
    expect(conn.ops()).toEqual(['begin', 'rollback', 'release']);
  });
});
