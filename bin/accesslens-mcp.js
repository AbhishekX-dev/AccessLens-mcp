#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--install-browser")) {
  const { chromium } = await import("playwright");
  const browserPath = chromium.executablePath();
  const playwrightCli = fileURLToPath(new URL("../node_modules/playwright/cli.js", import.meta.url));
  const command = spawn(process.execPath, [playwrightCli, "install", "chromium"], { stdio: "inherit" });
  command.on("error", (error) => { console.error(`Could not install Chromium (expected path: ${browserPath}): ${error.message}`); process.exitCode = 1; });
  command.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  await import("../src/server.js");
}
