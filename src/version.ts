/**
 * The package version, read from package.json at runtime.
 *
 * Read rather than hard-coded so `onesilo-buzz --version` cannot drift from
 * what npm and Homebrew think is installed — a version string that lies is
 * worse than none when someone is reporting a bug.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function read(): string {
  // Resolved relative to this module, not the working directory: the CLI is
  // run from anywhere, and cwd would find some other project's package.json.
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ when running from source (tsx), dist/ when built — package.json is
  // one level up from either.
  for (const candidate of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name?.includes("buzz") && parsed.version) return parsed.version;
    } catch {
      /* try the next candidate */
    }
  }
  return "unknown";
}

export const version = read();
