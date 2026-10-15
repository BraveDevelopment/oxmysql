<div align="center">

# oxmysql

A FiveM resource to communicate with a MySQL database using [node-mysql2](https://github.com/sidorares/node-mysql2).

[![](https://img.shields.io/github/downloads/overextended/oxmysql/total?style=for-the-badge&logo=github)](https://github.com/overextended/oxmysql/releases/latest/download/oxmysql.zip)
[![](https://img.shields.io/github/downloads/overextended/oxmysql/latest/total?style=for-the-badge&logo=github)](https://github.com/overextended/oxmysql/releases/latest/download/oxmysql.zip)
[![](https://img.shields.io/github/v/release/overextended/oxmysql?style=for-the-badge&logo=github)](https://github.com/overextended/oxmysql/releases/latest/)\
[![](https://badges.5metrics.dev/oxmysql/serverRank.svg?style=for-the-badge)](https://5metrics.dev/resource/oxmysql)
[![](https://badges.5metrics.dev/oxmysql/servers.svg?style=for-the-badge)](https://5metrics.dev/resource/oxmysql)
[![](https://badges.5metrics.dev/oxmysql/players.svg?style=for-the-badge)](https://5metrics.dev/resource/oxmysql)

Refer to [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines and to see our Contributor License Agreement.\
Refer to [NOTICE.md](./NOTICE.md) for additional information and legal notices.

</div>

## 🔗 Links

- 💾 [Download](https://github.com/overextended/oxmysql/releases/latest/download/oxmysql.zip)
  - Download the latest release directly.
- 📚 [Documentation](https://overextended.dev/oxmysql)
  - For installation, setup, and everything else.
- 📦 [npm](https://www.npmjs.com/package/@overextended/oxmysql)
  - Use our npm package for enhanced functionality and TypeScript support.

## ✨ Features

- Node 22 only (FiveM / FiveM Enhanced with `node_version '22'`).
- Promises / async query handling allowing for non-blocking and awaitable responses.
- Named (`:name`, `@name`) and positional (`?`) placeholders.
- Automatic retry of InnoDB deadlocks, atomic batches, hard transaction timeouts.
- Support for URI connection strings and semicolon separated values.

## 3.0.0: changes in this fork

### Breaking

- Removed the mysql-async / ghmattimysql compatibility layer (`provide`, `MySQL.Async`, `MySQL.Sync`, `fetchAll`, `store`, query-store number references, `execute` / `fetch` / `*Sync` exports, `mysql_option 'return_callback_errors'`).
- `prepare` always returns the same shape: rows for SELECT, `insertId` for INSERT/REPLACE, `affectedRows` for UPDATE/DELETE. Use `single` / `scalar` for one row or value.
- Batches (`prepare` / `rawExecute` with a list of parameter sets) run in one transaction, roll back completely on error and return one entry per set.
- Callback-style calls always receive `(result, err)`; on error `result` is `nil` and `err` is the message.
- Binary columns (BLOB, BINARY, VARBINARY) are returned as Buffers, which arrive in Lua as byte strings instead of number tables.
- `@name` is only treated as a placeholder when the key exists in the parameters; otherwise it stays a MySQL user variable.

### Fixed

- `mysql_transaction_isolation_level` now uses `SET SESSION`; previously it only applied to the first transaction of each connection.
- Connection string values are typed: `false` / `true` become booleans, numbers become numbers, credentials in URIs are URL-decoded and `=` inside key-value passwords is kept.
- `maxPreparedStatements` defaults to 250 per connection, and a warning is printed when `connectionLimit x maxPreparedStatements` could exceed the server's `max_prepared_stmt_count`.
- `startTransaction` timeouts destroy the connection, so the server rolls back and releases row locks immediately.
- Statement types are detected case-insensitively and after comments; placeholders inside strings and comments are ignored.
- `prepare` and `query` return identical types (TINYINT(1) as boolean, dates as epoch ms).
- DATE / DATETIME / TIMESTAMP are parsed with the `timezone` connection option (`local`, `Z`, `+HH:MM`). With a fixed zone the session `time_zone` is set to match.

### New convars

| Convar | Default | |
| --- | --- | --- |
| `mysql_transaction_timeout` | `30000` | ms before a `startTransaction` callback is aborted |
| `mysql_acquire_timeout` | `10000` | ms a query may wait for a free connection (`0` = unlimited) |
| `mysql_deadlock_retries` | `3` | retries after InnoDB deadlocks (lock wait timeouts: once) |
| `mysql_strict_params` | `false` | throw on missing parameters instead of binding NULL |

Connection string defaults: `maxPreparedStatements=250`, `queueLimit=2000`. Recommended: `timezone=Z`.

### Bulk inserts

Multi-row inserts are much faster than a `prepare` batch:

```lua
MySQL.update.await('INSERT INTO items (owner, name, count) VALUES ?', { rows })
-- rows = { { 'char1', 'bread', 2 }, { 'char1', 'water', 1 }, ... }
```

### Tests

```sh
bun run test                                                            # unit tests
DB_CONNECTION='mysql://user:pass@localhost/test_db' bun run test:integration  # against a real server
```

## 🧾 Logging

We have included a module for submitting error logs to [Fivemanage](https://refer.fivemanage.com/overextended), a cloud management service tailored for game servers. Additional logging options and support for other services will be available in the future.

## Lua Language Server

- Install [Lua Language Server](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) to ease development with annotations, type checking, diagnostics, and more.
- See [ox_types](https://github.com/overextended/ox_types) for our Lua type definitions.
