import { z } from "zod";
import { convertRelativePath } from "./path";

/** Steam allows at most 32 concurrent "in game" sessions per account. */
export const MAX_GAMES_PER_ACCOUNT = 32;

export const configSchema = z.array(
	z
		.object({
			username: z
				.string()
				.min(1, "Username must not be empty.")
				.regex(
					/^[a-zA-Z0-9_.@-]+$/,
					"Username may only contain letters, digits and _ . @ -",
				)
				.refine(
					(name) => !/^\.+$/.test(name) && !name.startsWith("."),
					"Username must not start with a dot.",
				),
			password: z.string().min(1, "Password must not be empty."),
			games: z
				.array(z.number().int().positive("Game IDs must be positive integers."))
				.min(1, "At least one game is required.")
				.max(
					MAX_GAMES_PER_ACCOUNT,
					`Steam allows at most ${MAX_GAMES_PER_ACCOUNT} games at a time.`,
				),
			online: z.boolean().default(false),
		})
		.strict("Unknown keys are not allowed; check for typos."),
);

export type ConfigEntry = z.infer<typeof configSchema>[number];
export type Config = z.infer<typeof configSchema>;

/** Thrown when the config file is unreadable or fails validation. */
export class ConfigError extends Error {
	readonly path: string;
	readonly issues: readonly string[];

	constructor(message: string, path: string, issues: readonly string[] = []) {
		super(message);
		this.name = "ConfigError";
		this.path = path;
		this.issues = issues;
	}
}

const formatIssues = (error: z.ZodError): string[] =>
	error.issues.map((issue) => {
		const location = issue.path.join(".");
		return location === "" ? issue.message : `[${location}] ${issue.message}`;
	});

/**
 * Loads and validates the account config.
 *
 * @throws {ConfigError} If the file is missing, not valid JSON, or fails schema validation.
 */
export const loadConfig = async (path: string): Promise<Config> => {
	const resolvedPath = convertRelativePath(path);

	const file = Bun.file(resolvedPath);

	if (!(await file.exists())) {
		throw new ConfigError(
			`Config file not found at ${resolvedPath}. Copy config-example.json to config.json and fill it in.`,
			resolvedPath,
		);
	}

	let json: unknown;

	try {
		json = await file.json();
	} catch (error) {
		throw new ConfigError(
			`Config file at ${resolvedPath} is not valid JSON.`,
			resolvedPath,
			[error instanceof Error ? error.message : String(error)],
		);
	}

	const result = await configSchema.safeParseAsync(json);

	if (!result.success) {
		throw new ConfigError(
			`Config file at ${resolvedPath} is invalid.`,
			resolvedPath,
			formatIssues(result.error),
		);
	}

	const seen = new Set<string>();

	for (const entry of result.data) {
		const key = entry.username.toLowerCase();

		if (seen.has(key)) {
			throw new ConfigError(
				`Config file at ${resolvedPath} is invalid.`,
				resolvedPath,
				[`Duplicate account "${entry.username}".`],
			);
		}

		seen.add(key);
	}

	return result.data;
};
