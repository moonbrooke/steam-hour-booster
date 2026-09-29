import { describe, expect, test } from "bun:test";
import {
	Logger,
	applyColor,
	detectColorSupport,
	resolveLogLevel,
	stripAnsi,
} from "./logger";

describe("resolveLogLevel", () => {
	test("accepts the known levels, case-insensitively", () => {
		expect(resolveLogLevel("debug")).toBe("debug");
		expect(resolveLogLevel("INFO")).toBe("info");
		expect(resolveLogLevel(" Warn ")).toBe("warn");
		expect(resolveLogLevel("error")).toBe("error");
	});

	test("falls back to info when unset", () => {
		expect(resolveLogLevel(undefined)).toBe("info");
		expect(resolveLogLevel("")).toBe("info");
	});

	test("falls back to info on an unknown value", () => {
		expect(resolveLogLevel("verbose")).toBe("info");
	});
});

describe("applyColor", () => {
	test("emits an escape sequence when enabled", () => {
		const colored = applyColor("green", "ok", true);

		expect(colored).toContain("ok");
		expect(stripAnsi(colored)).toBe("ok");
	});

	test("returns plain text when disabled", () => {
		expect(applyColor("red", "bad", false)).toBe("bad");
	});

	test("nests and resets correctly", () => {
		const outer = applyColor("bold", applyColor("red", "x", true), true);
		expect(stripAnsi(outer)).toBe("x");
		// The inner reset must not terminate the outer sequence early.
		expect(outer).toContain("1m");
	});
});

describe("stripAnsi", () => {
	test("removes all escape sequences", () => {
		expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain");
	});

	test("leaves plain text untouched", () => {
		expect(stripAnsi("nothing to do")).toBe("nothing to do");
	});
});

describe("Logger", () => {
	const capture = (run: () => void): { stdout: string; stderr: string } => {
		const originalOut = process.stdout.write.bind(process.stdout);
		const originalErr = process.stderr.write.bind(process.stderr);

		let stdout = "";
		let stderr = "";

		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		process.stderr.write = ((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		}) as typeof process.stderr.write;

		try {
			run();
		} finally {
			process.stdout.write = originalOut;
			process.stderr.write = originalErr;
		}

		return { stdout, stderr };
	};

	test("prefixes messages with the scope", () => {
		const logger = new Logger({ scope: "user", color: false, level: "info" });
		const { stdout } = capture(() => logger.info("hello"));

		expect(stdout).toBe("user hello\n");
	});

	test("omits the prefix when unscoped", () => {
		const logger = new Logger({ color: false, level: "info" });
		const { stdout } = capture(() => logger.info("hello"));

		expect(stdout).toBe("hello\n");
	});

	test("writes no ANSI escapes when color is disabled", () => {
		const logger = new Logger({ scope: "u", color: false, level: "info" });
		const { stdout } = capture(() => logger.info("plain"));

		expect(stdout).not.toContain("\u001b[");
	});

	test("filters messages below the configured level", () => {
		const logger = new Logger({ color: false, level: "warn" });

		const { stdout, stderr } = capture(() => {
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			logger.error("e");
		});

		expect(stdout).toBe("");
		expect(stderr).toBe("w\ne\n");
	});

	test("sends errors to stderr and everything else to stdout", () => {
		const logger = new Logger({ color: false, level: "info" });

		const { stdout, stderr } = capture(() => {
			logger.info("i");
			logger.error("e");
		});

		expect(stdout).toBe("i\n");
		expect(stderr).toBe("e\n");
	});

	test("appends the error message when provided", () => {
		const logger = new Logger({ color: false, level: "error" });
		const { stderr } = capture(() => logger.error("failed", new Error("boom")));

		expect(stderr).toContain("failed");
		expect(stderr).toContain("boom");
	});

	test("child loggers inherit settings and add a scope", () => {
		const parent = new Logger({ color: false, level: "error" });
		const child = parent.child("kid");

		const { stderr } = capture(() => child.error("oops"));

		expect(stderr).toBe("kid oops\n");
		// A debug message must still be filtered out by the inherited level.
		expect(capture(() => child.debug("d")).stderr).toBe("");
	});

	test("drops the live line when not interactive", () => {
		const logger = new Logger({
			color: false,
			interactive: false,
			level: "info",
		});

		expect(capture(() => logger.setLiveLine("tick")).stdout).toBe("");
	});

	test("repaints and clears the live line when interactive", () => {
		const logger = new Logger({
			color: false,
			interactive: true,
			level: "info",
		});

		const { stdout } = capture(() => {
			logger.setLiveLine("tick 1");
			logger.setLiveLine("tick 2");
			logger.setLiveLine(null);
		});

		expect(stdout).toContain("tick 1");
		expect(stdout).toContain("tick 2");
		// The final null must emit a clear sequence.
		expect(stdout.trimEnd().endsWith("[K")).toBe(true);
	});

	test("clears the live line before writing a regular line", () => {
		const logger = new Logger({
			color: false,
			interactive: true,
			level: "info",
		});

		const { stdout } = capture(() => {
			logger.setLiveLine("tick");
			logger.info("real message");
		});

		const lines = stdout.split("\n");
		expect(lines.some((l) => l.endsWith("[Kreal message"))).toBe(true);
	});
});

describe("detectColorSupport", () => {
	test("honors NO_COLOR", () => {
		const previous = Bun.env["NO_COLOR"];
		Bun.env["NO_COLOR"] = "1";

		expect(detectColorSupport()).toBe(false);

		if (previous === undefined) {
			Bun.env["NO_COLOR"] = undefined as unknown as string;
		} else {
			Bun.env["NO_COLOR"] = previous;
		}
	});

	test("honors TERM=dumb", () => {
		const previousNoColor = Bun.env["NO_COLOR"];
		const previousTerm = Bun.env["TERM"];

		Bun.env["NO_COLOR"] = undefined as unknown as string;
		Bun.env["TERM"] = "dumb";

		expect(detectColorSupport()).toBe(false);

		Bun.env["NO_COLOR"] = previousNoColor as string;
		Bun.env["TERM"] = previousTerm as string;
	});
});
