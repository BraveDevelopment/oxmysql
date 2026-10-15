import { connectionTimezone, getConnectionOptions, mysql_transaction_isolation_level } from 'config';
import { createPool } from 'mysql2/promise';
import type { Pool, PoolOptions, RowDataPacket } from 'mysql2/promise';
import { sessionTimezone } from 'utils/typeCast';

export let pool: Pool | undefined;
export let dbVersion = '';

let resolveReady: () => void;

/** Resolves once the pool is connected. Queries wait on this instead of polling. */
export const poolReady = new Promise<void>((resolve) => (resolveReady = resolve));

export function sessionStatements() {
  const statements = [mysql_transaction_isolation_level];
  const timezone = sessionTimezone(connectionTimezone);

  // keep TIMESTAMP values in the same zone the typecast uses to parse them
  if (timezone) statements.push(`SET time_zone = '${timezone}'`);

  return statements;
}

function warnPreparedStatementLimit(config: PoolOptions, serverLimit: number) {
  const connections = Number(config.connectionLimit ?? 10);
  const perConnection = Number(config.maxPreparedStatements);
  const total = connections * perConnection;

  if (!Number.isFinite(serverLimit) || total <= serverLimit * 0.8) return;

  console.warn(
    `^3connectionLimit (${connections}) x maxPreparedStatements (${perConnection}) = ${total} cached statements, ` +
      `but the server allows ${serverLimit} in total (max_prepared_stmt_count). ` +
      `Lower maxPreparedStatements to at most ${Math.floor((serverLimit * 0.8) / connections)} or raise the server limit.^0`,
  );
}

export async function createConnectionPool() {
  const config = getConnectionOptions();

  try {
    const dbPool = createPool(config);
    const statements = sessionStatements();

    // runs before the connection is handed out; mysql2 executes queued commands in order
    // the event receives the callback-API connection, not the promise wrapper
    dbPool.on('connection', (connection: any) => {
      for (const statement of statements) {
        connection.query(statement, (err: Error | null) => {
          if (err) console.error(`^1Failed to apply session setting '${statement}': ${err.message}^0`);
        });
      }
    });

    const [result] = (await dbPool.query(
      'SELECT VERSION() AS version, @@GLOBAL.max_prepared_stmt_count AS maxStatements',
    )) as RowDataPacket[];

    dbVersion = `^5[${result[0].version}]`;

    console.log(`${dbVersion} ^2Database server connection established!^0`);

    warnPreparedStatementLimit(config, Number(result[0].maxStatements));

    if (config.multipleStatements) {
      console.warn(`multipleStatements is enabled. Used incorrectly, this option may cause SQL injection.`);
    }

    pool = dbPool;
    resolveReady();
  } catch (err: any) {
    const message = err.message.includes('auth_gssapi_client')
      ? `Requested authentication using unknown plugin auth_gssapi_client.`
      : err.message;

    console.log(
      `^3Unable to establish a connection to the database (${err.code})!\n^1Error${
        err.errno ? ` ${err.errno}` : ''
      }: ${message}^0`,
    );

    console.log(`See https://github.com/overextended/oxmysql/issues/154 for more information.`);

    const { password, typeCast, ...printable } = config;
    console.log({ ...printable, password: password ? '******' : undefined });
  }
}
