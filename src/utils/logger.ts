import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
	debug: '\x1b[90m',
	info: '\x1b[36m',
	warn: '\x1b[33m',
	error: '\x1b[31m',
};
const RESET = '\x1b[0m';

const SERVICE_NAME = 'call-operations';

interface BoundContext {
	callId?: string;
	[key: string]: unknown;
}

export class Logger {
	private level: LogLevel;
	private format: LogFormat;
	private service: string;
	private contextName?: string;
	private boundContext: BoundContext;

	constructor(level: LogLevel = 'info', context?: string, service: string = SERVICE_NAME, format: LogFormat = 'json') {
		this.level = level;
		this.format = format;
		this.service = service;
		this.contextName = context;
		this.boundContext = {};
	}

	static fromEnv(env: Record<string, unknown>, context?: string): Logger {
		const level = parseLogLevel(env.LOG_LEVEL as string | undefined);
		const format = parseLogFormat(env.LOG_FORMAT as string | undefined);
		return new Logger(level, context, SERVICE_NAME, format);
	}

	child(context: string): Logger {
		const child = new Logger(
			this.level,
			this.contextName ? `${this.contextName}:${context}` : context,
			this.service,
			this.format
		);
		child.boundContext = { ...this.boundContext };
		return child;
	}

	withCallContext(ctx: { callId?: string }): Logger {
		const bound = new Logger(this.level, this.contextName, this.service, this.format);
		bound.boundContext = { ...this.boundContext, ...ctx };
		return bound;
	}

	private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
		if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;

		if (this.format === 'pretty') {
			this.writePretty(level, message, data);
		} else {
			this.writeJson(level, message, data);
		}
	}

	private writeJson(level: LogLevel, message: string, data?: Record<string, unknown>): void {
		const entry: Record<string, unknown> = {
			level: level.toUpperCase(),
			service: this.service,
		};

		if (this.boundContext.callId) entry.callId = this.boundContext.callId;
		if (this.contextName) entry.context = this.contextName;
		entry.message = message;

		if (data) {
			for (const [key, value] of Object.entries(data)) {
				if (key !== 'level' && key !== 'service' && key !== 'message' && key !== 'context' && key !== 'timestamp') {
					entry[key] = value;
				}
			}
		}

		entry.timestamp = new Date().toISOString();

		const json = JSON.stringify(entry);
		switch (level) {
			case 'error': console.error(json); break;
			case 'warn': console.warn(json); break;
			default: console.log(json);
		}
	}

	private writePretty(level: LogLevel, message: string, data?: Record<string, unknown>): void {
		const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const color = LEVEL_COLORS[level];
		const lvl = level.toUpperCase().padEnd(5);
		const ctx = this.contextName ? `[${this.contextName}]` : '';
		const callId = this.boundContext.callId ? ` call=${(this.boundContext.callId as string).slice(0, 8)}` : '';

		let kvPairs = '';
		if (data) {
			const parts: string[] = [];
			for (const [key, value] of Object.entries(data)) {
				if (key === 'context') continue;
				const v = typeof value === 'string' ? value : JSON.stringify(value);
				parts.push(`${key}=${v}`);
			}
			if (parts.length > 0) kvPairs = ' ' + parts.join(' ');
		}

		const line = `${color}${time} ${lvl}${RESET} ${ctx}${callId} ${message}${kvPairs}`;
		switch (level) {
			case 'error': console.error(line); break;
			case 'warn': console.warn(line); break;
			default: console.log(line);
		}
	}

	debug(message: string, data?: Record<string, unknown>): void { this.write('debug', message, data); }
	info(message: string, data?: Record<string, unknown>): void { this.write('info', message, data); }
	warn(message: string, data?: Record<string, unknown>): void { this.write('warn', message, data); }
	error(message: string, data?: Record<string, unknown>): void { this.write('error', message, data); }
}

function parseLogLevel(value: string | undefined): LogLevel {
	if (value && value.toLowerCase() in LOG_LEVELS) return value.toLowerCase() as LogLevel;
	return 'info';
}

function parseLogFormat(value: string | undefined): LogFormat {
	if (value === 'pretty') return 'pretty';
	return 'json';
}

const asyncLocalStorage = new AsyncLocalStorage<Logger>();

export function runWithContext<T>(ctxLogger: Logger, fn: () => T): T {
	return asyncLocalStorage.run(ctxLogger, fn);
}

let fallbackLogger = new Logger('info', undefined, SERVICE_NAME);

export function configureDefaultLogger(env: Record<string, unknown>): void {
	fallbackLogger = Logger.fromEnv(env);
}

export const logger: Logger = new Proxy({} as Logger, {
	get(_target, prop, _receiver) {
		const contextLogger = asyncLocalStorage.getStore();
		const target = contextLogger || fallbackLogger;
		const value = (target as any)[prop];
		if (typeof value === 'function') {
			return value.bind(target);
		}
		return value;
	},
});
