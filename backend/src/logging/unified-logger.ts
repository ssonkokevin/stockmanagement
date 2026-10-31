import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = 'INF' | 'WRN' | 'ERR' | 'DBG';

export type LogCategory =
  | 'HTTP'     | 'API'      | 'AUTH'     | 'FRONTEND'
  | 'SMTP'     | 'STOCK'    | 'APPROVAL' | 'AUDIT'
  | 'HEALTH'   | 'PROCESS'  | 'SERVER'   | 'DB'
  | 'CONSOLE'  | 'BUSINESS' | 'SECURITY' | 'PERF'
  | string;     // allow legacy categories

export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  trace?: string;
  user?: string;
  duration_ms?: number;
  message: string;
  meta?: Record<string, unknown>;
}

// ─── ANSI colors for console output ───────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  green:   '\x1b[32m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
};

function colorLevel(level: LogLevel): string {
  switch (level) {
    case 'ERR': return `${C.bold}${C.red}ERROR${C.reset}`;
    case 'WRN': return `${C.bold}${C.yellow}WARN ${C.reset}`;
    case 'DBG': return `${C.gray}DEBUG${C.reset}`;
    default:    return `${C.green}INFO ${C.reset}`;
  }
}

function colorCategory(cat: string): string {
  switch (cat) {
    case 'HTTP':     return `${C.cyan}HTTP    ${C.reset}`;
    case 'API':      return `${C.cyan}API     ${C.reset}`;
    case 'AUTH':     return `${C.magenta}AUTH    ${C.reset}`;
    case 'FRONTEND': return `${C.blue}FRONTEND${C.reset}`;
    case 'SMTP':     return `${C.yellow}SMTP    ${C.reset}`;
    case 'STOCK':    return `${C.green}STOCK   ${C.reset}`;
    case 'APPROVAL': return `${C.blue}APPROVAL${C.reset}`;
    case 'AUDIT':    return `${C.magenta}AUDIT   ${C.reset}`;
    case 'HEALTH':   return `${C.gray}HEALTH  ${C.reset}`;
    case 'BUSINESS': return `${C.green}BUSINESS${C.reset}`;
    case 'SECURITY': return `${C.red}SECURITY${C.reset}`;
    case 'PERF':     return `${C.yellow}PERF    ${C.reset}`;
    case 'DB':       return `${C.cyan}DB      ${C.reset}`;
    case 'SERVER':   return `${C.white}SERVER  ${C.reset}`;
    case 'PROCESS':  return `${C.gray}PROCESS ${C.reset}`;
    default:         return `${C.white}${cat.padEnd(8).slice(0, 8)}${C.reset}`;
  }
}

// ─── Category → file routing ──────────────────────────────────────────────────

const CATEGORY_FILES: Partial<Record<LogCategory, string>> = {
  AUTH:     'auth.log',
  AUDIT:    'audit.log',
  SECURITY: 'audit.log',
  SMTP:     'smtp.log',
  STOCK:    'stock.log',
  BUSINESS: 'stock.log',
  HEALTH:   'health.log',
  FRONTEND: 'frontend.log',
  ERR:      'errors.log',
};

// Categories that should also be written to errors.log regardless of level
const ALWAYS_ERROR_FILE = new Set(['SECURITY']);

// GET requests at 200/304 will be suppressed unless explicitly needed
const NOISY_CATEGORIES = new Set(['HTTP_REQ', 'HTTP_RES', 'SERVICE_HEALTH']);

// How many health check logs to write before suppressing until change
let _lastHealthSummary = '';
let _suppressedHealthCount = 0;

// ─── File helpers ─────────────────────────────────────────────────────────────

let _logsDir: string | null = null;
function ensureLogsDir(): string {
  if (_logsDir) return _logsDir;
  _logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(_logsDir)) fs.mkdirSync(_logsDir, { recursive: true });
  return _logsDir;
}

function getDailyLogPath(date: Date = new Date()): string {
  const dir = ensureLogsDir();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(dir, `Hamilton-log-${y}${m}${d}.txt`);
}

function getCategoryLogPath(filename: string): string {
  return path.join(ensureLogsDir(), filename);
}

function appendFile(filePath: string, line: string): void {
  try {
    fs.appendFileSync(filePath, `${line}\n`);
  } catch {
    // silently skip if log directory not writable
  }
}

// ─── Timestamp ────────────────────────────────────────────────────────────────

