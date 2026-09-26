import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("MCP stdio server advertises the evidence-fusion tools", async () => {
  const child = spawn(process.execPath, ["src/server.js"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.trim().split("\n").filter(Boolean).map(JSON.parse)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP server did not respond")), 5_000);
    const tick = setInterval(() => { if (lines.some((line) => line.id === 2)) { clearTimeout(timer); clearInterval(tick); resolve(); } }, 20);
  });
  child.kill();
  const list = lines.find((line) => line.id === 2).result.tools;
  assert.ok(list.some((tool) => tool.name === "analyze_accessibility_evidence"));
  assert.ok(list.some((tool) => tool.name === "get_review_report"));
  assert.ok(list.some((tool) => tool.name === "record_human_review"));
  assert.ok(list.some((tool) => tool.name === "verify_fix"));
});
