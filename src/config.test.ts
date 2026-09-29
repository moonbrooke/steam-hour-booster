import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, configSchema, loadConfig } from "./config";

const cleanups: string[] = [];

const writeConfig = async (contents: unknown): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "shb-config-"));
	cleanups.push(dir);

	const path = join(dir, "config.json");
	await Bun.write(
		path,
		typeof contents === "string" ? contents : JSON.stringify(contents),
	);

	return path;
};

afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("configSchema", () => {
	test("accepts a minimal entry and defaults online to false", () => {
		const result = configSchema.safeParse([
			{ username: "User_1", password: "pw", games: [730] },
		]);

		expect(result.success).toBe(true);

		if (result.success) {
			expect(result.data[0]?.online).toBe(false);
		}
	});

	test("preserves an explicit online flag", () => {
		const result = configSchema.safeParse([
			{ username: "u", password: "pw", games: [730], online: true },
		]);

		expect(result.success).toBe(true);
	});

	test("requires at least one game", () => {
		expect(
			configSchema.safeParse([{ username: "u", password: "pw", games: [] }])
				.success,
		).toBe(false);
	});

	test("enforces the 32 game Steam limit", () => {
		const many = Array.from({ length: 33 }, (_, i) => i + 1);

		expect(
			configSchema.safeParse([{ username: "u", password: "pw", games: many }])
				.success,
		).toBe(false);

		const exact = Array.from({ length: 32 }, (_, i) => i + 1);

		expect(
			configSchema.safeParse([{ username: "u", password: "pw", games: exact }])
				.success,
		).toBe(true);
	});

	test("rejects non-integer, zero and negative game IDs", () => {
		for (const games of [[0], [-1], [1.5], ["730" as unknown as number]]) {
			expect(
				configSchema.safeParse([{ username: "u", password: "pw", games }])
					.success,
			).toBe(false);
		}
	});

	test("rejects an empty username or password", () => {
		expect(
			configSchema.safeParse([{ username: "", password: "pw", games: [1] }])
				.success,
		).toBe(false);
		expect(
			configSchema.safeParse([{ username: "u", password: "", games: [1] }])
				.success,
		).toBe(false);
	});

	test("rejects usernames with unsupported characters", () => {
		for (const username of [
			"user name",
			"user/name",
			"user:name",
			"user\\name",
			"../etc",
		]) {
			expect(
				configSchema.safeParse([{ username, password: "pw", games: [1] }])
					.success,
			).toBe(false);
		}
	});

	test("rejects usernames that start with a dot", () => {
		for (const username of [".", "..", "...", ".hidden"]) {
			expect(
				configSchema.safeParse([{ username, password: "pw", games: [1] }])
					.success,
			).toBe(false);
		}
	});

	test("accepts the supported username characters", () => {
		for (const username of ["a", "Some_User.1@x", "a-b", "a_b"]) {
			expect(
				configSchema.safeParse([{ username, password: "pw", games: [1] }])
					.success,
			).toBe(true);
		}
	});

	test("rejects unknown keys so typos surface", () => {
		expect(
			configSchema.safeParse([
				{ username: "u", password: "pw", games: [1], onlien: true },
			]).success,
		).toBe(false);
	});

	test("rejects a non-array config", () => {
		expect(configSchema.safeParse({ username: "u" }).success).toBe(false);
	});
});

describe("loadConfig", () => {
	test("loads and parses a valid config", async () => {
		const path = await writeConfig([
			{ username: "Foo", password: "pw", games: [730, 570] },
		]);

		const config = await loadConfig(path);

		expect(config).toHaveLength(1);
		expect(config[0]?.username).toBe("Foo");
		expect(config[0]?.games).toEqual([730, 570]);
	});

	test("reports a missing file with a helpful message", async () => {
		const dir = await mkdtemp(join(tmpdir(), "shb-config-"));
		cleanups.push(dir);

		const path = join(dir, "nope.json");

		const error = await loadConfig(path).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("not found");
	});

	test("reports invalid JSON", async () => {
		const path = await writeConfig("{ not json");

		const error = await loadConfig(path).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("not valid JSON");
	});

	test("reports schema violations as a list of issues", async () => {
		const path = await writeConfig([
			{ username: "", password: "pw", games: [] },
		]);

		const error = await loadConfig(path).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).issues.length).toBeGreaterThan(0);
		expect((error as ConfigError).issues[0]).toContain("[0.username]");
	});

	test("rejects duplicate accounts regardless of case", async () => {
		const path = await writeConfig([
			{ username: "User", password: "pw", games: [1] },
			{ username: "user", password: "pw2", games: [2] },
		]);

		const error = await loadConfig(path).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).issues[0]).toContain("Duplicate");
	});

	test("accepts an empty account list", async () => {
		const path = await writeConfig([]);
		expect(await loadConfig(path)).toEqual([]);
	});
});
