import fs from "node:fs/promises";
import { join } from "node:path";
import { convertRelativePath, safePathSegment } from "./path";

const TOKEN_FILE_MODE = 0o600;

export interface TokenStorage {
	getToken(key: string): Promise<string | null>;
	setToken(key: string, token: string): Promise<void>;
	deleteToken(key: string): Promise<void>;
}

export class DefaultTokenStorage implements TokenStorage {
	readonly #directory: string;
	#ready: Promise<void> | null = null;

	constructor(directory: string) {
		this.#directory = convertRelativePath(directory);
		this.#ready = fs
			.mkdir(this.#directory, { recursive: true, mode: 0o700 })
			.then(() => undefined);
	}

	#formatPath(key: string): string {
		return join(this.#directory, safePathSegment(key));
	}

	async getToken(key: string): Promise<string | null> {
		await this.#ready;

		const path = this.#formatPath(key);

		try {
			const token = (await Bun.file(path).text()).trim();

			return token === "" ? null : token;
		} catch (err) {
			if (!(err instanceof Error)) {
				throw err;
			}

			if (!("code" in err)) {
				throw err;
			}

			if (err.code === "ENOENT") {
				return null;
			}

			throw err;
		}
	}

	async setToken(key: string, token: string): Promise<void> {
		await this.#ready;

		await Bun.write(this.#formatPath(key), token, { mode: TOKEN_FILE_MODE });
	}

	async deleteToken(key: string): Promise<void> {
		await this.#ready;

		await fs.unlink(this.#formatPath(key));
	}
}
