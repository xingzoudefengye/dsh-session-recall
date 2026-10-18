#!/usr/bin/env node
/**
 * Verify one profile's session-recall wiring, cross-platform.
 *
 * This is the Node port of `scripts/check.sh` and keeps its checks and output
 * shape (`ok:` / `FAIL:` / `note:`):
 *   1. the bounded chronicle's two rows are present in the composed tree;
 *   2. if the upstream read tools are mounted, both packages are installed at
 *      exactly the harness's own version.
 *
 * It runs `dsh --profile <profile> --dump-config` through the platform's own
 * launcher, so on Windows the `dsh.cmd` shim works without bash.
 *
 * Usage: node scripts/check.mjs [profile]   (default: web)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findHarnessVersion, packageVersion, profilePaths, runCommand } from "./lib/harness.mjs";

const profile = process.argv[2] ?? "web";
const { profilesDir, profileDir } = profilePaths(profile);

if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
	console.error(`FAIL: no such profile: ${profileDir}`);
	process.exit(1);
}

let status = 0;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-session-recall-"));
const dumpFile = path.join(directory, "dump-config.yml");

try {
	const dump = runCommand("dsh", ["--profile", profile, "--dump-config"]);
	if (dump.error !== undefined) throw new Error(`cannot run dsh: ${dump.error.message}`);
	if (dump.status !== 0) {
		if (typeof dump.stderr === "string" && dump.stderr.length > 0) process.stderr.write(dump.stderr);
		throw new Error(`dsh --profile ${profile} --dump-config exited with ${dump.status ?? "no status"}`);
	}
	fs.writeFileSync(dumpFile, dump.stdout ?? "", "utf8");
	const tree = fs.readFileSync(dumpFile, "utf8");

	for (const row of ["session-chronicle", "tool-session-chronicle"]) {
		if (tree.includes(`id: ${row}`)) {
			console.log(`ok:   ${row} is in the composed tree`);
		} else {
			console.log(
				`FAIL: ${row} is missing — install this bundle: dsh plugin --profile ${profile} add github:xingzoudefengye/dsh-session-recall`
			);
			status = 1;
		}
	}

	if (tree.includes("optional-tool-session-query")) {
		const version = findHarnessVersion({ profileDir, profilesDir });
		if (version === undefined) {
			console.log("FAIL: upstream read tools are mounted, but the harness version cannot be determined");
			status = 1;
		} else {
			console.log(`ok:   upstream read tools are mounted (harness ${version})`);
			for (const name of ["dsh-tool-session-query", "dsh-session-query-sqlite"]) {
				const manifests = [
					path.join(profileDir, "node_modules", "@deepseek-ai", name, "package.json"),
					path.join(profilesDir, "node_modules", "@deepseek-ai", name, "package.json")
				];
				const manifest = manifests.find((file) => fs.existsSync(file));
				if (manifest === undefined) {
					console.log(`FAIL: @deepseek-ai/${name} is not installed in this profile`);
					status = 1;
					continue;
				}
				const installed = packageVersion(manifest);
				if (installed === version) {
					console.log(`ok:   @deepseek-ai/${name}@${installed} matches the harness`);
				} else {
					console.log(
						`FAIL: @deepseek-ai/${name}@${installed ?? "unknown"} does not match the harness (${version}) — re-run scripts/enable-read-tools.mjs ${profile}`
					);
					status = 1;
				}
			}
		}
	} else {
		console.log(`note: upstream read tools are not mounted (run scripts/enable-read-tools.mjs ${profile} to add them)`);
	}
} catch (error) {
	if (error instanceof Error) console.error(`FAIL: ${error.message}`);
	else console.error(`FAIL: ${String(error)}`);
	status = 1;
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}

process.exit(status);
