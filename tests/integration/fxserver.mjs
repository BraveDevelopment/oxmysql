// Runs the built bundle (dist/build.js) against a real MySQL/MariaDB server with stubbed FiveM natives.
//
//   DB_CONNECTION='mysql://user:pass@localhost/test_db' node tests/integration/fxserver.mjs
//
// The database user needs CREATE/DROP on that database. Tables are prefixed with `oxit_`.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const require = createRequire(import.meta.url);
const base = process.env.DB_CONNECTION;

if (!base) {
  console.error('Set DB_CONNECTION, e.g. mysql://user:pass@localhost/test_db');
  process.exit(1);
}

const separator = base.includes('?') ? '&' : '?';

const convars = {
  mysql_connection_string: `${base}${separator}connectionLimit=3&timezone=Z&decimalNumbers=false&maxPreparedStatements=100`,
  mysql_transaction_timeout: '1500',
  mysql_acquire_timeout: '1000',
  mysql_versioncheck: '0',
  mysql_slow_query_warning: '100000',
};

const exportsRegistry = {};
const warnings = [];
const errors = [];

Object.assign(globalThis, {
  GetConvar: (name, fallback) => convars[name] ?? fallback,
  GetConvarInt: (name, fallback) => (convars[name] !== undefined ? parseInt(convars[name], 10) : fallback),
  SetConvar: (name, value) => (convars[name] = value),
  GetCurrentResourceName: () => 'oxmysql',
  GetInvokingResource: () => 'itest',
  GetResourceMetadata: () => undefined,
  ScheduleResourceTick: () => {},
  LoadResourceFile: () => '',
  RegisterCommand: () => {},
  on: () => {},
  onNet: () => {},
  emitNet: () => {},
  TriggerEvent: () => {},
  IsPlayerAceAllowed: () => false,
  source: 0,
});

globalThis.exports = (name, fn) => (exportsRegistry[name] = fn);

const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => warnings.push(args.join(' '));
console.error = (...args) => errors.push(args.join(' '));

// the bundle is CommonJS (as FXServer loads it), but package.json declares "type": "module"
const bundle = new URL('../../dist/itest-build.cjs', import.meta.url);
copyFileSync(new URL('../../dist/build.js', import.meta.url), bundle);
require(bundle.pathname);

const ox = exportsRegistry;
const call = (method, query, params) => ox[`${method}_async`](query, params, 'itest');

// a separate plain connection, used to observe locks and session state from outside
const external = await mysql.createConnection(base);

const results = [];

async function check(name, fn) {
  const started = performance.now();

  try {
    await fn();
    results.push([true, name, performance.now() - started]);
  } catch (err) {
    results.push([false, name, performance.now() - started, err]);
  }
}

await ox.awaitConnection();

await external.query('DROP TABLE IF EXISTS oxit_rows, oxit_lock, oxit_blob, oxit_time, oxit_dec, oxit_heavy');
await external.query('CREATE TABLE oxit_rows (id INT PRIMARY KEY, v INT) ENGINE=InnoDB');
await external.query('CREATE TABLE oxit_lock (id INT PRIMARY KEY, v INT) ENGINE=InnoDB');
await external.query('INSERT INTO oxit_lock VALUES (1, 0), (2, 0), (3, 0)');
await external.query('CREATE TABLE oxit_heavy (id INT AUTO_INCREMENT PRIMARY KEY, pad CHAR(100)) ENGINE=InnoDB');
await external.query('CREATE TABLE oxit_blob (id INT PRIMARY KEY, data BLOB, bin VARBINARY(8)) ENGINE=InnoDB');
await external.query('CREATE TABLE oxit_time (id INT PRIMARY KEY, ts TIMESTAMP NULL, dt DATETIME(3) NULL, d DATE NULL) ENGINE=InnoDB');
await external.query('CREATE TABLE oxit_dec (id INT PRIMARY KEY, amount DECIMAL(10, 2), flag TINYINT(1)) ENGINE=InnoDB');

await check('isolation level stays READ COMMITTED for every transaction on a connection', async () => {
  for (let i = 0; i < 5; i++) {
    let first, second;

    await ox.startTransaction(async (query) => {
      [{ v: first }] = await query('SELECT v FROM oxit_lock WHERE id = 1');
      await external.query('UPDATE oxit_lock SET v = v + 1 WHERE id = 1');
      [{ v: second }] = await query('SELECT v FROM oxit_lock WHERE id = 1');
    }, 'itest');

    assert.equal(second, first + 1, `transaction ${i + 1} did not see the committed change`);
  }

  const [[row]] = await external.query('SELECT 1');
  assert.ok(row);
});

