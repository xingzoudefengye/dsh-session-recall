/**
 * Shared plumbing for this package's cross-platform scripts.
 *
 * The `.sh` siblings assume a POSIX host: `dsh` is an executable on PATH,
 * `mktemp`/`cp`/`ln` exist, and bash's quoting rules apply. Windows offers none
 * of that — `dsh` is a `dsh.cmd` shim that CreateProcess will not start
 * directly — so the `.mjs` ports go through this module instead.
 *
 * Nothing here depends on anything outside Node's standard library.
 *
 * @module dsh-session-recall/scripts/lib/harness
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** True on Windows, where commands are batch shims rather than executables. */
const WINDOWS = process.platform === "win32";

/**
 * Resolve a profile's directories the way the `.sh` scripts do:
 * `$DSH_HOME/profiles/<profile>`, with `$DSH_HOME` defaulting to `~/.dsh`.
 *
 * @param profile - profile name (the `--profile` value).
 * @returns the profile name and the three directories derived from it.
 */
export function profilePaths(profile = "web") {
	const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	const profilesDir = path.join(dshHome, "profiles");
	return { profile, dshHome, profilesDir, profileDir: path.join(profilesDir, profile) };
}

/**
 * Read one JSON file, tolerating a UTF-8 BOM.
 * @param file - path to the JSON file.
 * @returns the parsed value, or `undefined` when the file cannot be read or parsed.
 */
export function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
	} catch {
		return undefined;
	}
}

/**
 * Read a package manifest's `version`.
 * @param file - path to a `package.json`.
 * @returns the version string, or `undefined` when unavailable.
 */
export function packageVersion(file) {
	const manifest = readJson(file);
	return typeof manifest?.version === "string" && manifest.version.length > 0 ? manifest.version : undefined;
}

/**
 * Find an executable on PATH without spawning a shell.
 *
 * On Windows the PATHEXT extensions are tried first; the extensionless npm shim
 * is deliberately skipped, because `cmd.exe` cannot execute the bash script npm
 * writes there.
 *
 * @param name - command name without extension, such as `dsh` or `pnpm`.
 * @returns the absolute path, or `undefined` when the command is not on PATH.
 */
export function findCommand(name) {
	const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	if (!WINDOWS) {
		for (const dir of dirs) {
			const candidate = path.join(dir, name);
			try {
				if (!fs.statSync(candidate).isFile()) continue;
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// Not here; keep looking.
			}
		}
		return undefined;
	}
	const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	for (const dir of dirs) {
		for (const extension of extensions) {
			const candidate = path.join(dir, `${name}${extension}`);
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// Not here; keep looking.
			}
		}
	}
	return undefined;
}

/**
 * Quote one argument so `cmd.exe` receives it as a single literal token.
 *
 * Inside double quotes cmd treats `&`, `|`, `<`, `>` and `^` literally; embedded
 * double quotes are doubled, which is cmd's own escape.
 *
 * @param value - the argument to quote.
 * @returns the argument, quoted only when it needs to be.
 */
function quoteForCmd(value) {
	const text = String(value);
	if (/^[A-Za-z0-9_./:=@+-]+$/u.test(text)) return text;
	return `"${text.replace(/"/gu, '""')}"`;
}

/**
 * Run a command with arguments, cross-platform.
 *
 * On Windows the command is started through `cmd.exe /d /s /c` with
 * `windowsVerbatimArguments`, because `spawnSync('dsh', …)` is ENOENT and
 * `spawnSync('dsh.cmd', …)` is EINVAL there. The whole command line is wrapped
 * in one extra pair of quotes, which is what `/s /c` strips so a quoted
 * executable path (including one with spaces) is still a single token.
 *
 * @param name - command name, or an absolute path.
 * @param args - argument list.
 * @param options - `cwd`, `env`, `stdio`, and `maxBuffer` passthroughs.
 * @returns the `spawnSync` result; `error` is set when the command cannot start.
 */
export function runCommand(name, args, options = {}) {
	const { cwd, env, stdio, maxBuffer = 64 * 1024 * 1024 } = options;
	const base = { cwd, env, windowsHide: true };
	if (stdio === undefined) base.encoding = "utf8";
	else base.stdio = stdio;

	if (!WINDOWS) return spawnSync(name, args, { ...base, maxBuffer });

	const shim = findCommand(name) ?? (path.isAbsolute(name) ? name : undefined);
	if (shim === undefined) {
		const error = new Error(`cannot find '${name}' on PATH`);
		error.code = "ENOENT";
		return { error, status: null, stdout: "", stderr: "" };
	}
	const line = [shim, ...args].map(quoteForCmd).join(" ");
	const command = process.env.ComSpec || "cmd.exe";
	return spawnSync(command, ["/d", "/s", "/c", `"${line}"`], {
		...base,
		maxBuffer,
		windowsVerbatimArguments: true
	});
}

/**
 * Determine the harness version for one profile.
 *
 * Lookup order:
 * 1. `<profile>/node_modules/@deepseek-ai/dsh-base/package.json`;
 * 2. `<profiles>/node_modules/@deepseek-ai/dsh-base/package.json` (what the
 *    `.sh` scripts read);
 * 3. the version reported by the `dsh` CLI itself (`dsh --version`), which is
 *    installed alongside `@deepseek-ai/dsh-base`. This keeps the scripts useful
 *    on machines where the harness is a global CLI and no `dsh-base` manifest
 *    sits under the profiles directory.
 *
 * @param options - `profileDir` and `profilesDir`.
 * @returns the version string, or `undefined` when none can be found.
 */
export function findHarnessVersion({ profileDir, profilesDir }) {
	const manifests = [
		path.join(profileDir, "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
		path.join(profilesDir, "node_modules", "@deepseek-ai", "dsh-base", "package.json")
	];
	for (const manifest of manifests) {
		const version = packageVersion(manifest);
		if (version !== undefined) return version;
	}
	const result = runCommand("dsh", ["--version"]);
	if (result.error === undefined && result.status === 0 && typeof result.stdout === "string") {
		const version = result.stdout.trim().replace(/^v/u, "");
		if (version.length > 0) return version;
	}
	return undefined;
}

/**
 * Candidate directories holding `@deepseek-ai/cordis` and
 * `@deepseek-ai/dsh-tools`, derived from the installed `dsh` command.
 *
 * Mirrors `scripts/dev-link.sh`: a POSIX `dsh` resolves to
 * `<…>/@deepseek-ai/dsh/lib/bin.js`, so the packages are either inside that
 * package's own `node_modules` or next to the package. A Windows `dsh.cmd` sits
 * in npm's global bin directory, so the package root is
 * `<bin>/node_modules/@deepseek-ai/dsh`.
 *
 * @param dshPath - the path returned by {@link findCommand}.
 * @returns candidate directories, best first.
 */
export function packageDirCandidates(dshPath) {
	const candidates = [];
	let resolved;
	try {
		resolved = fs.realpathSync(dshPath);
	} catch {
		resolved = dshPath;
	}
	const shimDir = path.dirname(resolved);
	const packageRoot =
		path.basename(resolved) === "bin.js" ? path.dirname(path.dirname(resolved)) : path.join(shimDir, "node_modules", "@deepseek-ai", "dsh");
	candidates.push(path.join(packageRoot, "node_modules", "@deepseek-ai"));
	candidates.push(path.dirname(packageRoot));
	candidates.push(path.join(shimDir, "node_modules", "@deepseek-ai"));
	return [...new Set(candidates)];
}
