import { pino, type Logger, type LevelWithSilent } from 'pino';

// Structured JSON logs to stdout (ADR-0020). Redaction and correlation ids are added in
// US3.
export function createLogger(level: LevelWithSilent = 'info'): Logger {
  return pino({ level });
}
