import { hash } from "./engine.js";

export class SessionStore {
  constructor() { this.sessions = new Map(); }
  session(id = "default") {
    if (!this.sessions.has(id)) this.sessions.set(id, { id, scans: [], outcomes: new Map(), reviews: new Map() });
    return this.sessions.get(id);
  }
  addScan(id, scan) { const s = this.session(id); const scanId = `scan_${hash(`${scan.scanned_at}:${scan.target.value}`)}`; s.scans.push({ ...scan, scan_id: scanId }); return { ...scan, scan_id: scanId }; }
  finding(id, findingId) { return this.session(id).scans.flatMap((s) => s.findings.map((f) => ({ ...f, scan: s }))).find((f) => f.finding_id === findingId); }
  review(id, findingId) { return this.session(id).reviews.get(findingId); }
  recordReview(id, findingIds, decision, note) {
    const s = this.session(id);
    for (const findingId of findingIds) s.reviews.set(findingId, { finding_id: findingId, decision, note: note || null, reviewed_at: new Date().toISOString() });
  }
  report(id) {
    const s = this.session(id); const outcomes = [...s.outcomes.values()];
    const verified = outcomes.filter((o) => o.status === "verified").length;
    return { session_id: id, scans: s.scans.length, findings_seen: new Set(s.scans.flatMap((x) => x.findings.map((f) => f.finding_id))).size, outcomes, verified_fix_rate: outcomes.length ? Math.round((verified / outcomes.length) * 100) : null, reviews: [...s.reviews.values()], open_findings: s.scans.at(-1)?.findings.filter((f) => !s.outcomes.has(f.finding_id)) || [] };
  }
}
