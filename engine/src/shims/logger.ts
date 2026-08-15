// vscode output channel yerine RPC event akışı.
// stdout NDJSON protokolüne ayrıldığı için hiçbir log oraya yazılmaz.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical';

type Sink = (level: LogLevel, args: any[]) => void;

let sink: Sink = (level, args) => {
  process.stderr.write(`[${level}] ${args.map(fmt).join(' ')}\n`);
};

function fmt(v: any): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function setLogSink(next: Sink) {
  sink = next;
}

export function formatArgs(args: any[]): string {
  return args.map(fmt).join(' ');
}

const logger = {
  trace: (...args: any[]) => sink('trace', args),
  debug: (...args: any[]) => sink('debug', args),
  info: (...args: any[]) => sink('info', args),
  warn: (...args: any[]) => sink('warn', args),
  error: (...args: any[]) => sink('error', args),
  critical: (...args: any[]) => sink('critical', args),
};

export default logger;
