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
	keepAliveMinutes: 15,
	uptimeLogMinutes: 5,
} as const;

const configPath = Bun.env["CONFIG_PATH"] ?? DEFAULTS.configPath;
const tokenStorageDir =
	Bun.env["TOKEN_STORAGE_DIRECTORY"] ?? DEFAULTS.tokenStorageDir;
const steamDataDirectory =
	Bun.env["STEAM_DATA_DIRECTORY"] ?? DEFAULTS.steamDataDirectory;
const monitorEnabled = readBool(Bun.env["MONITOR_ENABLED"], true);

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

		bots.push(bot);

		try {
			await bot.login();
		} catch (error) {
			const reason =
				error instanceof Error
					? (error.message.split("\n")[0] ?? error.name)
					: String(error);

			log.error(`[${entry.username}] Login failed: ${reason}`);

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
