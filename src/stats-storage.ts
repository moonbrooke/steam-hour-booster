import { z } from "zod";
import { convertRelativePath } from "./path";

const accountStatsSchema = z.object({
	totalPlayedMs: z.number().nonnegative().default(0),
	sessions: z.number().int().nonnegative().default(0),
	lastPlayedAt: z.number().nullable().default(null),
});

export type AccountStats = z.infer<typeof accountStatsSchema>;

const statsFileSchema = z.record(accountStatsSchema);

const EMPTY: AccountStats = {
	totalPlayedMs: 0,
	sessions: 0,
	lastPlayedAt: null,
};

export const emptyStats = (): AccountStats => ({ ...EMPTY });

export class StatsStorage {
	readonly #path: string;
	readonly #data = new Map<string, AccountStats>();
	#writeTimer: ReturnType<typeof setTimeout> | null = null;
	#pending: Promise<void> = Promise.resolve();
	#writeDelayMs: number;

	constructor(
		directory: string,
		{ writeDelayMs = 10_000 }: { writeDelayMs?: number } = {},
	) {
		this.#path = convertRelativePath(`${directory}/stats.json`);
		this.#writeDelayMs = writeDelayMs;
	}

	get(username: string): AccountStats {
		return this.#data.get(username.toLowerCase()) ?? emptyStats();
	}

	async load(): Promise<void> {
		const file = Bun.file(this.#path);

		if (!(await file.exists())) {
			return;
		}

		try {
			const parsed = statsFileSchema.safeParse(await file.json());

			if (parsed.success) {
				for (const [username, stats] of Object.entries(parsed.data)) {
					this.#data.set(username.toLowerCase(), { ...EMPTY, ...stats });
				}
			}
		} catch {
			// A corrupt stats file must never stop the booster from running.
		}
	}

	record(username: string, playedMs: number): void {
		if (!Number.isFinite(playedMs) || playedMs <= 0) {
			return;
		}

		const key = username.toLowerCase();
		const current = this.#data.get(key) ?? emptyStats();

		this.#data.set(key, {
			totalPlayedMs: current.totalPlayedMs + playedMs,
			sessions: current.sessions + 1,
			lastPlayedAt: Date.now(),
		});

		this.#scheduleWrite();
	}

	#scheduleWrite(): void {
		if (this.#writeTimer !== null) {
			clearTimeout(this.#writeTimer);
		}

		this.#writeTimer = setTimeout(() => {
			this.#writeTimer = null;
			this.#pending = this.#pending.then(() => this.#write());
		}, this.#writeDelayMs);

		// Never hold the process open just to persist statistics.
		this.#writeTimer.unref?.();
	}

	/** Writes any pending statistics immediately. */
	async flush(): Promise<void> {
		if (this.#writeTimer !== null) {
			clearTimeout(this.#writeTimer);
			this.#writeTimer = null;
			this.#pending = this.#pending.then(() => this.#write());
		}

		await this.#pending;
	}

	async #write(): Promise<void> {
		const payload: Record<string, AccountStats> = {};

		for (const [username, stats] of this.#data) {
			payload[username] = stats;
		}

		try {
			await Bun.write(this.#path, `${JSON.stringify(payload, null, 2)}\n`, {
				mode: 0o600,
			});
		} catch {
			// Statistics are a nice-to-have; never crash the booster over them.
		}
	}
}
