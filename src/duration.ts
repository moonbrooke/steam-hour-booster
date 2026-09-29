/**
 * Formats a duration in milliseconds as a compact human readable string.
 *
 * Zero-valued leading units are omitted, so 5 seconds renders as `5s` and
 * 65 seconds as `1m 5s`. Seconds are always included so a live counter still
 * moves even before the first minute elapses.
 */
export const formatDuration = (milliseconds: number): string => {
	const safe = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
	const totalSeconds = Math.floor(safe / 1000);

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];

	if (hours > 0) {
		parts.push(`${hours}h`);
	}

	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}

	parts.push(`${seconds}s`);

	return parts.join(" ");
};

/**
 * Formats a duration as `HH:MM:SS`, used by the dashboard where alignment
 * matters more than brevity.
 */
export const formatClock = (milliseconds: number): string => {
	const safe = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
	const totalSeconds = Math.floor(safe / 1000);

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	return [hours, minutes, seconds]
		.map((unit) => unit.toString().padStart(2, "0"))
		.join(":");
};