export function formatLogTimestamp(date: Date): string {
  const p = (v: number, n = 2) => String(v).padStart(n, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return [
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`,
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`,
  ].join(' ');
}

// ─── Noise filters ────────────────────────────────────────────────────────────

export function shouldSuppressLog(source: string, message: string, level: LogLevel): boolean {
  // Always log errors and warnings
  if (level === 'ERR' || level === 'WRN') return false;

  // Suppress repetitive health checks — only log when something changes
  if (source === 'SERVICE_HEALTH' && message.includes('Check (interval)')) {
    const summary = message;
    if (summary === _lastHealthSummary) {
      _suppressedHealthCount++;
      // Log every 10 suppressed to show system is alive
      if (_suppressedHealthCount % 10 !== 0) return true;
    } else {
      _lastHealthSummary = summary;
      _suppressedHealthCount = 0;
    }
    return false;
  }

  // Suppress successful GET requests for noisy endpoints
  if (source === 'HTTP_REQ') {
    const noisyPaths = [
      '/api/current-stock-view',
      '/api/health',
      '/health',
      '/api/esim-stock',
    ];
    const isNoisy = noisyPaths.some((p) => message.includes(p));
    const isGet = message.includes(' GET ');
    if (isNoisy && isGet) return true;
  }

  if (source === 'HTTP_RES') {
    const is2xx3xx = message.includes('status=2') || message.includes('status=3');
    const isGet = !message.includes('POST') && !message.includes('PUT') && !message.includes('DELETE') && !message.includes('PATCH');
    const noisyPaths = ['/current-stock-view', '/esim-stock', '/health'];
    const isNoisyPath = noisyPaths.some((p) => message.includes(p));
    if (is2xx3xx && isGet && isNoisyPath) return true;
  }

  return false;
}

// ─── Core logLine ─────────────────────────────────────────────────────────────

export function logLine(level: LogLevel, source: string, message: string, meta?: Record<string, unknown>): void {
  if (shouldSuppressLog(source, message, level)) return;

  const now = new Date();
  const ts = formatLogTimestamp(now);

  // Destructure meta safely once to avoid repeated narrowing failures
  const traceVal    = meta ? (meta.trace     as string | undefined)  : undefined;
  const userVal     = meta ? (meta.user      as string | undefined)  : undefined;
  const durationVal = meta ? (meta.duration_ms as number | undefined): undefined;

  // ── Structured plaintext line for unified daily log ──
  const tracePart    = traceVal    ? ` trace=${traceVal}`                          : '';
  const userPart     = userVal     ? ` user=${userVal}`                            : '';
  const durationPart = durationVal !== undefined ? ` ${durationVal.toFixed(1)}ms` : '';
  const plainLine = `${ts} | ${level.padEnd(3)} | ${source.padEnd(12).slice(0, 12)} |${tracePart}${userPart} ${message}${durationPart}`;

  // ── Write to unified daily log ──
  appendFile(getDailyLogPath(now), plainLine);

  // ── Write to category-specific log ──
  const catFile = CATEGORY_FILES[source as LogCategory];
  if (catFile) appendFile(getCategoryLogPath(catFile), plainLine);
  if (level === 'ERR' || ALWAYS_ERROR_FILE.has(source)) {
    appendFile(getCategoryLogPath('errors.log'), plainLine);
  }

  // ── Colorized console output ──
  const consoleTs       = `${C.gray}${ts.slice(11, 23)}${C.reset}`;
  const consoleLevel    = colorLevel(level);
  const consoleCat      = colorCategory(source);
  const consoleTrace    = traceVal    ? ` ${C.dim}trace=${traceVal.slice(0, 8)}${C.reset}`        : '';
  const consoleDuration = durationVal !== undefined ? ` ${C.dim}${durationVal.toFixed(1)}ms${C.reset}` : '';

  // Use original console methods (captured before overrides)
  const writeFn = level === 'ERR' ? _origError : level === 'WRN' ? _origWarn : _origLog;
  writeFn(`${consoleTs} ${consoleLevel} ${consoleCat}${consoleTrace} ${message}${consoleDuration}`);
}

// ─── Convenience exports ──────────────────────────────────────────────────────

export function toLevel(level?: string): LogLevel {
  const raw = String(level || 'INFO').toUpperCase();
  if (raw.startsWith('ERR')) return 'ERR';
  if (raw.startsWith('WRN') || raw.startsWith('WARN')) return 'WRN';
  if (raw.startsWith('DBG') || raw.startsWith('DEBUG')) return 'DBG';
  return 'INF';
}

export function appendUnifiedLog(line: string): void {
  appendFile(getDailyLogPath(), line);
}

export function logFrontendActivity(level: string | undefined, page: string | undefined, message: string, user?: string, trace?: string): void {
  logLine(toLevel(level), 'FRONTEND', `${String(page || 'unknown')}: ${message}`, { user, trace });
}

export function logSmtpActivity(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  logLine(level, 'SMTP', message, meta);
}

// ─── Performance logging ──────────────────────────────────────────────────────

export const PERF_THRESHOLDS = {
  API_WARN_MS: 2000,
  DB_WARN_MS: 1000,
  SMTP_WARN_MS: 5000,
  FRONTEND_WARN_MS: 3000,
};

export function logPerf(context: string, durationMs: number, trace?: string): void {
  const threshold =
    context.startsWith('DB') ? PERF_THRESHOLDS.DB_WARN_MS :
    context.startsWith('SMTP') ? PERF_THRESHOLDS.SMTP_WARN_MS :
    PERF_THRESHOLDS.API_WARN_MS;

  if (durationMs >= threshold) {
    logLine('WRN', 'PERF', `SLOW ${context} took ${durationMs.toFixed(1)}ms (threshold ${threshold}ms)`, { trace, duration_ms: durationMs });
  }
}

// ─── Original console references (set by index.ts before overrides) ───────────
let _origLog   = console.log.bind(console);
let _origWarn  = console.warn.bind(console);
let _origError = console.error.bind(console);

export function setOriginalConsole(
  log: (...args: any[]) => void,
  warn: (...args: any[]) => void,
  error: (...args: any[]) => void
): void {
  _origLog   = log;
  _origWarn  = warn;
  _origError = error;
}

// ─── Read recent logs for observability endpoint ──────────────────────────────

export function readRecentLines(filePath: string, count = 100): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-count);
  } catch {
    return [];
  }
}

export function getDailyLogDir(): string {
  return ensureLogsDir();
}

export function getTodayLogPath(): string {
  return getDailyLogPath();
}
