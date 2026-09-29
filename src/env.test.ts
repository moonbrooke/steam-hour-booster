import { afterEach, describe, expect, test } from "bun:test";
import { readBool, readInt, readPositiveInt } from "./env";

const original = { ...Bun.env };

afterEach(() => {
	for (const key of Object.keys(Bun.env)) {
		if (!(key in original)) {
			Bun.env[key] = undefined as unknown as string;
		}
	}
});

describe("readInt", () => {
	test("parses valid integers", () => {
		expect(readInt("10", 1)).toBe(10);
		expect(readInt(" 42 ", 1)).toBe(42);
		expect(readInt("0", 1)).toBe(0);
	});

	test("falls back when unset or blank", () => {
		expect(readInt(undefined, 7)).toBe(7);
		expect(readInt("", 7)).toBe(7);
		expect(readInt("   ", 7)).toBe(7);
	});

	test("falls back on malformed values", () => {
		expect(readInt("abc", 7)).toBe(7);
		expect(readInt("1.5", 7)).toBe(7);
		expect(readInt("-3", 7)).toBe(7);
		expect(readInt("NaN", 7)).toBe(7);
	});
});

describe("readPositiveInt", () => {
	test("rejects zero and falls back", () => {
		expect(readPositiveInt("0", 5)).toBe(5);
	});

	test("accepts positive values", () => {
		expect(readPositiveInt("8080", 5)).toBe(8080);
	});
});

describe("readBool", () => {
	test("accepts common truthy spellings", () => {
		for (const value of ["1", "true", "TRUE", "yes", "on"]) {
			expect(readBool(value, false)).toBe(true);
		}
	});

	test("accepts common falsy spellings", () => {
		for (const value of ["0", "false", "FALSE", "no", "off"]) {
			expect(readBool(value, true)).toBe(false);
		}
	});

	test("falls back when unset or unrecognised", () => {
		expect(readBool(undefined, true)).toBe(true);
		expect(readBool("", false)).toBe(false);
		expect(readBool("maybe", true)).toBe(true);
	});
});
