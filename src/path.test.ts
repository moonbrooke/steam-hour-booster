import { describe, expect, test } from "bun:test";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	accountDataDirectory,
	convertRelativePath,
	safePathSegment,
} from "./path";

describe("convertRelativePath", () => {
	test("leaves absolute paths untouched", () => {
		const absolute = resolve(sep, "etc", "passwd");

		expect(convertRelativePath(absolute)).toBe(absolute);
	});

	test("resolves relative paths to an absolute path", () => {
		const resolved = convertRelativePath("./steam-data");

		expect(isAbsolute(resolved)).toBe(true);
		expect(resolved.endsWith(`${sep}steam-data`)).toBe(true);
	});

	test("resolves against the app root, not the cwd", () => {
		const resolved = convertRelativePath("./steam-data");
		const relativeToCwd = relative(process.cwd(), resolved);

		// The repo root is the app root, so this stays at the top level instead
		// of nesting under the current working directory.
		expect(relativeToCwd).toBe(join("steam-data"));
	});

	test("never leaves a trailing parent reference", () => {
		for (const input of ["./steam-data", "../escape", "a/../../b"]) {
			expect(convertRelativePath(input)).toBe(
				resolve(convertRelativePath("."), input),
			);
		}
	});

	test("is stable across calls", () => {
		expect(convertRelativePath("./x")).toBe(convertRelativePath("./x"));
	});
});

describe("accountDataDirectory", () => {
	test("appends a per-account subdirectory", () => {
		const base = convertRelativePath("./steam-data");

		expect(accountDataDirectory("./steam-data", "myaccount")).toBe(
			join(base, "myaccount"),
		);
	});

	test("gives each account a distinct directory", () => {
		expect(accountDataDirectory("./steam-data", "a")).not.toBe(
			accountDataDirectory("./steam-data", "b"),
		);
	});

	test("stays inside the base directory for a traversal attempt", () => {
		const base = convertRelativePath("./steam-data");

		for (const hostile of [
			"../../etc/passwd",
			"..",
			".",
			"...",
			"/absolute",
			"a/../../b",
		]) {
			const result = accountDataDirectory("./steam-data", hostile);

			// The invariant that matters: the result is always a direct child of
			// the base directory, never a parent, sibling or absolute path.
			expect(dirname(result)).toBe(base);
		}
	});

	test("replaces characters that are unsafe in a filename", () => {
		expect(accountDataDirectory("./steam-data", "user name/../x")).toBe(
			join(convertRelativePath("./steam-data"), "user_name_.._x"),
		);
	});

	test("neutralises dot-only names", () => {
		for (const name of [".", "..", "..."]) {
			expect(safePathSegment(name)).toBe(`_${name}`);
		}

		expect(safePathSegment("")).toBe("_");
	});

	test("keeps ordinary names untouched", () => {
		for (const name of ["user", "Some_User.1", "a-b", "a@b"]) {
			expect(safePathSegment(name)).toBe(name);
		}
	});

	test("accepts an absolute base directory", () => {
		const absolute = resolve(sep, "var", "lib", "steam-hour-booster");

		expect(accountDataDirectory(absolute, "acc")).toBe(join(absolute, "acc"));
	});
});
