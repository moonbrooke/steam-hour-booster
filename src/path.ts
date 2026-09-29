import { isAbsolute, join, resolve } from "node:path";

/**
 * Directory of the current module, used as the anchor for relative paths.
 * `src/` lives next to `package.json`, so the app root is one level up.
 */
const appRoot = resolve(import.meta.dir, "..");

/**
 * Converts a relative path to an absolute path.
 *
 * Relative paths are resolved against the root directory of the app (where
 * `package.json` lives) rather than the current working directory, so the app
 * behaves identically no matter where it is launched from.
 *
 * @param path - Relative path. Relative to the root directory of the app.
 * @throws {Error} If the app root can not be resolved.
 */
export const convertRelativePath = (path: string): string => {
	if (isAbsolute(path)) {
		return path;
	}

	if (!appRoot) {
		throw new Error("Can not find root directory of the app.");
	}

	return resolve(join(appRoot, path));
};

/**
 * Reduces an arbitrary string to a single safe path segment.
 *
 * The result never equals `.` or `..`, so it can not be used to traverse out of
 * the directory it is joined to, and never contains a path separator.
 */
export const safePathSegment = (value: string): string => {
	const cleaned = value.replace(/[^a-zA-Z0-9_.@-]/g, "_");

	// A name made only of dots is a relative path reference, not a filename.
	return cleaned === "" || /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
};

/**
 * Resolves a per-account subdirectory of a shared directory, e.g.
 * `./steam-data` + `myaccount` -> `<appRoot>/steam-data/myaccount`.
 *
 * Each Steam client instance keeps connection state on disk, so accounts must
 * not share the same `dataDirectory`.
 */
export const accountDataDirectory = (
	directory: string,
	account: string,
): string => {
	return convertRelativePath(join(directory, safePathSegment(account)));
};
