import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { resetNatives, setConvar, getCommand, getNetHandler, getEmitNetCalls } from '../setup';
import * as config from 'config';
import { logError, logQuery } from 'logger';

const enableUi = () => {
  setConvar('mysql_ui', 'true');
  setConvar('mysql_debug', 'false');
  config.setDebug();
};

beforeEach(() => resetNatives());

describe('logError', () => {
  test('prints a formatted error and emits oxmysql:error (console path)', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const events: any[] = [];
    (globalThis as any).TriggerEvent = (name: string, payload: any) => events.push({ name, payload });

    logError('res', undefined, undefined, new Error('bad'), 'SELECT 1', [1], true);

    const output = String(errSpy.mock.calls[0][0]);
    expect(output).toContain('res was unable to execute a query');
    expect(output).toContain('Query: SELECT 1');
    expect(output).toContain('bad');
    expect(events.find((e) => e.name === 'oxmysql:error')).toBeDefined();
    errSpy.mockRestore();
  });

  test('returns the error to the callback in promise mode', () => {
    let call: any[] | undefined;
    logError('res', (...a) => (call = a), true, 'plain failure');
    expect(call![0]).toBeNull();
    expect(String(call![1])).toContain('res was unable to execute a query');
    expect(String(call![1])).toContain('plain failure');
  });
});

describe('logQuery', () => {
  test('warns about a slow query over the threshold', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    setConvar('mysql_slow_query_warning', '200');
    config.setDebug();
    logQuery('res', 'SELECT SLEEP(1)', 250, [1]);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('took 250'))).toBe(true);
    logSpy.mockRestore();
  });

  test('stays quiet for a fast query when debug is off and ui is off', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    setConvar('mysql_debug', 'false');
    setConvar('mysql_ui', 'false');
    config.setDebug();
    logQuery('res', 'SELECT 1', 5);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("the 'mysql' command", () => {
  test('emits the UI payload to the requesting client', () => {
    enableUi();
    logQuery('cmdRes', 'SELECT 1', 5);
    getCommand('mysql')!(1);
    const emit = getEmitNetCalls().find((a) => a[0] === 'oxmysql:openUi');
    expect(emit).toBeDefined();
    expect(emit![1]).toBe(1);
  });

  test('refuses to run server-side (source 0)', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    enableUi();
    getCommand('mysql')!(0);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('cannot run server side'))).toBe(true);
    expect(getEmitNetCalls().find((a) => a[0] === 'oxmysql:openUi')).toBeUndefined();
    logSpy.mockRestore();
  });
});

describe('oxmysql:fetchResource net handler', () => {
  test('returns nothing for a player without the command.mysql ace', () => {
    enableUi();
    (globalThis as any).IsPlayerAceAllowed = () => false;
    getNetHandler('oxmysql:fetchResource')!({ resource: 'res', pageIndex: 0, search: '' });
    expect(getEmitNetCalls().find((a) => a[0] === 'oxmysql:loadResource')).toBeUndefined();
  });

  test('returns paginated/sorted log data for an authorised player', () => {
    enableUi();
    (globalThis as any).IsPlayerAceAllowed = () => true;
    (globalThis as any).source = 1;
    logQuery('fetchRes', 'SELECT a', 10);
    logQuery('fetchRes', 'SELECT b', 20);

    getNetHandler('oxmysql:fetchResource')!({
      resource: 'fetchRes',
      pageIndex: 0,
      search: '',
      sortBy: [{ id: 'executionTime', desc: true }],
    });

    const emit = getEmitNetCalls().find((a) => a[0] === 'oxmysql:loadResource');
    expect(emit).toBeDefined();
    expect(emit![2].resourceQueriesCount).toBeGreaterThanOrEqual(2);
  });

  test('applies a case-insensitive search filter', () => {
    enableUi();
    (globalThis as any).IsPlayerAceAllowed = () => true;
    (globalThis as any).source = 1;
    logQuery('searchRes', 'SELECT needle', 10);
    logQuery('searchRes', 'SELECT haystack', 10);

    getNetHandler('oxmysql:fetchResource')!({ resource: 'searchRes', pageIndex: 0, search: 'NEEDLE' });

    const emit = getEmitNetCalls().find((a) => a[0] === 'oxmysql:loadResource');
    expect(emit).toBeDefined();
    expect(emit![2].queries.every((q: any) => q.query.toLowerCase().includes('needle'))).toBe(true);
  });
});

describe('QueryRing', () => {
  test('keeps the newest entries in order without shifting the array', async () => {
    const { QueryRing } = await import('logger');
    const ring = new QueryRing(3);
    const entry = (n: number) => ({ query: `q${n}`, executionTime: n, date: n });

    for (let i = 1; i <= 5; i++) ring.push(entry(i), 3);

    expect(ring.length).toBe(3);
    expect(ring.toArray().map((q) => q.query)).toEqual(['q3', 'q4', 'q5']);

    // shrinking keeps the most recent entries
    ring.push(entry(6), 2);
    expect(ring.toArray().map((q) => q.query)).toEqual(['q5', 'q6']);
  });
});

describe('callback errors', () => {
  test('callback-style callers get (null, message) and the error is printed', async () => {
    const { logError } = await import('logger');
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const args: unknown[][] = [];

    logError('res', (...a: unknown[]) => args.push(a), false, new Error('bad'), 'SELECT 1');

    expect(args).toHaveLength(1);
    expect(args[0][0]).toBeNull();
    expect(String(args[0][1])).toContain('bad');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
