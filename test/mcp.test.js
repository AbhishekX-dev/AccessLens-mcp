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
  assert.ok(list.some((tool) => tool.name === "crawl_accessibility_review"));
  assert.ok(list.some((tool) => tool.name === "run_accessibility_review"));
  assert.ok(list.some((tool) => tool.name === "analyze_accessibility_evidence"));
  assert.ok(list.some((tool) => tool.name === "get_review_report"));
  assert.ok(list.some((tool) => tool.name === "record_human_review"));
  assert.ok(list.some((tool) => tool.name === "verify_fix"));
});

test("one-call review returns an explicit human-review report", async () => {
  const child = spawn(process.execPath, ["src/server.js"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.trim().split("\n").filter(Boolean).map(JSON.parse)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_accessibility_review", arguments: { session_id: "review-test", url_or_html: "<html lang='en'><head><title>Review</title></head><body><main><h1>Review</h1><button aria-label='Save'>Save</button></main></body></html>" } } })}\n`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP review did not respond")), 15_000);
    const tick = setInterval(() => { if (lines.some((line) => line.id === 2)) { clearTimeout(timer); clearInterval(tick); resolve(); } }, 20);
  });
  child.kill();
  const response = lines.find((line) => line.id === 2);
  assert.equal(response.error, undefined);
  const report = JSON.parse(response.result.content[0].text);
  assert.equal(report.policy.includes("Human approval"), true);
  assert.equal(report.engine_summary[0].engine, "axe-core");
  assert.ok(report.advisory_checks.control_names);
});
