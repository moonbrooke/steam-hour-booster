import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsStorage } from "./stats-storage";

const cleanups: string[] = [];

const makeStorage = async (
	options: { writeDelayMs?: number } = {},
): Promise<{ stats: StatsStorage; dir: string }> => {
	const dir = await mkdtemp(join(tmpdir(), "shb-stats-"));
	cleanups.push(dir);
	return { stats: new StatsStorage(dir, options), dir };
};

afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("StatsStorage", () => {
	test("returns zeroes for an unknown account", async () => {
		const { stats } = await makeStorage();

		expect(stats.get("nobody")).toEqual({
			totalPlayedMs: 0,
			sessions: 0,
			lastPlayedAt: null,
		});
	});

	test("accumulates across multiple records", async () => {
		const { stats } = await makeStorage();

		stats.record("user", 1000);
		stats.record("user", 2000);

		expect(stats.get("user").totalPlayedMs).toBe(3000);
		expect(stats.get("user").sessions).toBe(2);
	});

	test("is case-insensitive on the username", async () => {
		const { stats } = await makeStorage();

		stats.record("User", 1000);
		stats.record("USER", 500);

		expect(stats.get("user").totalPlayedMs).toBe(1500);
	});

	test("ignores non-positive and non-finite durations", async () => {
		const { stats } = await makeStorage();

		stats.record("user", 0);
		stats.record("user", -100);
		stats.record("user", Number.NaN);

		expect(stats.get("user").totalPlayedMs).toBe(0);
		expect(stats.get("user").sessions).toBe(0);
	});

	test("persists across instances", async () => {
		const { stats, dir } = await makeStorage({ writeDelayMs: 0 });

		stats.record("user", 5_000);
		await stats.flush();

		const reloaded = new StatsStorage(dir);
		await reloaded.load();

		expect(reloaded.get("user").totalPlayedMs).toBe(5000);
		expect(reloaded.get("user").sessions).toBe(1);
	});

	test("debounces writes until flush", async () => {
		const { stats, dir } = await makeStorage({ writeDelayMs: 60_000 });

		stats.record("user", 1_000);

		// Nothing is on disk yet, but a flush must capture the pending value.
		await stats.flush();

		expect(await Bun.file(join(dir, "stats.json")).exists()).toBe(true);
	});

	test("tolerates a missing stats file", async () => {
		const { stats } = await makeStorage();
		await expect(stats.load()).resolves.toBeUndefined();
	});

	test("tolerates a corrupt stats file", async () => {
		const { dir } = await makeStorage();
		await Bun.write(join(dir, "stats.json"), "{ not json");

		const stats = new StatsStorage(dir);

		await expect(stats.load()).resolves.toBeUndefined();
		expect(stats.get("user").totalPlayedMs).toBe(0);
	});

	test("ignores malformed entries in the stats file", async () => {
		const { dir } = await makeStorage();
		await Bun.write(
			join(dir, "stats.json"),
			JSON.stringify({
				good: { totalPlayedMs: 10, sessions: 1, lastPlayedAt: null },
				bad: { totalPlayedMs: "nope" },
			}),
		);

		const stats = new StatsStorage(dir);
		await stats.load();

		// The whole record is dropped rather than partially trusted.
		expect(stats.get("good").totalPlayedMs).toBe(0);
	});
});
