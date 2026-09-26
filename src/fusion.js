import crypto from "node:crypto";

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

// Evidence Fusion Protocol (EFP) deliberately preserves disagreement.  A score
// is an explanation of the evidence, not a claim that multiple tools prove truth.
export function fuseEvidence(engineFindings, calibration = {}) {
  const clusters = new Map();
  for (const finding of engineFindings) {
    const criterion = [...(finding.criterion || [])].sort().join(",") || finding.rule_id;
    const key = `${criterion}|${finding.dom_fingerprint}`;
    const cluster = clusters.get(key) || { key, evidence: [], template: finding };
    cluster.evidence.push(...finding.engine_evidence);
    clusters.set(key, cluster);
  }
  return [...clusters.values()].map((cluster) => {
    const engines = [...new Set(cluster.evidence.map((x) => x.engine))];
    const methodologies = new Set(cluster.evidence.map((x) => x.methodology || x.engine));
    const corroborated = engines.length > 1 && methodologies.size > 1;
    const historical = engines.map((engine) => calibration[engine]?.precision).filter(Number.isFinite);
    const calibrationState = historical.length ? { status: "calibrated", estimated_precision: Math.round((historical.reduce((a, b) => a + b, 0) / historical.length) * 100) / 100 } : { status: "un-calibrated" };
    return {
      ...cluster.template,
      finding_id: `fused:${hash(cluster.key)}`,
      engine_evidence: cluster.evidence,
      fusion: {
        status: corroborated ? "cross-method corroborated" : engines.length > 1 ? "multi-engine, correlated/unknown independence" : "single-engine",
        engines,
        methodologies: [...methodologies],
        match_key: cluster.key,
        calibration: calibrationState,
        explanation: corroborated ? "Independent rule methodologies reported the same criterion on the same DOM fingerprint." : "Evidence is retained without treating agreement as proof; calibration improves only from verified outcomes.",
      },
    };
  });
}

export function updateCalibration(outcomes) {
  const stats = {};
  for (const outcome of outcomes) for (const engine of outcome.supporting_engines || []) {
    const stat = stats[engine] ||= { attempted: 0, verified: 0 };
    stat.attempted++;
    if (outcome.status === "verified") stat.verified++;
  }
  return Object.fromEntries(Object.entries(stats).map(([engine, stat]) => [engine, { ...stat, precision: stat.attempted ? stat.verified / stat.attempted : null }]));
}
