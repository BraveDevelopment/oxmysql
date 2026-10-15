import type { Connection, PoolConnection } from 'mysql2/promise';
import { mysql_acquire_timeout } from 'config';
import { scheduleTick } from '../utils/scheduleTick';
import { pool, poolReady } from './pool';
import type { CFXParameters } from 'types';

interface PromisePoolConnection extends Connection {
  connection: PoolConnection;
  release: PoolConnection['release'];
  destroy: PoolConnection['destroy'];
}

export class MySql {
  id: number;
  connection: PromisePoolConnection;
  transaction?: boolean;
  destroyed?: boolean;

  constructor(connection: PromisePoolConnection) {
    this.id = connection.connection.threadId;
    this.connection = connection;
  }

  async query(query: string, values: CFXParameters = []) {
    scheduleTick();

    const [result] = await this.connection.query(query, values);
    return result;
  }

  async execute(query: string, values: CFXParameters = []) {
    scheduleTick();

    // typecasting comes from the pool config and applies to both protocols
    const [result] = await this.connection.execute(query, values);
    return result;
  }

  beginTransaction() {
    this.transaction = true;
    return this.connection.beginTransaction();
  }

  rollback() {
    delete this.transaction;
    return this.connection.rollback();
  }

  commit() {
    delete this.transaction;
    return this.connection.commit();
  }

  /**
   * Closes the socket and removes the connection from the pool. The server rolls back any open
   * transaction and releases its locks; in-flight queries fail.
   */
  destroy() {
    if (this.destroyed) return;

    this.destroyed = true;
    delete this.transaction;
    this.connection.destroy();
  }

  async [Symbol.asyncDispose]() {
    if (this.destroyed) return;

    // never silently commit a transaction the caller left open; roll it back
    if (this.transaction) await this.rollback().catch(() => {});

    this.connection.release();
  }
}

export class AcquireTimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms waiting for a free database connection (pool exhausted).`);
  }
}

async function acquire(): Promise<PromisePoolConnection> {
  const pending = pool!.getConnection() as unknown as Promise<PromisePoolConnection>;

  if (!mysql_acquire_timeout) return pending;

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new AcquireTimeoutError(mysql_acquire_timeout));
        }, mysql_acquire_timeout);
      }),
    ]);
  } catch (err) {
    // the pool may still hand us the connection later; give it straight back
    if (timedOut) pending.then((connection) => connection.release()).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getConnection() {
  if (!pool) await poolReady;

  return new MySql(await acquire());
}
