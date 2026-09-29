import { describe, expect, test } from "bun:test";
import { formatClock, formatDuration } from "./duration";

describe("formatDuration", () => {
	test("omits leading zero-valued units", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(5_000)).toBe("5s");
		expect(formatDuration(65_000)).toBe("1m 5s");
	});

	test("includes hours only when non-zero", () => {
		expect(formatDuration(3_600_000)).toBe("1h 0s");
		expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
		expect(formatDuration(86_400_000)).toBe("24h 0s");
	});

	test("truncates partial seconds", () => {
		expect(formatDuration(1999)).toBe("1s");
		expect(formatDuration(59_999)).toBe("59s");
	});

	test("clamps negative and non-finite input", () => {
		expect(formatDuration(-5000)).toBe("0s");
		expect(formatDuration(Number.NaN)).toBe("0s");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
	});
});

describe("formatClock", () => {
	test("zero-pads every unit", () => {
		expect(formatClock(0)).toBe("00:00:00");
		expect(formatClock(1_000)).toBe("00:00:01");
		expect(formatClock(61_000)).toBe("00:01:01");
		expect(formatClock(3_661_000)).toBe("01:01:01");
		expect(formatClock(360_000_000)).toBe("100:00:00");
	});

	test("clamps invalid input", () => {
		expect(formatClock(-1)).toBe("00:00:00");
		expect(formatClock(Number.NaN)).toBe("00:00:00");
	});
});
