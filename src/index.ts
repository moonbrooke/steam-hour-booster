import { Bot } from "./bot";
import { loadConfig } from "./config";
import { DefaultTokenStorage } from "./token-storage";
import { startMonitorApi } from "./monitor-api";

console.info("Starting Steam Hour Booster");

const configPath = Bun.env["CONFIG_PATH"] ?? "./config.json";
const tokenStorageDir = Bun.env["TOKEN_STORAGE_DIRECTORY"] ?? "./tokens";
const steamDataDirectory = Bun.env["STEAM_DATA_DIRECTORY"] ?? "./steam-data";

const config = await loadConfig(configPath);
const ts = new DefaultTokenStorage(tokenStorageDir);

const bots: Bot[] = [];

for (const entry of config) {
	const bot = new Bot(
		entry.username,
		entry.password,
		entry.games,
		steamDataDirectory,
		ts,
		entry.online,
	);

	await bot.login();
    bots.push(bot);
}

await startMonitorApi(bots);

// Shutdown
process.on("SIGINT", async () => {
    process.stdout.write("\r\x1b[K");
    
    for (const bot of bots) {
        console.info(`[${bot.username}] Shutting down...`);
        await bot.logout();
        console.info(`[${bot.username}] Logged out successfully.`);
        console.info(`[${bot.username}] Exiting.`);
    }
    
    process.exit(0);
});
