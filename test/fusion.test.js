import test from "node:test";
import assert from "node:assert/strict";
import { fuseEvidence, updateCalibration } from "../src/fusion.js";
import { scan } from "../src/engine.js";

test("fusion only calls corroboration cross-method when methods differ", () => {
  const output = fuseEvidence([
    { rule_id: "a", criterion: ["wcag111"], dom_fingerprint: "x", engine_evidence: [{ engine: "axe", methodology: "rule-engine" }] },
    { rule_id: "b", criterion: ["wcag111"], dom_fingerprint: "x", engine_evidence: [{ engine: "semantic", methodology: "structural-analysis" }] },
  ]);
  assert.equal(output.length, 1);
  assert.equal(output[0].fusion.status, "cross-method corroborated");
});

test("calibration is learned from verified outcomes", () => {
  assert.equal(updateCalibration([{ status: "verified", supporting_engines: ["axe"] }]).axe.precision, 1);
});

test("live scan keeps engine provenance and semantic evidence", async () => {
  const result = await scan("<html><head></head><body><h1>Start</h1><h3>Skipped</h3><div id='x'></div><div id='x'></div></body></html>");
  assert.equal(result.fusion_protocol, "EFP-1");
  assert.ok(result.engine_runs.some((run) => run.engine === "axe-core"));
  assert.ok(result.findings.some((finding) => finding.engine_evidence.some((e) => e.engine === "accesslens-semantic")));
  assert.equal(result.engine_runs.find((run) => run.engine === "qualweb-act-rules").status, "not-run");
});
