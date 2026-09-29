export const readInt = (
	value: string | undefined,
	fallback: number,
): number => {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}

	const parsed = Number(value);

	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		console.error(
			`Expected a non-negative integer, got "${value}". Using ${fallback}.`,
		);
		return fallback;
	}

	return parsed;
};

/** Same as {@link readInt} but rejects `0`, for values like ports. */
export const readPositiveInt = (
	value: string | undefined,
	fallback: number,
): number => {
	const parsed = readInt(value, fallback);
	return parsed > 0 ? parsed : fallback;
};

/** Interprets common truthy spellings, so `0`/`false`/`no` all mean "off". */
export const readBool = (
	value: string | undefined,
	fallback: boolean,
): boolean => {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			console.error(`Expected a boolean, got "${value}". Using ${fallback}.`);
			return fallback;
	}
};
