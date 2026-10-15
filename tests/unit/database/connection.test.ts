import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import '../../setup';
import { resetDb, setConnectionFactory, createFakeConnection } from '../../helpers/db';

const { createConnectionPool } = await import('database/pool');
await createConnectionPool();
const { MySql, getConnection } = await import('database/connection');

const asyncDispose = (c: any) => c[Symbol.asyncDispose]();

beforeEach(() => resetDb());

describe('MySql wrapper', () => {
  test('adopts the underlying connection threadId as its id', () => {
    const c = new MySql(createFakeConnection(99) as any);
    expect(c.id).toBe(99);
  });

  test('query() unwraps the [result] tuple and forwards args', async () => {
    const fake = createFakeConnection();
    fake.queue.push([{ id: 1 }]);
    const c = new MySql(fake as any);

    const result = await c.query('SELECT ?', [1]);
    expect(result).toEqual([{ id: 1 }]);
    expect(fake.calls[0]).toEqual({ op: 'query', arg: { sql: 'SELECT ?', values: [1] } });
  });

  test('execute() unwraps the result (typecasting comes from the pool config)', async () => {
    const fake = createFakeConnection();
    fake.queue.push({ affectedRows: 2 });
    const c = new MySql(fake as any);

    const result = await c.execute('UPDATE t SET a = ?', [1]);
    expect(result).toEqual({ affectedRows: 2 });
    expect(fake.calls[0].arg).toEqual({ sql: 'UPDATE t SET a = ?', values: [1] });
  });

  test('beginTransaction sets the flag; commit/rollback clear it', async () => {
    const c = new MySql(createFakeConnection() as any);
    await c.beginTransaction();
    expect(c.transaction).toBe(true);
    await c.commit();
    expect(c.transaction).toBeUndefined();

    await c.beginTransaction();
    await c.rollback();
    expect(c.transaction).toBeUndefined();
  });
});

describe('disposal (Symbol.asyncDispose)', () => {
  test('rolls back a still-open transaction, never silently commits, then releases', async () => {
    const fake = createFakeConnection();
    const c = new MySql(fake as any);
    await c.beginTransaction();

    await asyncDispose(c);

    expect(fake.ops()).toEqual(['begin', 'rollback', 'release']);
    expect(fake.ops()).not.toContain('commit');
  });

  test('an explicitly committed transaction is just released', async () => {
    const fake = createFakeConnection();
    const c = new MySql(fake as any);
    await c.beginTransaction();
    await c.commit();

    await asyncDispose(c);

    expect(fake.ops()).toEqual(['begin', 'commit', 'release']);
  });

  test('a non-transactional connection is released without rollback', async () => {
    const fake = createFakeConnection();
    const c = new MySql(fake as any);

    await asyncDispose(c);

    expect(fake.ops()).toEqual(['release']);
  });
});

describe('getConnection', () => {
  test('wraps a freshly leased pool connection', async () => {
    setConnectionFactory(() => createFakeConnection(123));
    const conn = await getConnection();
    expect(conn).toBeInstanceOf(MySql);
    expect(conn!.id).toBe(123);
  });

  test('fails with a clear error when no connection frees up in time', async () => {
    const { fakePool } = await import('../../helpers/db');
    const original = fakePool.getConnection;
    let resolveLate: (c: any) => void = () => {};
    const late = createFakeConnection(555);

    fakePool.getConnection = () => new Promise((resolve) => (resolveLate = resolve)) as any;

    const { AcquireTimeoutError } = await import('database/connection');

    // fire the acquire timeout immediately
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: Function) => {
      fn();
      return 0 as any;
    }) as any);

    await expect(getConnection()).rejects.toBeInstanceOf(AcquireTimeoutError);
    timers.mockRestore();

    // a connection handed out after the timeout goes straight back to the pool
    resolveLate(late);
    await new Promise((r) => setImmediate(r));
    expect(late.ops()).toEqual(['release']);

    fakePool.getConnection = original;
  });
});

describe('destroy', () => {
  test('destroys the socket and skips release/rollback on dispose', async () => {
    const fake = createFakeConnection();
    const c = new MySql(fake as any);
    await c.beginTransaction();

    c.destroy();
    c.destroy(); // idempotent
    await asyncDispose(c);

    expect(fake.ops()).toEqual(['begin', 'destroy']);
  });
});
