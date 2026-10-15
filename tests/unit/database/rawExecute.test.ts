import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { resetNatives, setConvar } from '../../setup';
import { resetDb, setConnectionFactory, createFakeConnection, type FakeConnection } from '../../helpers/db';
import * as config from 'config';

const { createConnectionPool } = await import('database/pool');
await createConnectionPool();
const { rawExecute } = await import('database/rawExecute');

let conn: FakeConnection;

const deadlock = () => Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });

beforeEach(() => {
  resetNatives();
  setConvar('mysql_debug', 'false');
  config.setDebug();
  resetDb();
  conn = createFakeConnection();
  setConnectionFactory(() => conn);
});

describe('rawExecute', () => {
  test('runs a batch atomically inside one transaction', async () => {
    conn.queue.push({ affectedRows: 1, insertId: 1 }, { affectedRows: 1, insertId: 2 });
    await rawExecute('res', 'INSERT INTO t (a) VALUES (?)', [[1], [2]]);

    expect(conn.ops()).toEqual(['begin', 'execute', 'execute', 'commit', 'release']);
    expect(conn.calls[1].arg.sql).toBe('INSERT INTO t (a) VALUES (?)');
  });

  test('a single parameter set runs without a transaction', async () => {
    await rawExecute('res', 'INSERT INTO t (a) VALUES (?)', [1]);
    expect(conn.ops()).toEqual(['execute', 'release']);
  });

  test('rolls back the whole batch when one row fails', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    conn.failOn.execute = () => (++calls === 2 ? new Error('duplicate') : undefined);

    const args: any[] = [];
    await rawExecute('res', 'INSERT INTO t (a) VALUES (?)', [[1], [2], [3]], (...a) => args.push(a), true);

    expect(conn.ops()).toEqual(['begin', 'execute', 'execute', 'rollback', 'release']);
    expect(args[0][0]).toBeNull();
    expect(String(args[0][1])).toContain('duplicate');
  });

  test('retries a batch after a deadlock', async () => {
    spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    conn.failOn.execute = () => (++calls === 1 ? deadlock() : undefined);

    const result = await rawExecute('res', 'UPDATE t SET a = ? WHERE id = ?', [[1, 1], [2, 2]], undefined, true, true);

    expect(conn.ops()).toEqual(['begin', 'execute', 'rollback', 'begin', 'execute', 'execute', 'commit', 'release']);
    expect(result).toEqual([1, 1]);
  });

  test('pads a short value row with null up to the placeholder count', async () => {
    await rawExecute('res', 'INSERT INTO t (a, b) VALUES (?, ?)', [[1]]);
    const exec = conn.calls.find((c) => c.op === 'execute');
    expect(exec!.arg.values).toEqual([1, null]);
  });

  test('prepare returns rows for SELECT regardless of the row count', async () => {
    conn.queue.push([{ id: 7 }]);
    expect(await rawExecute('res', 'SELECT id FROM t WHERE a = ?', [1], undefined, true, true)).toEqual([{ id: 7 }]);

    conn.queue.push([]);
    expect(await rawExecute('res', 'SELECT id FROM t WHERE a = ?', [1], undefined, true, true)).toEqual([]);

    conn.queue.push([{ id: 1 }, { id: 2 }]);
    expect(await rawExecute('res', 'SELECT id FROM t WHERE a = ?', [1], undefined, true, true)).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  test('prepare returns insertId / affectedRows, case-insensitive and after comments', async () => {
    conn.queue.push({ insertId: 42, affectedRows: 1 });
    expect(await rawExecute('res', '\n  insert into t (a) values (?)', [1], undefined, true, true)).toBe(42);

    conn.queue.push({ insertId: 0, affectedRows: 3 });
    expect(await rawExecute('res', '/* cleanup */ delete from t where a = ?', [1], undefined, true, true)).toBe(3);
  });

  test('batch SELECT keeps one result per parameter set', async () => {
    conn.queue.push([{ id: 1 }, { id: 2 }], [{ id: 3 }]);
    const result = await rawExecute('res', 'SELECT id FROM t WHERE a = ?', [[1], [2]], undefined, true, true);
    expect(result).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });

  test('surfaces an execute error through the callback', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    conn.failOn.execute = new Error('exec failed');
    const args: any[] = [];
    await rawExecute('res', 'INSERT INTO t VALUES (?)', [[1]], (...a) => args.push(a), true);
    expect(String(args[0][1])).toContain('exec failed');
  });

  test('callback-style callers also receive the error (they no longer hang)', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    conn.failOn.execute = new Error('exec failed');
    const args: any[] = [];
    await rawExecute('res', 'INSERT INTO t VALUES (?)', [1], (...a) => args.push(a), false);
    expect(args).toHaveLength(1);
    expect(args[0][0]).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  test('reports a parse error before reaching the connection', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const args: any[] = [];
    await rawExecute('res', 123 as any, [[1]], (...a) => args.push(a), true);
    expect(String(args[0][1])).toContain('Expected query to be a string');
    expect(conn.calls).toHaveLength(0);
  });

  test('returns a multi-result-set response unchanged', async () => {
    conn.queue.push([{ a: 1 }, { b: 2 }]);
    const result = await rawExecute('res', 'CALL proc(?)', [[1]]);
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('a callback that throws a SCRIPT ERROR string is swallowed', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    await rawExecute(
      'res',
      'INSERT INTO t VALUES (?)',
      [[1]],
      () => {
        throw 'SCRIPT ERROR: boom';
      },
      true,
    );
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
