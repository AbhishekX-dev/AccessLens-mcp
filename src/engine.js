import axe from "axe-core";
import { chromium } from "playwright";
import crypto from "node:crypto";
import { fuseEvidence } from "./fusion.js";

const SCHEMA_VERSION = "accesslens.finding.v1";
const privateHost = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i;

export function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function validateTarget(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Provide a non-empty url_or_html string.");
  if (input.trim().startsWith("<")) return { kind: "html", value: input };
  let url;
  try { url = new URL(input); } catch { throw new Error("url_or_html must be an http(s) URL or an HTML document."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) URLs are supported.");
  if (privateHost.test(url.hostname) && process.env.ACCESSLENS_ALLOW_PRIVATE_TARGETS !== "true") {
    throw new Error("Private-network targets are blocked. Set ACCESSLENS_ALLOW_PRIVATE_TARGETS=true only for trusted local development targets.");
  }
  return { kind: "url", value: url.href };
}

async function withPage(target, work) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    if (target.kind === "html") await page.setContent(target.value, { waitUntil: "domcontentloaded" });
    else await page.goto(target.value, { waitUntil: "networkidle", timeout: 30_000 });
    return await work(page);
  } finally { await browser.close(); }
}

async function semanticSnapshot(page) {
  return page.evaluate(() => {
    const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const name = (el) => el.getAttribute("aria-label") || el.getAttribute("alt") || el.labels?.[0]?.innerText || text(el);
    const path = (el) => {
      const parts = [];
      for (let cur = el; cur && cur.nodeType === 1 && parts.length < 8; cur = cur.parentElement) {
        const sibling = [...cur.parentElement?.children || []].filter((n) => n.tagName === cur.tagName);
        parts.unshift(`${cur.tagName.toLowerCase()}:${sibling.indexOf(cur) + 1}`);
      }
      return parts.join(">");
    };
    const elements = [...document.querySelectorAll("*")];
    return {
      title: document.title,
      language: document.documentElement.lang,
      ids: elements.filter((e) => e.id).map((e) => ({ id: e.id, path: path(e) })),
      headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((e) => ({ level: Number(e.tagName[1]), text: text(e), path: path(e) })),
      landmarks: [...document.querySelectorAll("main,nav,header,footer,aside,[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=complementary]")].map((e) => ({ role: e.getAttribute("role") || e.tagName.toLowerCase(), path: path(e) })),
      controls: [...document.querySelectorAll("button,a[href],input,select,textarea,[role=button],[tabindex]")].map((e) => {
        const r = e.getBoundingClientRect();
        return { role: e.getAttribute("role") || e.tagName.toLowerCase(), name: name(e), path: path(e), tabIndex: e.tabIndex, x: Math.round(r.x), y: Math.round(r.y), visible: !!(r.width && r.height) };
      }),
      images: [...document.images].map((e) => ({ alt: e.alt, decorative: e.getAttribute("role") === "presentation" || e.getAttribute("aria-hidden") === "true", src: e.currentSrc || e.src, path: path(e) })),
    };
  });
}

function fingerprint(node) { return hash(node.html || node.target?.join("|") || "document"); }
function normalizeAxe(results) {
  return results.violations.flatMap((violation) => violation.nodes.map((node) => ({
    schema_version: SCHEMA_VERSION,
    finding_id: `axe:${violation.id}:${fingerprint(node)}`,
    engine_evidence: [{ engine: "axe-core", engine_rule_id: violation.id, impact: node.impact || violation.impact, help_url: violation.helpUrl }],
    criterion: violation.tags.filter((tag) => /^wcag\d/.test(tag)),
    rule_id: violation.id,
    severity: node.impact || violation.impact || "unknown",
    target: node.target,
    dom_fingerprint: fingerprint(node),
    html: node.html,
    summary: violation.help,
    detail: node.failureSummary,
    evidence_status: "single-engine",
    confidence: "un-calibrated",
  })));
}

function semanticFinding(rule_id, criterion, severity, path, summary, detail) {
  return {
    schema_version: SCHEMA_VERSION,
    finding_id: `semantic:${rule_id}:${hash(path)}`,
    engine_evidence: [{ engine: "accesslens-semantic", engine_rule_id: rule_id, methodology: "structural-analysis", impact: severity }],
    criterion, rule_id, severity, target: [path], dom_fingerprint: hash(path), html: null,
    summary, detail,
  };
}

function semanticFindings(snapshot) {
  const output = [];
  if (!snapshot.title.trim()) output.push(semanticFinding("document-title", ["wcag242"], "serious", "html>head>title", "Document has no usable title", "A non-empty document title helps users orient themselves."));
  if (!snapshot.language.trim()) output.push(semanticFinding("document-language", ["wcag311"], "serious", "html", "Document language is missing", "Set the lang attribute on the document element."));
  const idGroups = Object.groupBy(snapshot.ids, (item) => item.id);
  for (const [id, nodes] of Object.entries(idGroups)) if (nodes.length > 1) output.push(semanticFinding("duplicate-id", ["wcag412"], "critical", nodes.map((n) => n.path).join("|"), `Duplicate id '${id}'`, "IDs must be unique in a document."));
  let prior = 0;
  for (const heading of snapshot.headings) { if (prior && heading.level > prior + 1) output.push(semanticFinding("heading-level-gap", ["wcag131"], "moderate", heading.path, `Heading jumps from h${prior} to h${heading.level}`, "Review whether the heading hierarchy reflects the content outline.")); prior = heading.level; }
  const mains = snapshot.landmarks.filter((x) => x.role === "main");
  if (mains.length > 1) output.push(semanticFinding("multiple-main-landmarks", ["wcag131"], "serious", mains.map((m) => m.path).join("|"), "More than one main landmark", "A page normally exposes one primary main landmark."));
  return output;
}

