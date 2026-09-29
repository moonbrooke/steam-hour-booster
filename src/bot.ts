import pRetry, { AbortError } from "p-retry";
import Steam, { EConnectionProtocol } from "steam-user";
import { formatClock, formatDuration } from "./duration";
import { Logger } from "./logger";
import { convertRelativePath } from "./path";
import type { StatsStorage } from "./stats-storage";
import type { TokenStorage } from "./token-storage";

type LoginDetails = Parameters<Steam["logOn"]>[0];
type SteamError = Error & { eresult: Steam.EResult };
type SteamEvents = Steam.Events;

export interface GameInfo {
	appid: number;
	name: string;
}

/**
 * Renders the configured games for display.
 *
 * Falls back to the raw app IDs when no names have been resolved yet, which is
 * the case until the first `getProductInfo` lookup completes.
 */
export const formatGameList = (games: GameInfo[], ids: number[]): string =>
	(games.length > 0 ? games.map((game) => game.name) : ids).join(", ");

export type BotStatus = "Offline" | "Idle" | "Playing" | "Blocked" | "Error";

export interface BotSummary {
	username: string;
	status: BotStatus;
	/** Human readable session uptime, e.g. `1h 5m 3s`. */
	uptime: string;
	/** Session uptime as `HH:MM:SS`, or null when not playing. */
	uptimeClock: string | null;
	/** Session uptime in seconds, or null when not playing. */
	uptimeSeconds: number | null;
	/** Cumulative play time across all runs, in milliseconds. */
	totalPlayedMs: number;
	/** Cumulative play time across all runs, human readable. */
	totalPlayed: string;
	/** Number of play sessions completed since the stats file was created. */
	sessions: number;
	blocked: boolean;
	online: boolean;
	/** Configured games. Empty until the first successful login resolves them. */
	games: GameInfo[];
	/** Last connection or protocol error, if any. */
	lastError: string | null;
}

// Mitigate this issue: https://github.com/DrWarpMan/steam-hour-booster/issues/9
const LOGIN_TIMEOUT = 60 * 1000;

/**
 * `logOff()` only emits `disconnected` when the client is still logged in
 * (see steam-user's `_disconnect`). When it is not, the event never fires, so
 * a timeout is required to keep the reconnect loop from hanging forever.
 */
const LOGOUT_TIMEOUT = 15 * 1000;

const RECONNECT_RETRIES = 10;
const RECONNECT_MIN_TIMEOUT = 10 * 1000;
const RECONNECT_MAX_TIMEOUT = 60 * 1000;

/** How often the uptime counter refreshes on an interactive terminal. */
const LIVE_TICK = 1000;

/** Errors that will never succeed on retry, no matter how long we wait. */
const FATAL_ERESULTS: ReadonlySet<Steam.EResult> = new Set([
	Steam.EResult.InvalidPassword,
	Steam.EResult.AccountLogonDenied,
	Steam.EResult.AccountDisabled,
	Steam.EResult.AccountLocked,
	Steam.EResult.ServiceUnavailable,
	Steam.EResult.RateLimitExceeded,
	Steam.EResult.ParentalControlRestricted,
]);

export interface BotOptions {
	username: string;
	password: string;
	games: number[];
	/** Shared parent directory; each account gets its own subdirectory. */
	dataDirectory: string;
	tokenStorage: TokenStorage | null;
	online: boolean;
	stats: StatsStorage | null;
	/** Re-assert the playing state this often so Steam cannot silently drop it. */
	keepAliveMs: number;
	/** Interval for periodic uptime log lines when stdout is not a terminal. */
	uptimeLogIntervalMs: number;
}

export class Bot {
	readonly #username: string;
	readonly #password: string;
	readonly #games: number[];
	readonly #online: boolean;
	readonly #tokenStorage: TokenStorage | null;
	readonly #stats: StatsStorage | null;
	readonly #keepAliveMs: number;
	readonly #uptimeLogIntervalMs: number;
	readonly #log: Logger;
	readonly #steam: Steam;
	readonly #abort = new AbortController();

