export function logRetry(invokingResource: string, query: string, err: any, attempt: number) {
  console.warn(
    `^3${invokingResource}: ${err?.code ?? 'lock error'} (${err?.errno}), retrying (attempt ${attempt}).\n${query}^0`,
  );
}
