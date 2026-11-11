/**
 * Card `start_ts`/`end_ts` arrive as Unix seconds (Windows, macOS) or milliseconds (older
 * integrations); values from 1e11 up are milliseconds. Every SQL that turns them into minutes or
 * instants goes through these helpers so the guess lives in one place.
 */
const unit = (alias: string) => `CASE WHEN ${alias}.start_ts >= 100000000000 THEN 1000.0 ELSE 1.0 END`

/** Card duration in minutes (never negative). */
export const cardMinutesSQL = (alias = 'c') => `(GREATEST(0, ${alias}.end_ts - ${alias}.start_ts) / (60.0 * ${unit(alias)}))`

/** Card start as timestamptz. */
export const cardStartSQL = (alias = 'c') => `to_timestamp(${alias}.start_ts / ${unit(alias)})`
