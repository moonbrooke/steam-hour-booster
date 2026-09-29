import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultTokenStorage } from "./token-storage";

const cleanups: string[] = [];

const makeStorage = async (): Promise<DefaultTokenStorage> => {
	const dir = await mkdtemp(join(tmpdir(), "shb-token-"));
	cleanups.push(dir);
	return new DefaultTokenStorage(dir);
};

afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("DefaultTokenStorage", () => {
	test("returns null for a missing token", async () => {
		const storage = await makeStorage();
		expect(await storage.getToken("nobody")).toBeNull();
	});

	test("round-trips a token", async () => {
		const storage = await makeStorage();

		await storage.setToken("user", "token-abc");

		expect(await storage.getToken("user")).toBe("token-abc");
	});

	test("overwrites an existing token", async () => {
		const storage = await makeStorage();

		await storage.setToken("user", "first");
		await storage.setToken("user", "second");

		expect(await storage.getToken("user")).toBe("second");
	});

	test("treats an empty file as no token", async () => {
		const dir = await mkdtemp(join(tmpdir(), "shb-empty-"));
		cleanups.push(dir);

		await Bun.write(join(dir, "user"), "   \n");

		expect(await new DefaultTokenStorage(dir).getToken("user")).toBeNull();
	});

	test("creates nested directories that do not exist yet", async () => {
		const root = await mkdtemp(join(tmpdir(), "shb-nested-"));
		cleanups.push(root);

		const storage = new DefaultTokenStorage(join(root, "a", "b", "c"));

		await storage.setToken("user", "deep");

		expect(await storage.getToken("user")).toBe("deep");
	});

	test("deletes a token", async () => {
		const storage = await makeStorage();

		await storage.setToken("user", "token");
		await storage.deleteToken("user");

		expect(await storage.getToken("user")).toBeNull();
	});

	test("rejects when deleting a missing token", async () => {
		const storage = await makeStorage();
		expect(storage.deleteToken("ghost")).rejects.toThrow();
	});

	test("confines a traversal key to the storage directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "shb-escape-"));
		cleanups.push(root);

		const dir = join(root, "tokens");
		const outside = join(root, "outside.txt");
		await Bun.write(outside, "secret");

		const storage = new DefaultTokenStorage(dir);

		// A key that resolves to a file outside the storage directory must be
		// neutralised rather than read or overwritten.
		for (const key of ["../outside", "..", ".", "../../outside"]) {
			expect(await storage.getToken(key)).toBeNull();
		}

		await storage.setToken("../outside", "overwritten");

		expect(await Bun.file(outside).text()).toBe("secret");
	});
});
