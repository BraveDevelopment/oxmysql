import type { TypeCastField, TypeCastNext } from 'mysql2/promise';

const BINARY_CHARSET = 63;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/;

/**
 * Accepts mysql2's timezone formats ('local', 'Z', '+HH:MM', '-HH:MM'). A space is treated as '+',
 * since URL query strings decode '+' to a space.
 */
export function normaliseTimezone(timezone?: unknown) {
  if (typeof timezone !== 'string' || timezone === '' || timezone === 'local') return 'local';
  if (timezone === 'Z' || timezone === 'z') return 'Z';

  const match = /^([ +-])(\d{2}):(\d{2})$/.exec(timezone);

  if (!match) {
    console.warn(`^3Ignoring invalid timezone '${timezone}', expected 'local', 'Z' or '+HH:MM'.^0`);
    return 'local';
  }

  return `${match[1] === '-' ? '-' : '+'}${match[2]}:${match[3]}`;
}

/** SQL value for `SET time_zone`, or null when the server's zone should be used ('local'). */
export function sessionTimezone(timezone: string) {
  if (timezone === 'local') return null;
  return timezone === 'Z' ? '+00:00' : timezone;
}

function offsetMinutes(timezone: string) {
  if (timezone === 'Z') return 0;
  const sign = timezone[0] === '-' ? -1 : 1;
  return sign * (parseInt(timezone.slice(1, 3), 10) * 60 + parseInt(timezone.slice(4, 6), 10));
}

/**
 * Parses MySQL date strings into epoch milliseconds without relying on the host's Date string parsing.
 * Zero dates ('0000-00-00') return null.
 */
export function parseDateTime(value: string | null, timezone: string): number | null {
  if (!value) return null;

  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = +match[1];
  const month = +match[2];
  const day = +match[3];

  if (month === 0 || day === 0) return null;

  const hours = match[4] ? +match[4] : 0;
  const minutes = match[5] ? +match[5] : 0;
  const seconds = match[6] ? +match[6] : 0;
  const ms = match[7] ? +match[7].padEnd(3, '0').slice(0, 3) : 0;

  const date =
    timezone === 'local'
      ? new Date(2000, month - 1, day, hours, minutes, seconds, ms)
      : new Date(Date.UTC(2000, month - 1, day, hours, minutes, seconds, ms));

  // set the year separately; Date treats years 0-99 as 1900-1999
  if (timezone === 'local') date.setFullYear(year);
  else date.setUTCFullYear(year);

  const time = date.getTime();

  return timezone === 'local' ? time : time - offsetMinutes(timezone) * 60000;
}

/**
 * Shared typecasting for the text (query) and binary (execute) protocols, so both return identical values:
 * - DATE/DATETIME/TIMESTAMP -> epoch milliseconds (interpreted in the configured timezone)
 * - TINYINT(1) / BIT(1) -> boolean
 * - binary BLOB/BINARY/VARBINARY -> Buffer (arrives in Lua as a byte string)
 */
export function createTypeCast(timezone: string) {
  return function typeCast(field: TypeCastField, next: TypeCastNext) {
    switch (field.type) {
      case 'DATETIME':
      case 'DATETIME2':
      case 'TIMESTAMP':
      case 'TIMESTAMP2':
      case 'NEWDATE':
      case 'DATE':
        return parseDateTime(field.string(), timezone);

      case 'TINY': {
        if (field.length !== 1) return next();

        const value = field.string();

        return value === null ? null : value === '1';
      }

      case 'BIT': {
        const buffer = field.buffer();

        if (!buffer) return null;

        return buffer.length === 1 ? buffer[0] === 1 : buffer;
      }

      case 'TINY_BLOB':
      case 'MEDIUM_BLOB':
      case 'LONG_BLOB':
      case 'BLOB':
      case 'STRING':
      case 'VAR_STRING':
        if ((field as any).charset === BINARY_CHARSET) return field.buffer();
        return next();

      default:
        return next();
    }
  };
}
