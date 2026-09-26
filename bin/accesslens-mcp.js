#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

if (process.argv.includes("--install-browser")) {
  const { chromium } = await import("playwright");
  const browserPath = chromium.executablePath();
  // npm may hoist Playwright above this package directory. Node's resolver
  // follows that dependency graph correctly; a hard-coded node_modules path
  // does not.
  const playwrightCli = join(dirname(require.resolve("playwright")), "cli.js");
  const command = spawn(process.execPath, [playwrightCli, "install", "chromium"], { stdio: "inherit" });
  command.on("error", (error) => { console.error(`Could not install Chromium (expected path: ${browserPath}): ${error.message}`); process.exitCode = 1; });
  command.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  await import("../src/server.js");
}
