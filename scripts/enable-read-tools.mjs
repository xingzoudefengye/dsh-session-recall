#!/usr/bin/env node
/**
 * Turn on DeepSeek Harness's own workspace-authorized session history tools
 * (`session_search`, `session_event_search`, `session_trace`,
 * `session_event_trace`, `session_event_read`) for one profile.
 *
 * This is the cross-platform Node port of `scripts/enable-read-tools.sh`. The
 * upstream tools ship with the harness but are left out of the composed profile:
 * they are upstream's opt-in feature and cost fixed guidance plus five tool
 * schemas on every model request. The script installs them at *your* harness
 * version and mounts them in an isolated group, mirroring upstream's own
 * `dsh-experimental-session-search` bundle patch.
 *
 * Usage: node scripts/enable-read-tools.mjs [profile]   (default: web)
 */
import fs from "node:fs";
import path from "node:path";
import { findHarnessVersion, profilePaths, runCommand } from "./lib/harness.mjs";

const profile = process.argv[2] ?? "web";
const { profilesDir, profileDir } = profilePaths(profile);

if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
	console.error(`no such profile: ${profileDir}`);
	process.exit(1);
}

const version = findHarnessVersion({ profileDir, profilesDir });
if (version === undefined) {
	console.error(`cannot find the harness runtime (@deepseek-ai/dsh-base) for profile: ${profileDir}`);
	process.exit(1);
}
console.log(`harness runtime version: ${version}`);

console.log("installing the two upstream packages at that exact version ...");
const install = runCommand(
	"pnpm",
	["add", `@deepseek-ai/dsh-tool-session-query@${version}`, `@deepseek-ai/dsh-session-query-sqlite@${version}`],
	{ cwd: profileDir, stdio: "inherit" }
);
if (install.error !== undefined) {
	console.error(`cannot run pnpm: ${install.error.message}`);
	process.exit(1);
}
if (install.status !== 0) {
	console.error(`pnpm add failed with exit code ${install.status ?? "unknown"}`);
	process.exit(install.status ?? 1);
}

const patch = path.join(profileDir, "cordis.patch.yml");
if (!fs.existsSync(patch)) fs.writeFileSync(patch, "[]\n", "utf8");

if (fs.readFileSync(patch, "utf8").includes("optional-tool-session-query")) {
	console.log(`read tools are already mounted in ${patch} — nothing to do`);
	process.exit(0);
}

const pad = (value) => String(value).padStart(2, "0");
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
fs.copyFileSync(patch, `${patch}.bak-${stamp}`);

const block = `
# --- dsh-session-recall: upstream workspace-authorized session history tools ---
# Mounted in an isolated group, so this deployment's own sessionQuery row keeps
# its configuration; the group opens its own in-memory index on first search.
- insert:
    - id: optional-session-search
      name: cordis:group
      group: true
      isolate:
        sessionQuery: true
      config:
        - id: optional-session-query-sqlite
          name: '@deepseek-ai/dsh-session-query-sqlite'
          config:
            path: ':memory:'
            openAt: first-search
        - id: optional-tool-session-query
          name: '@deepseek-ai/dsh-tool-session-query'
`;

// The patch file is one top-level YAML sequence. A file holding only comments
// and an empty `[]` must have that marker removed, because appending after it
// would produce a second root node that cannot parse.
const original = fs.readFileSync(patch, "utf8");
const body = original
	.split("\n")
	.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
	.join("\n")
	.trim();
const next =
	body === "" || body === "[]"
		? `${original
				.split("\n")
				.filter((line) => line.trim() === "" || line.trim().startsWith("#"))
				.join("\n")
				.trimEnd()}\n${block}`
		: `${original.trimEnd()}\n${block}`;
fs.writeFileSync(patch, next, "utf8");

console.log(`mounted the read tools in ${patch}`);
console.log("restart the profile's app for the change to take effect.");
