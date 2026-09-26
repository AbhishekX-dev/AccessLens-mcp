#!/usr/bin/env node
import readline from "node:readline";
import { advisory, scan } from "./engine.js";
import { SessionStore } from "./store.js";
import { updateCalibration } from "./fusion.js";

const store = new SessionStore();
const session = (args) => args.session_id || "default";
const targetSchema = { type: "object", properties: { url_or_html: { type: "string", description: "A public http(s) URL, or an HTML document." }, session_id: { type: "string" } }, required: ["url_or_html"] };
const tools = [
  ["analyze_accessibility_evidence", "Render a URL or HTML document, run axe-core plus AccessLens semantic checks (and QualWeb ACT Rules for URL scans), preserve raw per-engine provenance, and persist a pending-human-review report. Do not modify code: present get_review_report to the human first.", targetSchema],
  ["get_review_report", "Create the human-facing review packet: each open finding, evidence, proposed safe remediation category, and its approval status. An agent must show this report and ask for explicit human approval before editing code.", { type: "object", properties: { session_id: { type: "string" } } }],
  ["record_human_review", "Record an explicit human decision after the human has reviewed the report. Only call this tool in response to a clear human approval or rejection; it is not permission for the agent to decide on its own.", { type: "object", properties: { finding_ids: { type: "array", items: { type: "string" }, minItems: 1 }, decision: { type: "string", enum: ["approved", "rejected"] }, note: { type: "string" }, session_id: { type: "string" } }, required: ["finding_ids", "decision"] }],
  ["verify_fix", "Re-scan a fixed page and determine whether a previously observed finding cleared. This tool rejects verification unless that finding has a recorded human approval. Also reports new rules introduced since the original scan.", { type: "object", properties: { finding_id: { type: "string" }, url_or_html: { type: "string" }, session_id: { type: "string" } }, required: ["finding_id"] }],
  ["check_session_consistency", "Review stored page snapshots for duplicate IDs, heading-level gaps, multiple main landmarks, and controls whose stable DOM path acquired a different accessible name across scans.", { type: "object", properties: { session_id: { type: "string" } } }],
  ["get_session_report", "Return all recorded verification outcomes, the verified-fix-rate, current open findings, and scan totals.", { type: "object", properties: { session_id: { type: "string" } } }],
  ["analyze_reading_order", "Advisory check: compare focus/tab order with rendered bounding-box order. It is not a substitute for a human reading-order assessment.", targetSchema],
  ["analyze_alt_text", "Advisory check for missing or generic alt text. It cannot assess semantic truthfulness without a vision model.", targetSchema],
  ["analyze_control_names", "Advisory inventory of repeated control names and roles for human review.", targetSchema],
  ["analyze_keyboard_paths", "Advisory static keyboard reachability check. It does not simulate full interaction flows.", targetSchema],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

function json(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function consistency(id) {
  const scans = store.session(id).scans;
  const issues = [];
  for (const current of scans) {
    const snap = current.snapshot;
    const ids = Object.groupBy(snap.ids, (item) => item.id);
    for (const [value, items] of Object.entries(ids)) if (items.length > 1) issues.push({ kind: "duplicate-id", scan_id: current.scan_id, id: value, paths: items.map((x) => x.path) });
    let previous = 0;
    for (const h of snap.headings) { if (previous && h.level > previous + 1) issues.push({ kind: "heading-gap", scan_id: current.scan_id, from: previous, to: h.level, text: h.text, path: h.path }); previous = h.level; }
    const mainCount = snap.landmarks.filter((x) => x.role === "main").length;
    if (mainCount > 1) issues.push({ kind: "multiple-main-landmarks", scan_id: current.scan_id, count: mainCount });
  }
  const namesByPath = new Map();
  for (const scan of scans) for (const control of scan.snapshot.controls) {
    if (!control.name) continue;
    const prior = namesByPath.get(control.path) || new Set(); prior.add(control.name); namesByPath.set(control.path, prior);
  }
  for (const [path, names] of namesByPath) if (names.size > 1) issues.push({ kind: "inconsistent-accessible-name", path, names: [...names] });
  return { session_id: id, scans_checked: scans.length, issues };
}

function reviewReport(id) {
  const s = store.session(id);
  const latest = s.scans.at(-1);
  return {
    session_id: id,
    policy: "Human approval is required before remediation. The agent must present this report and wait for a clear decision before editing code.",
    findings: (latest?.findings || []).map((finding) => ({
      finding_id: finding.finding_id, summary: finding.summary, severity: finding.severity, target: finding.target,
      evidence: finding.fusion, review: s.reviews.get(finding.finding_id) || { decision: "pending_review" },
      proposed_remediation_category: finding.fusion?.status === "cross-method corroborated" ? "candidate mechanical fix; still needs human approval" : "requires human judgment before remediation",
    })),
  };
}

async function call(name, args = {}) {
  const id = session(args);
  if (name === "analyze_accessibility_evidence") return json(store.addScan(id, await scan(args.url_or_html, { calibration: updateCalibration([...store.session(id).outcomes.values()]) })));
  if (name === "get_review_report") return json(reviewReport(id));
  if (name === "record_human_review") {
    for (const findingId of args.finding_ids) if (!store.finding(id, findingId)) throw new Error(`Finding '${findingId}' was not found in session '${id}'.`);
    store.recordReview(id, args.finding_ids, args.decision, args.note);
    return json({ session_id: id, recorded: store.session(id).reviews ? args.finding_ids.map((finding_id) => store.review(id, finding_id)) : [] });
  }
  if (name === "verify_fix") {
    const original = store.finding(id, args.finding_id);
    if (!original) throw new Error(`Finding '${args.finding_id}' was not found in session '${id}'.`);
    if (store.review(id, args.finding_id)?.decision !== "approved") throw new Error("Human review is required before remediation verification. Present get_review_report, obtain explicit approval, then record_human_review.");
    const changed = await scan(args.url_or_html || original.scan.target.value, { calibration: updateCalibration([...store.session(id).outcomes.values()]) });
    const persists = changed.findings.some((f) => f.finding_id === original.finding_id);
    const beforeRules = new Set(original.scan.findings.map((f) => f.rule_id));
    const regressions = changed.findings.filter((f) => !beforeRules.has(f.rule_id));
    const outcome = { finding_id: original.finding_id, status: persists ? "unresolved" : "verified", checked_at: changed.scanned_at, supporting_engines: original.engine_evidence.map((e) => e.engine), regression_findings: regressions, target: changed.target };
    store.session(id).outcomes.set(original.finding_id, outcome);
    store.addScan(id, changed);
    return json(outcome);
  }
  if (name === "check_session_consistency") return json(consistency(id));
  if (name === "get_session_report") return json(store.report(id));
  const modes = { analyze_reading_order: "reading-order", analyze_alt_text: "alt-text", analyze_control_names: "control-names", analyze_keyboard_paths: "keyboard" };
  if (modes[name]) return json(await advisory(args.url_or_html, modes[name]));
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "accesslens-mcp", version: "0.1.0" } } });
    if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    if (request.method === "tools/call") return send({ jsonrpc: "2.0", id: request.id, result: await call(request.params?.name, request.params?.arguments) });
    if (request.id !== undefined) return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) {
    if (request?.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } });
  }
});
