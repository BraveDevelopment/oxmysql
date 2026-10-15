import { setDebug } from '../config';
import { sleep } from '../utils/sleep';
import { pool, createConnectionPool } from './pool';

setDebug();

setTimeout(async () => {
  while (!pool) {
    await createConnectionPool();

    if (!pool) await sleep(30000);
  }
});

// convars can change at runtime
setInterval(setDebug, 1000);

export * from './connection';
export * from './rawQuery';
export * from './rawExecute';
export * from './rawTransaction';
export * from './startTransaction';
export * from './pool';
