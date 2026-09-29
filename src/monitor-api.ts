import { timingSafeEqual } from "node:crypto";
import type { Bot, BotSummary } from "./bot";
import { renderDashboard } from "./dashboard";
import { readInt, readPositiveInt } from "./env";
import { Logger } from "./logger";

const log = new Logger({ scope: "monitor" });

const DEFAULT_PORT = 5000;
const MAX_PORT = 65535;
const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Constant-time comparison that tolerates differing lengths. */
const safeEqual = (a: string, b: string): boolean => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);

	if (left.length !== right.length) {
		// Still perform a comparison so the timing does not leak the length.
		timingSafeEqual(left, left);
		return false;
	}

	return timingSafeEqual(left, right);
};

export interface MonitorOptions {
	port: number;
	hostname: string;
	token: string | null;
	pollIntervalMs: number;
}

/** Resolves monitor settings from the environment, with sane defaults. */
export const resolveMonitorOptions = (
	env: Record<string, string | undefined> = Bun.env,
): MonitorOptions => {
	const requested = readPositiveInt(env["MONITOR_PORT"], DEFAULT_PORT);

	let port = requested;

	if (requested > MAX_PORT) {
		log.error(
			`MONITOR_PORT ${requested} is out of range, using ${DEFAULT_PORT}.`,
		);
		port = DEFAULT_PORT;
	}

	const token = env["MONITOR_TOKEN"];

	return {
		port,
		// Loopback by default: the payload contains account usernames, which
		// should not be exposed to the network unless explicitly asked for.
		hostname: env["MONITOR_HOST"] ?? "127.0.0.1",
		token: token === undefined || token === "" ? null : token,
		pollIntervalMs: readInt(
			env["MONITOR_POLL_INTERVAL"],
			DEFAULT_POLL_INTERVAL_MS,
		),
	};
};

const json = (body: unknown, init?: ResponseInit): Response =>
	Response.json(body, {
		...init,
		headers: { "cache-control": "no-store", ...init?.headers },
	});

const text = (body: string, status: number): Response =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		},
	});

/**
 * Per-account status. One failing account must not break the whole payload,
 * so each summary is collected independently.
 */
const collect = (bots: readonly Bot[]): BotSummary[] =>
	bots.map((bot) => {
		try {
			return bot.getSummary();
		} catch (error) {
			return {
				username: bot.username,
				status: "Error" as const,
				uptime: "Not currently playing.",
				uptimeClock: null,
				uptimeSeconds: null,
				totalPlayedMs: 0,
				totalPlayed: "0s",
				sessions: 0,
				blocked: false,
				online: false,
				games: [],
				lastError: error instanceof Error ? error.message : String(error),
			};
		}
	});

export interface MonitorServer {
	port: number;
	hostname: string;
	stop(): void;
}

export const startMonitorApi = (
	bots: readonly Bot[],
	options: MonitorOptions = resolveMonitorOptions(),
): MonitorServer => {
	const { port, hostname, token, pollIntervalMs } = options;
	const dashboard = renderDashboard(pollIntervalMs);

	const server = Bun.serve({
		port,
		hostname,
		fetch(request) {
			const url = new URL(request.url);

			// Health checks are intentionally unauthenticated so orchestrators
			// do not need the token.
			if (url.pathname === "/healthz") {
				return json({ status: "ok", accounts: bots.length });
			}

			if (token !== null && !isAuthorized(request, url, token)) {
				return text("Unauthorized", 401);
			}

			switch (url.pathname) {
				case "/":
					return new Response(dashboard, {
						headers: {
							"content-type": "text/html; charset=utf-8",
							"cache-control": "no-store",
						},
					});

				case "/api/status": {
					const summaries = collect(bots);

					return json({
						generatedAt: new Date().toISOString(),
						accounts: summaries.length,
						playing: summaries.filter((s) => s.status === "Playing").length,
						bots: summaries,
					});
				}

				// Kept for backwards compatibility with the original monitor API.
				case "/api/bots":
					return json(collect(bots));

				default:
					return text("Not Found", 404);
			}
		},
		error(error) {
			log.error("Request failed:", error);
			return text("Internal Server Error", 500);
		},
	});

	log.info(
		`Listening on http://${hostname}:${server.port ?? port}${
			token === null ? "" : " (token required)"
		}`,
	);

	return {
		port: server.port ?? port,
		hostname,
		stop: () => {
			server.stop(true);
		},
	};
};

/** Accepts `Authorization: Bearer <token>` or `?token=<token>`. */
export const isAuthorized = (
	request: Request,
	url: URL,
	token: string,
): boolean => {
	const header = request.headers.get("authorization");

	if (header !== null) {
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());

		if (match?.[1] !== undefined && safeEqual(match[1], token)) {
			return true;
		}
	}

	const queryToken = url.searchParams.get("token");

	return queryToken !== null && safeEqual(queryToken, token);
};
