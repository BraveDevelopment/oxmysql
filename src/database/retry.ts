import { mysql_deadlock_retries } from 'config';
import { sleep } from '../utils/sleep';

export const ER_LOCK_DEADLOCK = 1213;
export const ER_LOCK_WAIT_TIMEOUT = 1205;

/**
 * Returns whether a failed statement or transaction may be repeated.
 * InnoDB rolls back the whole transaction on a deadlock, so repeating it is safe. A lock wait timeout already
 * waited `innodb_lock_wait_timeout` seconds, so it is only retried once.
 */
export function isRetryable(err: any, attempt: number) {
  if (attempt >= mysql_deadlock_retries) return false;

  switch (err?.errno) {
    case ER_LOCK_DEADLOCK:
      return true;
    case ER_LOCK_WAIT_TIMEOUT:
      return attempt === 0;
    default:
      return false;
  }
}

/**
 * Runs `fn` and repeats it after InnoDB deadlocks with a short, jittered backoff.
 * `fn` must contain the complete unit of work (a single autocommit statement or a full transaction).
 */
export async function withRetry<T>(fn: () => Promise<T>, onRetry?: (err: any, attempt: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err, attempt)) throw err;

      onRetry?.(err, attempt + 1);

      await sleep(Math.floor(10 * 2 ** attempt + Math.random() * 25));
    }
  }
}