await check('connection string booleans are honoured (decimalNumbers=false keeps DECIMAL as string)', async () => {
  await call('query', 'INSERT INTO oxit_dec VALUES (1, 12.50, 1), (2, 0.10, 0)');
  const rows = await call('query', 'SELECT amount, flag FROM oxit_dec ORDER BY id');
  assert.deepEqual(rows, [
    { amount: '12.50', flag: true },
    { amount: '0.10', flag: false },
  ]);

  // TINYINT(1) is a boolean through the binary protocol as well
  assert.deepEqual(await call('prepare', 'SELECT flag FROM oxit_dec WHERE id = ?', [1]), [{ flag: true }]);
});

await check('prepared statement cache stays bounded (no max_prepared_stmt_count exhaustion)', async () => {
  const before = await external.query("SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'");
  const baseline = Number(before[0][0].Value);

  await Promise.all(
    Array.from({ length: 3 }, async (_, worker) => {
      for (let i = 0; i < 400; i++) await call('prepare', `SELECT ${worker * 1000 + i} AS n FROM DUAL WHERE 1 = ?`, [1]);
    }),
  );

  const [[status]] = await external.query("SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'");
  // 3 connections x maxPreparedStatements=100
  assert.ok(Number(status.Value) - baseline <= 300, `Prepared_stmt_count grew to ${status.Value}`);
});

await check('prepare batch: one transaction, atomic on failure', async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [i + 1, i]);
  const started = performance.now();
  const ids = await call('prepare', 'INSERT INTO oxit_rows (id, v) VALUES (?, ?)', rows);
  const took = performance.now() - started;

  assert.equal(ids.length, 2000);
  console.log(`      2000-row prepare batch: ${took.toFixed(0)} ms`);

  // duplicate key in the middle -> nothing from this batch may remain
  await assert.rejects(
    call('prepare', 'INSERT INTO oxit_rows (id, v) VALUES (?, ?)', [
      [5001, 1],
      [5002, 1],
      [1, 1],
      [5003, 1],
    ]),
    /Duplicate entry/,
  );

  const [[{ count }]] = await external.query('SELECT COUNT(*) AS count FROM oxit_rows WHERE id > 5000');
  assert.equal(count, 0);
});

