import type { OkPacket, ResultSetHeader, RowDataPacket, ProcedureCallPacket } from 'mysql2';

export type QueryResponse =
  | OkPacket
  | ResultSetHeader
  | ResultSetHeader[]
  | RowDataPacket[]
  | RowDataPacket[][]
  | OkPacket[]
  | ProcedureCallPacket;

export type QueryType = 'execute' | 'insert' | 'update' | 'scalar' | 'single' | null;

export type TransactionStatement = { query: string; parameters?: CFXParameters; values?: CFXParameters };

/** `['sql', ...]`, `[['sql', params], ...]` or `[{ query, parameters | values }, ...]` */
export type TransactionQuery = (string | [string, CFXParameters] | TransactionStatement)[];

// working with this type is impossible but at least we can pretend to be strictly typed
export type CFXParameters = any[];

export type CFXCallback = (result: unknown, err?: string) => void;