	#resolvedGames: GameInfo[] = [];
	#loggedOn = false;
	#shuttingDown = false;
	#blocked = false;
	/** Suppresses the global error handler while `login()` is in flight. */
	#pauseErrors = false;
	/** True while the configured games are reported as playing. */
	#active = false;
	/** Timestamp of the current play session, set on the Idle -> Playing edge. */
	#sessionStartedAt: number | null = null;
	/** Timestamp of the current uninterrupted playing stretch. */
	#playStartedAt: number | null = null;
	/** Set once `gamesPlayed` has been issued for this session. */
	#keepAliveTimer: ReturnType<typeof setInterval> | null = null;
	#tickTimer: ReturnType<typeof setInterval> | null = null;
	#reconnect: Promise<void> | null = null;
	#lastError: string | null = null;
	/**
	 * In-flight game name lookup, started as soon as we are logged on. The first
	 * `playingState` event can arrive before `login()` returns, so anything that
	 * needs names has to await this rather than assume they are ready.
	 */
	#gamesPending: Promise<void> | null = null;
	#gamesLoaded = false;

	get username(): string {
		return this.#username;
	}

	constructor(options: BotOptions) {
		this.#username = options.username.toLowerCase();
		this.#password = options.password;
		this.#games = options.games;
		this.#online = options.online;
		this.#tokenStorage = options.tokenStorage;
		this.#stats = options.stats;
		this.#keepAliveMs = options.keepAliveMs;
		this.#uptimeLogIntervalMs = options.uptimeLogIntervalMs;
		this.#log = new Logger({ scope: this.#username });

		this.#steam = new Steam({
			autoRelogin: false,
			// Every client instance keeps connection state on disk, so accounts
			// must not share a data directory.
			dataDirectory: convertRelativePath(
				`${options.dataDirectory}/${this.#username}`,
			),
			protocol: EConnectionProtocol.WebSocket,
		});

		this.#setup();
	}

	/**
	 * Snapshot of the bot for the monitor API.
	 *
	 * Synchronous by design: game names are resolved once per login and cached,
	 * so serving a request never issues Steam CM traffic of its own.
	 */
	getSummary(): BotSummary {
		const uptimeSeconds =
			this.#sessionStartedAt === null
				? null
				: Math.floor((Date.now() - this.#sessionStartedAt) / 1000);

		const stats = this.#stats?.get(this.#username);

		return {
			username: this.#username,
			status: this.#getStatus(),
			uptime:
				uptimeSeconds === null
					? "Not currently playing."
					: formatDuration(uptimeSeconds * 1000),
			uptimeClock:
				uptimeSeconds === null ? null : formatClock(uptimeSeconds * 1000),
			uptimeSeconds,
			totalPlayedMs: stats?.totalPlayedMs ?? 0,
			totalPlayed: formatDuration(stats?.totalPlayedMs ?? 0),
			sessions: stats?.sessions ?? 0,
			blocked: this.#blocked,
			online: this.#online,
			games: this.#resolvedGames,
			lastError: this.#lastError,
		};
	}

	#setup(): void {
		this.#steam.on("loggedOn", () => {
			this.#loggedOn = true;
			this.#lastError = null;

			// Start resolving names right away. Steam sends `playingState` right
			// after `loggedOn`, and the first play transition needs these.
			this.#gamesPending = this.#resolveGameNames();

			this.#log.info(this.#log.color("Logged in.", "green"));
		});

		this.#steam.on("disconnected", (eresult) => {
			this.#loggedOn = false;

			if (this.#shuttingDown) {
				return;
			}

			if (eresult !== Steam.EResult.NoConnection) {
				this.#log.info(
					this.#log.color(`Disconnected from Steam (${eresult}).`, "yellow"),
				);
			}
		});

		this.#steam.on("error", (err: SteamEvents["error"][0]) => {
			if (err.eresult !== Steam.EResult.NoConnection) {
				this.#log.error(`Error: ${err.message}`);
			}

			// Errors are always logged above, but during login they are handled
			// by login() itself so they don't trigger the reconnect loop.
			if (this.#pauseErrors) {
				return;
			}

			// Never let a rejected promise from the reconnect loop escape: an
			// unhandled rejection would terminate the whole process and take
			// every other bot down with it.
			void this.#handleError(err);
		});

		this.#steam.on("playingState", (blocked, playingApp) => {
			this.#handlePlayingState(blocked, playingApp);
		});

		this.#steam.on("steamGuard", (_domain, callback, lastCodeWrong) => {
			this.#handleSteamGuard(callback, lastCodeWrong);
		});

		this.#steam.on("refreshToken", (refreshToken) => {
			this.#log.info("New refresh token received.");
			this.#tokenStorage
				?.setToken(this.#username, refreshToken)
				.catch((error: unknown) => {
					this.#log.error("Could not persist refresh token.", error);
				});
		});

		if (
			Bun.env["STEAM_DEBUG"] === "1" ||
			Bun.env["STEAM_DEBUG"]?.toLowerCase() === "true"
		) {
			this.#steam.on("debug", (message) => {
				this.#log.setLiveLine(null);
				this.#log.debug(message);
			});
		}
	}

	async login(): Promise<void> {
		this.#log.info("Logging in...");

		const details = await this.#createLoginDetails();

		this.#log.info("Prepared login credentials.");
		this.#log.info("Connecting to Steam...");

		const { promise, resolve, reject } = Promise.withResolvers();

		const loggedOnCallback = () => resolve();
		const errorCallback = (err: unknown) => reject(err);
		const loginTimeout = setTimeout(
			() => reject(new Error("Login timed out.")),
			LOGIN_TIMEOUT,
		);

		const cleanup = () => {
			// Cleanup the callbacks & re-enable global error handling after the
			// promise gets settled.
			clearTimeout(loginTimeout);
			this.#steam.removeListener("loggedOn", loggedOnCallback);
			this.#steam.removeListener("error", errorCallback);
			this.#pauseErrors = false;
		};

		// Temporarily disable global error handling so a login failure is
		// reported through the returned promise instead of the reconnect loop.
		this.#pauseErrors = true;

		this.#steam.once("loggedOn", loggedOnCallback);
		this.#steam.once("error", errorCallback);

		try {
			this.#steam.logOn(details);
			await promise;
		} catch (error) {
			// Make sure we are not left half-connected before the caller retries.
			this.#safeLogOff();
			throw error;
		} finally {
			cleanup();
		}

		if (this.#online) {
			this.#steam.setPersona(Steam.EPersonaState.Online);
		}

		// Game names are resolved by the `loggedOn` handler rather than awaited
		// here, so a login is not serialized behind a Steam round-trip.
	}

	async logout(): Promise<void> {
		this.#stopHeartbeat();

		// `logOff()` only emits `disconnected` while still logged in, so skip
		// waiting entirely when the connection is already gone.
		if (!this.#loggedOn && this.#steam.steamID === null) {
			this.#log.debug("Already logged out.");
			this.#resetPlayState();
			return;
		}

		this.#log.info("Logging out...");
		this.#resetPlayState();

		const { promise, resolve } = Promise.withResolvers();

		const onDisconnected = () => resolve();
		this.#steam.once("disconnected", onDisconnected);

		const timeout = setTimeout(() => {
			this.#log.warn("Timed out waiting for Steam to acknowledge log off.");
			resolve();
		}, LOGOUT_TIMEOUT);

		try {
			this.#steam.logOff();
			await promise;
		} finally {
			clearTimeout(timeout);
			this.#steam.removeListener("disconnected", onDisconnected);
			this.#loggedOn = false;
		}
	}

	/**
	 * Stops the bot. In-flight reconnect attempts are aborted and no new ones
	 * are started.
	 */
	shutdown(reason: string): void {
		this.#shuttingDown = true;
		this.#stopHeartbeat();
		this.#resetPlayState();
		this.#abort.abort(new AbortError(reason));
	}

	/** Logs out and terminates the process exactly once. */
	async stopAndExit(code: number): Promise<never> {
		this.shutdown("Shutting down");
		this.#log.info("Shutting down...");
		await this.logout();
		process.exit(code);
	}

	async #createLoginDetails(): Promise<LoginDetails> {
		const details = {
			renewRefreshTokens: true,
		};

		const token = await this.#tokenStorage?.getToken(this.#username);

		if (token) {
			return {
				refreshToken: token,
				...details,
			};
		}

		return {
			accountName: this.#username,
			password: this.#password,
			...details,
		};
	}

	#handleSteamGuard(
		callback: (code: string) => void,
		lastCodeWrong: boolean,
	): void {
		const attemptsLeft: number = lastCodeWrong ? 2 : 3;

		if (attemptsLeft === 0) {
			console.error(
				`[${this.#username}] Too many invalid Steam Guard codes, exiting.`,
			);
			process.exit(1);
		}

		const promptText = lastCodeWrong
			? `Steam Guard code (${attemptsLeft} attempts left):`
			: "Steam Guard code:";

		const code = prompt(`[${this.#username}] ${promptText}`)?.trim();

		if (!code) {
			// Exit with a failure code: nothing was entered, so nothing works.
			console.error(
				`[${this.#username}] No Steam Guard code provided, exiting.`,
			);
			process.exit(1);
		}

		callback(code);
	}

	/**
	 * Translates a `playingState` event into a play state transition.
	 *
	 * Steam emits this event both in response to our own `gamesPlayed` call and
	 * whenever the remote side changes, so the current state has to be compared
	 * against the previous one to avoid restarting the uptime counter.
	 */
	#handlePlayingState(blocked: boolean, playingApp: number): void {
		const wasBlocked = this.#blocked;
		this.#blocked = blocked;

		// Not blocked and already on a game: our games are playing, nothing to do.
		if (!blocked && playingApp !== 0 && this.#active) {
			return;
		}

		if (blocked) {
			if (this.#active || this.#sessionStartedAt !== null) {
				this.#log.info(
					this.#log.color("Blocked (family sharing / VAC).", "red"),
				);
			}

			this.#stopPlaying();
			return;
		}

		if (wasBlocked) {
			this.#log.info("Unblocked, resuming.");
			this.#resumePlaying();
			return;
		}

		this.#startPlaying();
	}

	#startPlaying(): void {
		// Steam can report a second idle `playingState` while it is still applying
		// our `gamesPlayed` call. Re-entering here would restart the deferred
		// game-list log and re-announce the session.
		if (this.#shuttingDown || this.#active) {
			return;
		}

		this.#steam.gamesPlayed(this.#games);
		this.#active = true;

		const now = Date.now();

		// Only set on the Idle -> Playing edge. Re-asserting the playing state
		// must not reset the session uptime.
		this.#sessionStartedAt ??= now;
		this.#playStartedAt ??= now;

		this.#log.info(`Playing ${this.#games.length} game(s).`);
		this.#log.info(
			`Session started at: ${this.#log.color(
				new Date(this.#sessionStartedAt).toLocaleString(),
				"green",
			)}`,
		);

		// Resolving names costs a round-trip to Steam. Never make the play
		// transition wait for it, or real play time is lost; only the log line
		// is deferred until the lookup lands.
		if (this.#resolvedGames.length > 0) {
			this.#logGames();
		} else {
			void this.#logGamesWhenReady();
		}

		this.#startHeartbeat();
		this.#startKeepAlive();
	}

	/** Logs the configured games, using names when they have been resolved. */
	#logGames(): void {
		this.#log.info(
			`Games: ${this.#log.color(
				formatGameList(this.#resolvedGames, this.#games),
				"blue",
			)}`,
		);
	}

	async #logGamesWhenReady(): Promise<void> {
		try {
			await this.#gamesPending;
		} catch {
			// #resolveGameNames already logs its own failure.
		}

		if (this.#shuttingDown) {
			return;
		}

		this.#logGames();
	}

	/** Stops reporting games without ending the session, used when blocked. */
	#stopPlaying(): void {
		if (!this.#active && this.#playStartedAt === null) {
			return;
		}

		this.#steam.gamesPlayed([]);
		this.#active = false;

		this.#bankPlayTime();
		this.#startHeartbeat();
		this.#clearKeepAlive();
	}

	/** Re-issues `gamesPlayed` after a block is lifted, preserving the session. */
	#resumePlaying(): void {
		if (this.#shuttingDown || this.#active) {
			return;
		}

		if (this.#sessionStartedAt === null) {
			this.#startPlaying();
			return;
		}

		this.#playStartedAt = Date.now();
		this.#steam.gamesPlayed(this.#games);
		this.#active = true;

		this.#log.info(
			`Resumed. ${this.#log.color(this.#sessionUptime(), "green")} farmed.`,
		);
	}

	#startKeepAlive(): void {
		if (this.#keepAliveMs <= 0 || this.#keepAliveTimer !== null) {
			return;
		}

		this.#keepAliveTimer = setInterval(() => {
			if (!this.#active || this.#shuttingDown) {
				return;
			}

			// Re-assert the playing state. Steam occasionally drops a long
			// running session; re-issuing keeps the hours ticking.
			this.#steam.gamesPlayed(this.#games);
		}, this.#keepAliveMs);

		this.#keepAliveTimer.unref?.();
	}

	#clearKeepAlive(): void {
		if (this.#keepAliveTimer !== null) {
			clearInterval(this.#keepAliveTimer);
			this.#keepAliveTimer = null;
		}
	}

	#startHeartbeat(): void {
		if (this.#tickTimer !== null) {
			return;
		}

		// On a terminal the counter is repainted in place every second. In a log
		// pipe that would be a new line per second, so a plain line is printed
		// every `uptimeLogIntervalMs` instead.
		const interactive = this.#log.interactive;
		const period = interactive
			? LIVE_TICK
			: Math.max(this.#uptimeLogIntervalMs, LIVE_TICK);

		let elapsedSinceLog = 0;

		this.#tickTimer = setInterval(() => {
			if (this.#sessionStartedAt === null) {
				this.#log.setLiveLine(null);
				return;
			}

			if (interactive) {
				this.#log.setLiveLine(
					this.#log.color(`Current uptime: ${this.#sessionUptime()}`, "green"),
				);
				return;
			}

			elapsedSinceLog += period;

			if (elapsedSinceLog >= this.#uptimeLogIntervalMs) {
				elapsedSinceLog = 0;
				this.#log.info(
					`Still playing. Uptime: ${this.#sessionUptime()}, total: ${this.#totalPlayed()}.`,
				);
			}
		}, period);

		this.#tickTimer.unref?.();
	}

	#stopHeartbeat(): void {
		if (this.#tickTimer !== null) {
			clearInterval(this.#tickTimer);
			this.#tickTimer = null;
		}

		this.#clearKeepAlive();
		this.#log.setLiveLine(null);
	}

	/**
	 * Accumulates the current playing stretch into the session total and
	 * persists it to the stats file.
	 */
	#bankPlayTime(): void {
		if (this.#playStartedAt === null) {
			return;
		}

		const played = Date.now() - this.#playStartedAt;
		this.#playStartedAt = null;
		this.#stats?.record(this.#username, played);
	}

	/** Ends the play session, logging the final totals. */
	#resetPlayState(): void {
		this.#bankPlayTime();
		this.#active = false;
		this.#blocked = false;

		if (this.#sessionStartedAt !== null) {
			this.#log.info(
				`Stopped playing. Session uptime: ${this.#log.color(
					this.#sessionUptime(),
					"green",
				)}, total: ${this.#totalPlayed()}.`,
			);
		}

		this.#sessionStartedAt = null;
		this.#stopHeartbeat();
	}

	#sessionUptime(): string {
		return this.#sessionStartedAt === null
			? "0s"
			: formatDuration(Date.now() - this.#sessionStartedAt);
	}

	#totalPlayed(): string {
		const stats = this.#stats?.get(this.#username);
		return formatDuration(stats?.totalPlayedMs ?? 0);
	}

	/**
	 * Resolves the configured app IDs to human readable names.
	 *
	 * Runs once per successful login and caches the result, so the monitor API
	 * never generates Steam CM traffic of its own. A failure is non-fatal: the
	 * raw app IDs are reported instead.
	 */
	async #resolveGameNames(): Promise<void> {
		if (this.#games.length === 0 || this.#gamesLoaded) {
			return;
		}

		try {
			const result = await this.#steam.getProductInfo(this.#games, [], true);

			const names = new Map<number, string>();

			for (const [appid, app] of Object.entries(result.apps)) {
				const name = app.appinfo?.common?.name;

				if (typeof name === "string" && name !== "") {
					names.set(Number(appid), name);
				}
			}

			this.#resolvedGames = this.#games.map((appid) => ({
				appid,
				name: names.get(appid) ?? `Unknown (${appid})`,
			}));

			this.#gamesLoaded = true;
		} catch (error) {
			this.#log.warn("Could not resolve game names.", error);
			this.#resolvedGames = this.#games.map((appid) => ({
				appid,
				name: `Unknown (${appid})`,
			}));
		}
	}

	#safeLogOff(): void {
		try {
			this.#steam.logOff();
		} catch (error) {
			this.#log.debug("logOff() failed during cleanup.", error);
		}
	}

	async #handleError(err: SteamError): Promise<void> {
		this.#lastError = err.message;

		// Collapse concurrent errors into a single reconnect attempt. Without
		// this, a burst of errors would stack overlapping logout/login cycles.
		if (this.#reconnect !== null) {
			this.#log.debug("Error while reconnecting, already handling it.");
			return;
		}

		this.#reconnect = this.#reconnectOnce(err).finally(() => {
			this.#reconnect = null;
		});

		await this.#reconnect;
	}

	async #reconnectOnce(err: SteamError): Promise<void> {
		if (err.eresult === Steam.EResult.NoConnection) {
			this.#log.info(
				this.#log.color("Connection lost, reconnecting...", "red"),
			);
		}

		try {
			await this.logout();

			await pRetry(() => this.#reconnectAttempt(err), {
				retries: RECONNECT_RETRIES,
				factor: 2,
				minTimeout: RECONNECT_MIN_TIMEOUT,
				maxTimeout: RECONNECT_MAX_TIMEOUT,
				randomize: true,
				signal: this.#abort.signal,
				// A wrong password or a locked account will never succeed on
				// retry, so fail fast instead of hammering Steam for an hour.
				shouldRetry: (error) => {
					const eresult = (error as Partial<SteamError>).eresult;
					return eresult === undefined || !FATAL_ERESULTS.has(eresult);
				},
				onFailedAttempt: ({ attemptNumber, retriesLeft }) => {
					this.#log.warn(
						`Login attempt ${attemptNumber} failed, ${retriesLeft} left.`,
					);
				},
			});

			this.#log.info(this.#log.color("Re-login successful.", "green"));
		} catch (error) {
			if (this.#shuttingDown || error instanceof AbortError) {
				this.#log.debug("Reconnect aborted.");
				return;
			}

			this.#log.error("Could not re-login.", error);
			this.#log.info(this.#log.color("Giving up on this account.", "red"));
			this.#safeLogOff();
		}
	}

	async #reconnectAttempt(original: SteamError): Promise<void> {
		if (this.#shuttingDown) {
			throw new AbortError("Shutting down");
		}

		try {
			await this.login();
		} catch (error) {
			// Preserve the original connection error when the retry itself does
			// not carry an eresult, so shouldRetry() can still classify it.
			if (
				error instanceof Error &&
				(error as SteamError).eresult === undefined
			) {
				(error as SteamError).eresult = original.eresult;
			}

			throw error;
		}
	}

	#getStatus(): BotStatus {
		if (this.#shuttingDown) {
			return "Offline";
		}

		if (this.#reconnect !== null) {
			return "Error";
		}

		if (!this.#loggedOn) {
			return "Offline";
		}

		if (this.#blocked) {
			return "Blocked";
		}

		if (this.#sessionStartedAt !== null) {
			return "Playing";
		}

		return "Idle";
	}
}