await check('bulk insert through query with VALUES ?', async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [10001 + i, i]);
  const started = performance.now();
  const affected = await call('update', 'INSERT INTO oxit_rows (id, v) VALUES ?', [rows]);
  console.log(`      2000-row multi-row insert: ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(affected, 2000);
});

await check('prepare returns rows / insertId / affectedRows with a stable shape', async () => {
  assert.deepEqual(await call('prepare', 'SELECT v FROM oxit_rows WHERE id = ?', [1]), [{ v: 0 }]);
  assert.deepEqual(await call('prepare', 'SELECT v FROM oxit_rows WHERE id = ?', [-1]), []);
  assert.equal((await call('prepare', 'SELECT v FROM oxit_rows WHERE id < ?', [4])).length, 3);
  assert.equal(await call('prepare', 'update oxit_rows set v = v where id < ?', [4]), 3);
  const insertId = await call('prepare', '  insert into oxit_heavy (pad) values (?)', ['x']);
  assert.ok(Number.isInteger(insertId) && insertId > 0, `insertId was ${insertId}`);
});

await check('deadlocks inside transaction() are retried', async () => {
  await external.query('UPDATE oxit_lock SET v = 0');
  await external.beginTransaction();

  // make the external transaction heavier so InnoDB picks the oxmysql transaction as the victim
  await external.query("INSERT INTO oxit_heavy (pad) SELECT 'x' FROM oxit_rows LIMIT 500");
  await external.query('UPDATE oxit_lock SET v = v + 1 WHERE id = 1');

  const pending = call('transaction', ['UPDATE oxit_lock SET v = v + 10 WHERE id = 2', 'UPDATE oxit_lock SET v = v + 10 WHERE id = 1']);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await external.query('UPDATE oxit_lock SET v = v + 1 WHERE id = 2');
  await external.commit();

  assert.equal(await pending, true);
  assert.ok(
    warnings.some((w) => w.includes('ER_LOCK_DEADLOCK')),
    'expected a deadlock retry warning',
  );

  const [rows] = await external.query('SELECT id, v FROM oxit_lock WHERE id IN (1, 2) ORDER BY id');
  assert.deepEqual(rows.map((r) => r.v), [11, 11]);
});

await check('startTransaction timeout releases row locks and the connection', async () => {
  let stuck;
  const stuckPromise = new Promise((resolve) => (stuck = resolve));

  const result = ox.startTransaction(async (query) => {
    await query('UPDATE oxit_lock SET v = 100 WHERE id = 3');
    await stuckPromise;
    return true;
  }, 'itest');

  assert.equal(await result, false);

  // the lock must be gone right away
  await external.query('SET SESSION innodb_lock_wait_timeout = 2');
  const started = performance.now();
  await external.query('UPDATE oxit_lock SET v = v + 1 WHERE id = 3');
  assert.ok(performance.now() - started < 500, 'row lock was still held');

  const [[row]] = await external.query('SELECT v FROM oxit_lock WHERE id = 3');
  assert.equal(row.v, 1, 'the timed out transaction was committed');

  stuck();
  assert.ok(errors.some((e) => e.includes('timed out')));
});

await check('pool exhaustion fails fast with a clear error instead of queueing forever', async () => {
  const blockers = Array.from({ length: 3 }, () =>
    ox.startTransaction(() => new Promise((resolve) => setTimeout(() => resolve(true), 1200)), 'itest'),
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(call('scalar', 'SELECT 1'), /pool exhausted/);

  await Promise.all(blockers);
  assert.equal(await call('scalar', 'SELECT 1 AS one'), 1);
});

await check('BLOB and VARBINARY come back as Buffers through both protocols', async () => {
  const data = Buffer.from([0, 1, 2, 250, 255]);
  await call('prepare', 'INSERT INTO oxit_blob VALUES (?, ?, ?)', [1, data, Buffer.from('ab')]);

  const viaQuery = await call('single', 'SELECT data, bin FROM oxit_blob WHERE id = 1');
  const [viaPrepare] = await call('prepare', 'SELECT data, bin FROM oxit_blob WHERE id = ?', [1]);

  for (const row of [viaQuery, viaPrepare]) {
    assert.ok(Buffer.isBuffer(row.data));
    assert.deepEqual([...row.data], [...data]);
    assert.equal(row.bin.toString(), 'ab');
  }
});

await check('dates use the configured timezone, independent of the host', async () => {
  await call('query', "INSERT INTO oxit_time VALUES (1, '2024-01-02 03:04:05', '2024-01-02 03:04:05.678', '2024-01-02')");
  await call('query', 'INSERT INTO oxit_time (id, ts) VALUES (2, NOW())');

  const row = await call('single', 'SELECT ts, dt, d FROM oxit_time WHERE id = 1');
  assert.deepEqual(row, {
    ts: Date.UTC(2024, 0, 2, 3, 4, 5),
    dt: Date.UTC(2024, 0, 2, 3, 4, 5, 678),
    d: Date.UTC(2024, 0, 2),
  });

  const [prepared] = await call('prepare', 'SELECT ts, dt, d FROM oxit_time WHERE id = ?', [1]);
  assert.deepEqual(prepared, row);

  const now = await call('scalar', 'SELECT ts FROM oxit_time WHERE id = 2');
  assert.ok(Math.abs(now - Date.now()) < 5000, `NOW() was ${now - Date.now()} ms off`);
});

await check('named placeholders leave MySQL user variables alone', async () => {
  assert.equal(await call('scalar', 'SELECT (@oxit_rank := :start) + 1 AS r', { start: 7 }), 8);
  assert.equal(await call('scalar', 'SELECT @oxit_rank AS r', {}), 7);
  assert.equal(await call('scalar', "SELECT CONCAT(':id', '@x', :id) AS r", { id: 'ok' }), ':id@xok');
});

await check('single() warns when it transfers more than one row', async () => {
  warnings.length = 0;
  assert.deepEqual(await call('single', 'SELECT id FROM oxit_rows WHERE id < 3 ORDER BY id'), { id: 1 });
  assert.ok(warnings.some((w) => w.includes('LIMIT 1')));
});

await check('callback-style errors reach the callback', async () => {
  const args = await new Promise((resolve) => ox.query('SELEC nope', [], (...a) => resolve(a), 'itest', false));
  assert.equal(args[0], null);
  assert.match(args[1], /syntax/);
});

await external.query('DROP TABLE IF EXISTS oxit_rows, oxit_lock, oxit_blob, oxit_time, oxit_dec, oxit_heavy');
await external.end();

console.warn = originalWarn;
console.error = originalError;

let failed = 0;

for (const [ok, name, ms, err] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (${ms.toFixed(0)} ms)`);
  if (!ok) {
    failed++;
    console.log(`      ${err?.stack ?? err}`);
  }
}

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
