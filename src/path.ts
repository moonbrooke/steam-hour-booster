import { isAbsolute, join, resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");

export const convertRelativePath = (path: string): string => {
	if (isAbsolute(path)) {
		return path;
	}

	if (!appRoot) {
		throw new Error("Can not find root directory of the app.");
	}

	return resolve(join(appRoot, path));
};

export const safePathSegment = (value: string): string => {
	const cleaned = value.replace(/[^a-zA-Z0-9_.@-]/g, "_");

	return cleaned === "" || /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
};

export const accountDataDirectory = (
	directory: string,
	account: string,
): string => {
	return convertRelativePath(join(directory, safePathSegment(account)));
};
