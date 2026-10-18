#!/usr/bin/env node
/**
 * Link the installed DeepSeek Harness packages this bundle imports into this
 * checkout, so a *local-path* install can resolve them.
 *
 * Why this is needed: `dsh plugin add /abs/path` installs a `link:` dependency,
 * and Node's ESM resolver follows that symlink to this repository's real path.
 * Resolution then walks up from here and never reaches the profile's
 * node_modules. A git install has no such problem — pnpm materializes it inside
 * the profile tree, where the harness packages resolve normally — so this is a
 * development convenience, not part of a normal install.
 *
 * Node port of `scripts/dev-link.sh`. On Windows the link is a junction, which
 * needs no administrator rights or Developer Mode.
 *
 * Usage: node scripts/dev-link.mjs [directory containing @deepseek-ai/dsh-*]
 *   DSH_PACKAGE_DIR  same, via environment
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCommand, packageDirCandidates } from "./lib/harness.mjs";

const WINDOWS = process.platform === "win32";
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Does this directory hold both harness packages this bundle imports? */
function hasPackages(directory) {
	for (const name of ["cordis", "dsh-tools"]) {
		try {
			if (!fs.statSync(path.join(directory, name)).isDirectory()) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Replace a previous link (or a stale directory) without following it. */
function removeLink(link) {
	let stat;
	try {
		stat = fs.lstatSync(link);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		try {
			fs.unlinkSync(link);
		} catch {
			// A Windows junction is a directory reparse point, not a file link.
			fs.rmdirSync(link);
		}
		return;
	}
	fs.rmSync(link, { recursive: true, force: true });
}

let packageDir = process.argv[2] ?? process.env.DSH_PACKAGE_DIR ?? "";

if (packageDir === "") {
	const dsh = findCommand("dsh");
	if (dsh === undefined) {
		console.error("dev-link: cannot find 'dsh' on PATH; pass the directory holding @deepseek-ai/dsh-* instead");
		process.exit(1);
	}
	for (const candidate of packageDirCandidates(dsh)) {
		if (hasPackages(candidate)) {
			packageDir = candidate;
			break;
		}
	}
}

if (packageDir === "" || !hasPackages(packageDir)) {
	console.error(`dev-link: no cordis/dsh-tools under '${packageDir === "" ? "<unresolved>" : packageDir}'`);
	process.exit(1);
}

// A junction needs an absolute target, and the `.sh` resolves the directory the
// same way before linking.
packageDir = path.resolve(packageDir);

const root = path.join(here, "node_modules", "@deepseek-ai");
fs.mkdirSync(root, { recursive: true });
for (const name of ["cordis", "dsh-tools"]) {
	const target = path.join(packageDir, name);
	const link = path.join(root, name);
	removeLink(link);
	fs.symlinkSync(target, link, WINDOWS ? "junction" : "dir");
	console.log(`dev-link: linked ${name}`);
}
console.log("dev-link: local-path installs can now resolve the harness packages");
