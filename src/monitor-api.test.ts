import { afterEach, describe, expect, test } from "bun:test";
import type { Bot, BotSummary } from "./bot";
import {
	type MonitorServer,
	isAuthorized,
	resolveMonitorOptions,
	startMonitorApi,
} from "./monitor-api";

const servers: MonitorServer[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
});

const summary = (overrides: Partial<BotSummary> = {}): BotSummary => ({
	username: "user",
	status: "Playing",
	uptime: "1m 5s",
	uptimeClock: "00:01:05",
	uptimeSeconds: 65,
	totalPlayedMs: 3_600_000,
	totalPlayed: "1h 0s",
	sessions: 2,
	blocked: false,
	online: false,
	games: [{ appid: 730, name: "Counter-Strike 2" }],
	lastError: null,
	...overrides,
});

const fakeBot = (bot: Partial<Bot> & { summary?: BotSummary }): Bot =>
	({
		username: bot.summary?.username ?? "user",
		getSummary: () => {
			if (bot.summary === undefined) {
				throw new Error("summary unavailable");
			}
			return bot.summary;
		},
	}) as unknown as Bot;

/** Port 0 lets the OS pick a free port, so tests never collide. */
const serve = (
	bots: Bot[],
	options: Parameters<typeof startMonitorApi>[1],
): string => {
	const server = startMonitorApi(bots, options);
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
};

const base = { hostname: "127.0.0.1", token: null, pollIntervalMs: 5000 };

describe("resolveMonitorOptions", () => {
	test("defaults to loopback on port 5000", () => {
		const options = resolveMonitorOptions({});

		expect(options.port).toBe(5000);
		expect(options.hostname).toBe("127.0.0.1");
		expect(options.token).toBeNull();
	});

	test("reads overrides from the environment", () => {
		const options = resolveMonitorOptions({
			MONITOR_PORT: "8080",
			MONITOR_HOST: "0.0.0.0",
			MONITOR_TOKEN: "secret",
		});

		expect(options.port).toBe(8080);
		expect(options.hostname).toBe("0.0.0.0");
		expect(options.token).toBe("secret");
	});

	test("rejects a port outside the valid range", () => {
		expect(resolveMonitorOptions({ MONITOR_PORT: "0" }).port).toBe(5000);
		expect(resolveMonitorOptions({ MONITOR_PORT: "-1" }).port).toBe(5000);
		expect(resolveMonitorOptions({ MONITOR_PORT: "70000" }).port).toBe(5000);
		expect(resolveMonitorOptions({ MONITOR_PORT: "abc" }).port).toBe(5000);
	});

	test("treats an empty token as no auth", () => {
		expect(resolveMonitorOptions({ MONITOR_TOKEN: "" }).token).toBeNull();
	});
});

describe("isAuthorized", () => {
	const url = "http://localhost/";
	const parsed = new URL(url);

	test("accepts a bearer header", () => {
		const request = new Request(url, {
			headers: { authorization: "Bearer s3cret" },
		});

		expect(isAuthorized(request, parsed, "s3cret")).toBe(true);
	});

	test("accepts a query parameter", () => {
		const request = new Request(url);
		const withToken = new URL("http://localhost/?token=s3cret");

		expect(isAuthorized(request, withToken, "s3cret")).toBe(true);
	});

	test("rejects wrong, malformed and partial tokens", () => {
		const wrong = new Request(url, {
			headers: { authorization: "Bearer nope" },
		});
		const malformed = new Request(url, {
			headers: { authorization: "s3cret" },
		});
		const partial = new Request(url, {
			headers: { authorization: "Bearer secre" },
		});

		expect(isAuthorized(wrong, parsed, "s3cret")).toBe(false);
		expect(isAuthorized(malformed, parsed, "s3cret")).toBe(false);
		expect(isAuthorized(partial, parsed, "s3cret")).toBe(false);
		expect(isAuthorized(new Request(url), parsed, "s3cret")).toBe(false);
	});
});

describe("monitor api", () => {
	test("serves the dashboard at /", async () => {
		const url = serve([fakeBot({ summary: summary() })], { ...base, port: 0 });

		const response = await fetch(url);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("Steam Hour Booster");
	});

	test("serves /healthz without auth", async () => {
		const url = serve([fakeBot({ summary: summary() })], {
			...base,
			port: 0,
			token: "secret",
		});

		const response = await fetch(`${url}/healthz`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", accounts: 1 });
	});

	test("returns 404 for unknown paths", async () => {
		const url = serve([], { ...base, port: 0 });

		const response = await fetch(`${url}/nope`);

		expect(response.status).toBe(404);
	});

	test("aggregates bots at /api/status", async () => {
		const url = serve(
			[
				fakeBot({ summary: summary({ username: "a" }) }),
				fakeBot({
					summary: summary({ username: "b", status: "Blocked", blocked: true }),
				}),
			],
			{ ...base, port: 0 },
		);

		const body = (await (await fetch(`${url}/api/status`)).json()) as {
			accounts: number;
			playing: number;
			bots: BotSummary[];
		};

		expect(body.accounts).toBe(2);
		expect(body.playing).toBe(1);
		expect(body.bots.map((b) => b.username)).toEqual(["a", "b"]);
		expect(body.bots[0]?.uptimeSeconds).toBe(65);
	});

	test("keeps the legacy array shape at /api/bots", async () => {
		const url = serve([fakeBot({ summary: summary() })], { ...base, port: 0 });

		const body = await (await fetch(`${url}/api/bots`)).json();

		expect(Array.isArray(body)).toBe(true);
	});

	test("isolates a failing account instead of failing the response", async () => {
		const url = serve(
			[fakeBot({ summary: summary({ username: "ok" }) }), fakeBot({})],
			{ ...base, port: 0 },
		);

		const response = await fetch(`${url}/api/status`);
		const body = (await response.json()) as { bots: BotSummary[] };

		expect(response.status).toBe(200);
		expect(body.bots[0]?.username).toBe("ok");
		expect(body.bots[1]?.status).toBe("Error");
		expect(body.bots[1]?.lastError).toContain("summary unavailable");
	});

	test("rejects unauthenticated requests when a token is set", async () => {
		const url = serve([fakeBot({ summary: summary() })], {
			...base,
			port: 0,
			token: "secret",
		});

		expect((await fetch(`${url}/api/status`)).status).toBe(401);
		expect((await fetch(`${url}/`)).status).toBe(401);
	});

	test("accepts a valid bearer token", async () => {
		const url = serve([fakeBot({ summary: summary() })], {
			...base,
			port: 0,
			token: "secret",
		});

		const response = await fetch(`${url}/api/status`, {
			headers: { authorization: "Bearer secret" },
		});

		expect(response.status).toBe(200);
	});

	test("rejects an invalid bearer token", async () => {
		const url = serve([fakeBot({ summary: summary() })], {
			...base,
			port: 0,
			token: "secret",
		});

		const response = await fetch(`${url}/api/status`, {
			headers: { authorization: "Bearer wrong" },
		});

		expect(response.status).toBe(401);
	});
});
