export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const FALLBACK_LEVEL: LogLevel = "info";

export const resolveLogLevel = (value: string | undefined): LogLevel => {
	const normalized = value?.trim().toLowerCase();

	if (
		normalized !== undefined &&
		(LOG_LEVELS as readonly string[]).includes(normalized)
	) {
		return normalized as LogLevel;
	}

	if (normalized !== undefined && normalized !== "") {
		console.error(
			`Unknown LOG_LEVEL "${value}", falling back to "${FALLBACK_LEVEL}".`,
		);
	}

	return FALLBACK_LEVEL;
};

export const detectColorSupport = (): boolean => {
	if (Bun.env["NO_COLOR"] !== undefined && Bun.env["NO_COLOR"] !== "") {
		return false;
	}

	if (Bun.env["TERM"] === "dumb") {
		return false;
	}

	return Boolean(process.stdout.isTTY);
};

export type AnsiColor =
	| "red"
	| "green"
	| "yellow"
	| "blue"
	| "magenta"
	| "gray"
	| "bold";

const CODES: Record<AnsiColor, number> = {
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	gray: 90,
	bold: 1,
};

const ESC = String.fromCharCode(27);

const stripAnsiPattern = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const CLEAR_LINE = `\r${ESC}[K`;

export const stripAnsi = (text: string): string =>
	text.replace(stripAnsiPattern, "");

export const applyColor = (
	color: AnsiColor,
	text: string,
	enabled: boolean,
): string => (enabled ? `${ESC}[${CODES[color]}m${text}${ESC}[0m` : text);

export interface LoggerOptions {
	scope?: string;
	color?: boolean;
	interactive?: boolean;
	level?: LogLevel;
}

export class Logger {
	readonly #scope: string | undefined;
	readonly #color: boolean;
	readonly #interactive: boolean;
	readonly #weight: number;
	#liveLine: string | null = null;

	constructor(options: LoggerOptions = {}) {
		this.#scope = options.scope;
		this.#color = options.color ?? detectColorSupport();
		this.#interactive = options.interactive ?? Boolean(process.stdout.isTTY);
		this.#weight =
			LEVEL_WEIGHT[options.level ?? resolveLogLevel(Bun.env["LOG_LEVEL"])];
	}

	get interactive(): boolean {
		return this.#interactive;
	}

	color(text: string, color: AnsiColor): string {
		return applyColor(color, text, this.#color);
	}

	child(scope: string): Logger {
		return new Logger({
			scope,
			color: this.#color,
			interactive: this.#interactive,
			level: levelForWeight(this.#weight),
		});
	}

	debug(message: string, error?: unknown): void {
		this.#write("debug", message, error);
	}

	info(message: string, error?: unknown): void {
		this.#write("info", message, error);
	}

	warn(message: string, error?: unknown): void {
		this.#write("warn", message, error);
	}

	error(message: string, error?: unknown): void {
		this.#write("error", message, error);
	}

	setLiveLine(message: string | null): void {
		if (!this.#interactive) {
			return;
		}

		if (message === null) {
			this.#clearLiveLine();
			return;
		}

		const line = this.#decorate(message);
		process.stdout.write(`${CLEAR_LINE}${line}`);
		this.#liveLine = line;
	}

	#clearLiveLine(): void {
		if (this.#liveLine !== null) {
			process.stdout.write(CLEAR_LINE);
			this.#liveLine = null;
		}
	}

	#decorate(message: string): string {
		return this.#scope === undefined
			? message
			: `${this.color(this.#scope, "magenta")} ${message}`;
	}

	#write(level: LogLevel, message: string, error?: unknown): void {
		if (LEVEL_WEIGHT[level] < this.#weight) {
			return;
		}

		this.#clearLiveLine();

		const detail =
			error === undefined
				? ""
				: ` ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;

		const line = this.#decorate(`${message}${detail}`);
		const stream =
			level === "error" || level === "warn" ? process.stderr : process.stdout;

		stream.write(`${line}\n`);
	}
}

const levelForWeight = (weight: number): LogLevel => {
	const match = LOG_LEVELS.find((level) => LEVEL_WEIGHT[level] === weight);
	return match ?? FALLBACK_LEVEL;
};