async function qualwebFindings(target) {
  if (target.kind !== "url") return { findings: [], run: { engine: "qualweb-act-rules", status: "not-run", reason: "QualWeb evaluates URLs; HTML input is evaluated only by engines sharing the Playwright DOM." } };
  let qw;
  try {
    const [{ QualWeb }, actRulesPackage] = await Promise.all([import("@qualweb/core"), import("@qualweb/act-rules")]);
    const ACTRules = actRulesPackage.ACTRules || actRulesPackage.default?.ACTRules;
    if (!ACTRules) throw new Error("QualWeb ACT Rules module did not expose ACTRules.");
    qw = new QualWeb();
    await qw.start({ maxConcurrency: 1, timeout: 30_000, monitor: false }, { headless: true });
    const reports = await qw.evaluate({ url: target.value, modules: [new ACTRules({ levels: ["A", "AA"] })] });
    const report = Object.values(reports)[0];
    const assertions = report?.modules?.["act-rules"]?.assertions || {};
    const findings = Object.values(assertions).flatMap((assertion) => {
      const failed = assertion.results?.filter((result) => result.verdict === "failed") || [];
      return failed.map((result) => ({
        schema_version: SCHEMA_VERSION,
        finding_id: `qualweb:${assertion.code}:${hash(result.htmlCode || result.pointer || assertion.code)}`,
        engine_evidence: [{ engine: "qualweb-act-rules", engine_rule_id: assertion.code, methodology: "ACT-rule-evaluation", verdict: result.verdict, help_url: assertion.metadata?.url }],
        criterion: assertion.metadata?.a11yReq || assertion.metadata?.["success-criteria"]?.map((item) => item.url) || [],
        rule_id: assertion.code, severity: "moderate", target: [result.pointer || assertion.metadata?.target || "document"],
        dom_fingerprint: hash(result.htmlCode || result.pointer || assertion.code), html: result.htmlCode || null,
        summary: assertion.name, detail: result.description,
      }));
    });
    return { findings, run: { engine: "qualweb-act-rules", version: report?.system?.version || "unknown", status: "completed", violations: findings.length, render_context: "QualWeb/Puppeteer URL render" } };
  } catch (error) {
    return { findings: [], run: { engine: "qualweb-act-rules", status: "unavailable", reason: error.message } };
  } finally { if (qw) await qw.stop().catch(() => undefined); }
}

export async function scan(input, { calibration = {} } = {}) {
  const target = validateTarget(input);
  return withPage(target, async (page) => {
    await page.addScriptTag({ content: axe.source });
    const [raw, snapshot, pageUrl] = await Promise.all([
      page.evaluate(async () => window.axe.run(document, { resultTypes: ["violations"] })),
      semanticSnapshot(page), page.url(),
    ]);
    const axeFindings = normalizeAxe(raw);
    const semantic = semanticFindings(snapshot);
    const qualweb = await qualwebFindings(target);
    const findings = fuseEvidence([...axeFindings, ...semantic, ...qualweb.findings], calibration);
    return { target: { kind: target.kind, value: target.value, resolved_url: pageUrl }, scanned_at: new Date().toISOString(), findings, snapshot, engine_runs: [{ engine: "axe-core", version: axe.version, status: "completed", violations: axeFindings.length, render_context: "Playwright page" }, { engine: "accesslens-semantic", version: "0.1.0", status: "completed", violations: semantic.length, render_context: "Playwright semantic snapshot" }, qualweb.run], fusion_protocol: "EFP-1", fusion_note: "Corroboration is only claimed across distinct methodologies; calibration is learned from verification outcomes." };
  });
}

export async function advisory(input, kind) {
  const target = validateTarget(input);
  return withPage(target, async (page) => {
    const snapshot = await semanticSnapshot(page);
    if (kind === "reading-order") {
      const focusable = snapshot.controls.filter((c) => c.visible && c.tabIndex >= 0);
      const tab = [...focusable].sort((a, b) => a.tabIndex - b.tabIndex || a.path.localeCompare(b.path));
      const visual = [...focusable].sort((a, b) => a.y - b.y || a.x - b.x);
      const mismatches = tab.filter((item, i) => visual[i]?.path !== item.path).map((item, i) => ({ tab_position: i + 1, tab_path: item.path, visual_path: visual[i]?.path }));
      return { target: page.url(), advisory: true, method: "tabindex/DOM order compared with rendered bounding-box order", mismatches };
    }
    if (kind === "alt-text") {
      return { target: page.url(), advisory: true, limitation: "No vision model is used; this flags mechanically suspicious alt text, not truthfulness.", findings: snapshot.images.filter((i) => !i.decorative && (!i.alt.trim() || /^(image|photo|picture|img)(\s*\d*)?$/i.test(i.alt.trim()))).map((i) => ({ ...i, reason: !i.alt.trim() ? "missing alternative text" : "generic alternative text" })) };
    }
    if (kind === "control-names") {
      const grouped = Object.groupBy(snapshot.controls.filter((c) => c.name), (c) => `${c.role}:${c.name.toLowerCase()}`);
      return { target: page.url(), advisory: true, ambiguous_repeated_names: Object.entries(grouped).filter(([, v]) => v.length > 1).map(([key, controls]) => ({ key, controls })) };
    }
    if (kind === "keyboard") {
      const failures = snapshot.controls.filter((c) => c.visible && c.tabIndex < 0 && ["button", "a"].includes(c.role));
      return { target: page.url(), advisory: true, limitation: "Static inspection only; this does not prove interaction behavior such as Escape handling.", potentially_unreachable_controls: failures };
    }
  });
}
