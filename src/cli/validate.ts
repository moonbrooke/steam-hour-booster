/**
 * Validates the account config without contacting Steam.
 *
 * Useful in CI or as a pre-flight check before restarting a long running
 * deployment: `bun run validate`.
 */
import { ConfigError, loadConfig } from "../config";

const configPath = process.argv[2] ?? Bun.env["CONFIG_PATH"] ?? "./config.json";

try {
	const config = await loadConfig(configPath);
	const totalGames = config.reduce((sum, entry) => sum + entry.games.length, 0);

	console.info(`Config OK: ${configPath}`);
	console.info(`  accounts: ${config.length}`);
	console.info(`  games:    ${totalGames}`);

	for (const entry of config) {
		console.info(
			`  - ${entry.username.toLowerCase()}: ${entry.games.length} game(s)${
				entry.online ? ", online" : ""
			}`,
		);
	}
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(error.message);

		for (const issue of error.issues) {
			console.error(`  - ${issue}`);
		}
	} else {
		console.error("Config could not be read.", error);
	}

	process.exit(1);
}
