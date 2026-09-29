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
