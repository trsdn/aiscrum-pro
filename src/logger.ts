import pino from "pino";
import type { Logger, DestinationStream } from "pino";
import * as fs from "node:fs";
import * as path from "node:path";

export type { Logger };

/**
 * Configuration options for creating a pino logger instance.
 */
export interface LoggerOptions {
  level?: "debug" | "info" | "warn" | "error";
  name?: string;
  pretty?: boolean;
}

/**
 * Contextual metadata attached to child loggers for sprint-scoped logging.
 */
export interface SprintContext {
  sprint?: number;
  issue?: number;
  ceremony?: string;
}

let logDestination: DestinationStream | undefined;
let errorLogDir: string | undefined;

/**
 * Get the directory where daily error logs are stored.
 */
export function getErrorLogDir(): string | undefined {
  return errorLogDir;
}

/**
 * Initialize daily error log file. Creates a logs/ directory and writes
 * errors/warnings to a date-stamped file (e.g. logs/2026-03-03.log).
 * Call once at startup.
 */
export function initErrorLogFile(projectPath: string): void {
  errorLogDir = path.join(projectPath, "logs");
  fs.mkdirSync(errorLogDir, { recursive: true });
}

function getErrorLogPath(): string | undefined {
  if (!errorLogDir) return undefined;
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(errorLogDir, `${date}.log`);
}

/**
 * Append a structured log entry to today's error log file.
 */
export function appendErrorLog(
  level: "error" | "warn" | "info",
  message: string,
  context?: Record<string, unknown>,
): void {
  const logPath = getErrorLogPath();
  if (!logPath) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Can't log a logging failure — silently skip
  }
}

/**
 * Redirect all logger output to a file. Call this before rendering the TUI
 * so pino doesn't corrupt Ink's terminal output.
 */
export function redirectLogToFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  logDestination = pino.destination({ dest: filePath, sync: false });
  const opts = {
    name: logger.bindings().name ?? "aiscrum",
    level: logger.level,
    redact: {
      paths: ["*.password", "*.token", "*.secret", "*.apiKey", "*.authorization"],
      censor: "[REDACTED]",
    },
  };
  const newLogger = pino(opts, logDestination);
  Object.assign(logger, newLogger);
}

/**
 * Create a new pino logger with the given options.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const {
    level = "info",
    name = "aiscrum",
    pretty = process.env["NODE_ENV"] !== "production",
  } = options;

  const transport =
    !logDestination && pretty ? { target: "pino-pretty", options: { colorize: true } } : undefined;

  const pinoOptions = {
    name,
    level,
    transport,
    redact: {
      paths: ["*.password", "*.token", "*.secret", "*.apiKey", "*.authorization"],
      censor: "[REDACTED]",
    },
  };

  return logDestination ? pino(pinoOptions, logDestination) : pino(pinoOptions);
}

/** Default logger instance for convenience. */
export const logger = createLogger();
