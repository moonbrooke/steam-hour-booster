import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { GameInfo } from "./bot";

let releaseProductInfo: (() => void) | null = null;
let productInfoCalls = 0;

class FakeSteam extends EventEmitter {
	static instances: FakeSteam[] = [];

	static EResult = {
		NoConnection: 3,
		InvalidPassword: 5,
		ServiceUnavailable: 20,
		AccountDisabled: 43,
		AccountLogonDenied: 63,
		ParentalControlRestricted: 69,
		AccountLocked: 73,
		RateLimitExceeded: 84,
	};

	static EPersonaState = { Online: 3 };

	steamID: string | null = null;
	played: (number | string)[] = [];

	constructor(public options: Record<string, unknown>) {
		super();
		FakeSteam.instances.push(this);
	}

	logOn(): void {
		setTimeout(() => {
			this.steamID = "STEAM_0:0:1";
			this.emit("loggedOn", {}, {});
		}, 0);
	}

	logOff(): void {
		// no-op
	}

	gamesPlayed(apps: number | string | Array<number | string>): void {
		this.played = Array.isArray(apps) ? apps : [apps];
	}

	setPersona(): void {
		// no-op
	}

	getProductInfo(): Promise<{
		apps: Record<number, unknown>;
		packages: Record<number, unknown>;
	}> {
		productInfoCalls++;

		return new Promise((resolve) => {
			releaseProductInfo = () => {
				resolve({
					apps: {
						730: { appinfo: { common: { name: "Counter-Strike 2" } } },
						570: { appinfo: { common: { name: "Dota 2" } } },
					},
					packages: {},
				});
			};
		});
	}
}

mock.module("steam-user", () => ({
	default: FakeSteam,
	EConnectionProtocol: { WebSocket: 2 },
}));

const { Bot, formatGameList } = await import("./bot");

const steam = (): FakeSteam => {
	const instance = FakeSteam.instances.at(-1);

	if (instance === undefined) {
		throw new Error("No Steam instance was created.");
	}

	return instance;
};

const makeBot = (): InstanceType<typeof Bot> => {
	const previous = process.env["LOG_LEVEL"];
	process.env["LOG_LEVEL"] = "debug";

	try {
		return new Bot({
			username: "racer",
			password: "pw",
			games: [730, 570],
			dataDirectory: "./steam-data",
			tokenStorage: null,
			online: false,
			stats: null,
			keepAliveMs: 0,
			uptimeLogIntervalMs: 60_000,
		});
	} finally {
		process.env["LOG_LEVEL"] = previous;
	}
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const capture = async (
	run: (peek: () => string) => Promise<void>,
): Promise<string> => {
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);

	let output = "";

	const swallow = ((chunk: unknown) => {
		output += String(chunk);
		return true;
	}) as typeof process.stdout.write;

	process.stdout.write = swallow;
	process.stderr.write = swallow;

	try {
		await run(() => output);
		// Let any deferred logging callbacks run.
		await sleep(5);
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	}

	return output;
};

beforeEach(() => {
	FakeSteam.instances = [];
	releaseProductInfo = null;
	productInfoCalls = 0;
});

const game = (appid: number, name: string): GameInfo => ({ appid, name });

describe("formatGameList", () => {
	test("joins resolved game names", () => {
		expect(
			formatGameList(
				[game(730, "Counter-Strike 2"), game(570, "Dota 2")],
				[730, 570],
			),
		).toBe("Counter-Strike 2, Dota 2");
	});

	test("falls back to raw app IDs when no names are resolved yet", () => {
		expect(formatGameList([], [730, 570])).toBe("730, 570");
	});

	test("renders a single entry without a separator", () => {
		expect(formatGameList([game(730, "Counter-Strike 2")], [730])).toBe(
			"Counter-Strike 2",
		);
		expect(formatGameList([], [730])).toBe("730");
	});

	test("renders placeholder names for unresolved app IDs", () => {
		expect(formatGameList([game(730, "Unknown (730)")], [730])).toBe(
			"Unknown (730)",
		);
	});

	test("preserves the configured order", () => {
		const games = [game(3, "Third"), game(1, "First"), game(2, "Second")];

		expect(formatGameList(games, [3, 1, 2])).toBe("Third, First, Second");
	});

	test("returns an empty string when nothing is configured", () => {
		expect(formatGameList([], [])).toBe("");
	});

	test("prefers names over IDs when both are present", () => {
		expect(formatGameList([game(730, "Counter-Strike 2")], [730, 570])).toBe(
			"Counter-Strike 2",
		);
	});
});

describe("Bot game name reporting", () => {
	test("logs resolved names, not app IDs, on a cold start", async () => {
		const output = await capture(async () => {
			const bot = makeBot();
			const login = bot.login();

			await sleep(5);
			// Steam reports an idle playing state right after logon.
			steam().emit("playingState", false, 0);

			await login;
			releaseProductInfo?.();
			await sleep(10);

			bot.shutdown("test");
		});

		expect(output).toContain("Playing 2 game(s).");
		expect(output).toContain("Games: Counter-Strike 2, Dota 2");
		expect(output).not.toContain("Games: 730, 570");
	});

	test("waits for the lookup instead of printing bare IDs", async () => {
		await capture(async (peek) => {
			const bot = makeBot();
			const login = bot.login();

			await sleep(5);
			steam().emit("playingState", false, 0);
			await login;

			expect(productInfoCalls).toBe(1);
			expect(releaseProductInfo).not.toBeNull();

			expect(peek()).not.toContain("Games:");
			expect(peek()).toContain("Playing 2 game(s).");

			releaseProductInfo?.();
			await sleep(10);

			expect(peek()).toContain("Games: Counter-Strike 2, Dota 2");

			bot.shutdown("test");
		});
	});

	test("re-asserts the play state without waiting for names", async () => {
		let playedWhilePending: (number | string)[] = [];

		await capture(async () => {
			const bot = makeBot();
			const login = bot.login();

			await sleep(5);
			steam().emit("playingState", false, 0);
			await login;

			playedWhilePending = [...steam().played];

			releaseProductInfo?.();
			await sleep(10);

			bot.shutdown("test");
		});

		expect(playedWhilePending).toEqual([730, 570]);
	});

	test("ignores a duplicate idle playingState event", async () => {
		await capture(async (peek) => {
			const bot = makeBot();
			const login = bot.login();

			await sleep(5);
			steam().emit("playingState", false, 0);
			steam().emit("playingState", false, 0);

			await login;
			releaseProductInfo?.();
			await sleep(10);

			const listLines = peek()
				.split("\n")
				.filter((line) => line.includes("Games:"));

			expect(listLines).toHaveLength(1);
			expect(listLines[0]).toContain("Counter-Strike 2");

			bot.shutdown("test");
		});
	});

	test("caches names, so a later transition logs them inline", async () => {
		await capture(async (peek) => {
			const bot = makeBot();
			await bot.login();
			await sleep(5);
			steam().emit("playingState", false, 0);

			releaseProductInfo?.();
			await sleep(10);
			expect(peek()).toContain("Games: Counter-Strike 2, Dota 2");

			// Block, then unblock. The resume path has names available, so the
			// game list is written synchronously.
			steam().emit("playingState", true, 0);
			await sleep(5);
			peek();
			steam().emit("playingState", false, 0);
			await sleep(5);

			bot.shutdown("test");
		});

		// Names are resolved once per bot, not once per transition.
		expect(productInfoCalls).toBe(1);
	});
});
