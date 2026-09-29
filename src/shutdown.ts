import type { Bot } from "./bot";
import type { StatsStorage } from "./stats-storage";

let inFlight: Promise<never> | null = null;

type Outcome = { ok: true } | { ok: false; reason: "error" | "timeout" };

const TIMED_OUT = Symbol("timed-out");

/**
 * Races `promise` against a timer.
 *
 * The result is discriminated rather than sentinel-value based: a `Promise<void>`
 * resolves to `undefined` on success, which would otherwise be indistinguishable
 * from a timeout.
 */
const withTimeout = async (
	promise: Promise<unknown>,
	ms: number,
	label: string,
): Promise<Outcome> => {
	const { promise: expired, resolve } =
		Promise.withResolvers<typeof TIMED_OUT>();

	const timer = setTimeout(() => resolve(TIMED_OUT), ms);
	timer.unref?.();

	try {
		const result = await Promise.race([promise, expired]);

		return result === TIMED_OUT
			? { ok: false, reason: "timeout" }
			: { ok: true };
	} catch (error) {
		console.error(`${label} failed.`, error);
		return { ok: false, reason: "error" };
	} finally {
		clearTimeout(timer);
	}
};

/** Upper bound on how long a single account may take to log out. */
const PER_BOT_TIMEOUT = 20 * 1000;

/**
 * Logs out every bot, flushes statistics and exits.
 *
 * Safe to call more than once and from multiple signal handlers: only the first
 * call performs the work, later calls await the same shutdown.
 */
export const shutdown = (
	bots: readonly Bot[],
	stats: StatsStorage | null,
	code: number,
	reason: string,
): Promise<never> => {
	if (inFlight !== null) {
		return inFlight;
	}

	inFlight = (async (): Promise<never> => {
		console.info(`Shutting down (${reason})...`);

		for (const bot of bots) {
			bot.shutdown(reason);

			const outcome = await withTimeout(
				bot.logout(),
				PER_BOT_TIMEOUT,
				`[${bot.username}] Logout`,
			);

			const suffix = !outcome.ok
				? outcome.reason === "timeout"
					? " (timed out)"
					: " (failed)"
				: "";

			console.info(`[${bot.username}] Logged off.${suffix}`);
		}

		const flushed = await withTimeout(
			stats?.flush() ?? Promise.resolve(),
			5000,
			"Stats flush",
		);

		if (!flushed.ok) {
			console.info("Statistics were not fully saved.");
		}

		process.exit(code);
	})();

	return inFlight;
};

/** Signals that must trigger a clean shutdown. */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Registers shutdown handlers for every supported signal plus fatal errors.
 *
 * `SIGTERM` matters most: `docker stop` and systemd send it, and without a
 * handler the process dies without logging off of Steam.
 */
export const registerShutdownHandlers = (
	bots: readonly Bot[],
	stats: StatsStorage | null,
): void => {
	for (const signal of SHUTDOWN_SIGNALS) {
		process.on(signal, () => {
			void shutdown(bots, stats, 0, signal);
		});
	}

	process.on("uncaughtException", (error) => {
		console.error("Uncaught exception:", error);
		void shutdown(bots, stats, 1, "uncaughtException");
	});

	process.on("unhandledRejection", (reason) => {
		console.error("Unhandled rejection:", reason);
		void shutdown(bots, stats, 1, "unhandledRejection");
	});
};
