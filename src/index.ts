import { Bot } from "./bot";
import { ConfigError, loadConfig } from "./config";
import { readBool, readInt } from "./env";
import { Logger } from "./logger";
import { resolveMonitorOptions, startMonitorApi } from "./monitor-api";
import { registerShutdownHandlers, shutdown } from "./shutdown";
import { StatsStorage } from "./stats-storage";
import { DefaultTokenStorage } from "./token-storage";

const log = new Logger();

const DEFAULTS = {
	configPath: "./config.json",
	tokenStorageDir: "./tokens",
	steamDataDirectory: "./steam-data",
	/** Re-assert the playing state this often to survive silent Steam drops. */
	keepAliveMinutes: 15,
	/** How often to print an uptime line when stdout is not a terminal. */
	uptimeLogMinutes: 5,
} as const;

const configPath = Bun.env["CONFIG_PATH"] ?? DEFAULTS.configPath;
const tokenStorageDir =
	Bun.env["TOKEN_STORAGE_DIRECTORY"] ?? DEFAULTS.tokenStorageDir;
const steamDataDirectory =
	Bun.env["STEAM_DATA_DIRECTORY"] ?? DEFAULTS.steamDataDirectory;
const monitorEnabled = readBool(Bun.env["MONITOR_ENABLED"], true);

/** Interval env vars are expressed in minutes for readability. */
const minutesToMs = (
	value: string | undefined,
	fallbackMinutes: number,
): number => readInt(value, fallbackMinutes) * 60_000;

const main = async (): Promise<void> => {
	log.info("Starting Steam Hour Booster");

	const config = await loadConfig(configPath);

	if (config.length === 0) {
		log.warn(`No accounts configured in ${configPath}.`);
		log.warn("The monitor API will still start so health checks succeed.");
	}

	const tokenStorage = new DefaultTokenStorage(tokenStorageDir);
	const stats = new StatsStorage(tokenStorageDir);
	await stats.load();

	const bots: Bot[] = [];

	registerShutdownHandlers(bots, stats);

	// Start the monitor before logging in so health checks answer during a slow
	// startup, and so it keeps serving even if every account fails below.
	if (monitorEnabled) {
		startMonitorApi(bots, resolveMonitorOptions());
	}

	for (const entry of config) {
		const bot = new Bot({
			username: entry.username,
			password: entry.password,
			games: entry.games,
			dataDirectory: steamDataDirectory,
			tokenStorage,
			online: entry.online,
			stats,
			keepAliveMs: minutesToMs(
				Bun.env["PLAY_KEEPALIVE"],
				DEFAULTS.keepAliveMinutes,
			),
			uptimeLogIntervalMs: minutesToMs(
				Bun.env["UPTIME_LOG_INTERVAL"],
				DEFAULTS.uptimeLogMinutes,
			),
		});

		// Register before awaiting so a mid-startup signal still logs out the
		// accounts that are already connected.
		bots.push(bot);

		try {
			await bot.login();
		} catch (error) {
			// Only keep the first line of steam-user's error.
			// Set STEAM_DEBUG=1 for the full protocol trace.
			const reason =
				error instanceof Error
					? (error.message.split("\n")[0] ?? error.name)
					: String(error);

			log.error(`[${entry.username}] Login failed: ${reason}`);

			// Take the already connected accounts down cleanly instead of
			// dropping them by exiting mid-session.
			await shutdown(bots, stats, 1, "login failed");
		}
	}

	log.info(`Ready. ${bots.length} account(s) connected.`);
};

try {
	await main();
} catch (error) {
	if (error instanceof ConfigError) {
		log.error(error.message);

		for (const issue of error.issues) {
			log.error(`  - ${issue}`);
		}
	} else {
		log.error("Fatal error:", error);
	}

	process.exit(1);
}
