# AccessLens MCP — Architecture & Feature Plan

## 1. What this is

AccessLens is an accessibility engine built around one core idea: existing tools
(axe-core and its many MCP wrappers, including Deque's official Axe MCP Server)
automate the ~57% of WCAG issues that are rule-detectable. The remaining ~43%
needs judgment — comparing evidence across engines, verifying that a fix actually
worked, and catching issues that only exist *relative to* something built earlier
in the session. AccessLens targets that gap.

It ships as **one core engine**, consumed two ways:

- **`accesslens-mcp`** — an MCP server any AI coding agent (Claude Code, Cursor,
  Windsurf, etc.) can attach to during development.
- **AccessLens web product** — a standalone Next.js/FastAPI app that runs the
  same engine for a full scan-and-report workflow, used as the project's demo
  shell and for non-agent use (manual audits, CI reports).

Both consumers call the same core engine, so a fix verified inside a dev's coding
agent and a scan run from the web dashboard produce identical, comparable results.

---

## 2. High-level architecture

```
                         ┌─────────────────────────────┐
                         │        Core Engine          │
                         │   (Python, FastAPI-backed)  │
                         │                              │
                         │  ┌────────────────────────┐ │
                         │  │  Evidence Fusion Layer  │ │
                         │  │  axe-core + QualWeb +   │ │
                         │  │  normalization/matching │ │
                         │  └───────────┬────────────┘ │
                         │              │               │
                         │  ┌───────────▼────────────┐  │
                         │  │  Verification Loop      │  │
                         │  │  (re-scan after fix,     │  │
                         │  │   verified-fix-rate)    │  │
                         │  └───────────┬────────────┘  │
                         │              │               │
                         │  ┌───────────▼────────────┐  │
                         │  │  Session State Store    │  │
                         │  │  (Postgres — IDs, ARIA, │  │
                         │  │  heading tree, landmarks│  │
                         │  │  per dev session)       │  │
                         │  └────────────────────────┘  │
                         └───────┬──────────────┬───────┘
                                 │              │
                  ┌──────────────┘              └───────────────┐
                  ▼                                              ▼
        ┌───────────────────┐                        ┌───────────────────────┐
        │   accesslens-mcp   │                        │   AccessLens Web App   │
        │  (MCP server layer)│                        │  Next.js + FastAPI     │
        │                     │                        │                        │
        │  Tools exposed to   │                        │  Dashboard, scan       │
        │  any MCP-compatible │                        │  history, reports,     │
        │  coding agent       │                        │  manual-run UI         │
        └─────────┬───────────┘                        └───────────┬────────────┘
                  │                                                 │
                  ▼                                                 ▼
        ┌───────────────────┐                        ┌───────────────────────┐
        │  Dev's coding agent │                        │  Human auditor /       │
        │  (Claude Code,      │                        │  project owner viewing │
        │  Cursor, etc.)      │                        │  scan reports          │
        └─────────────────────┘                        └───────────────────────┘
```

**Key point:** the MCP server and the web app are two thin adapters over one
engine. Neither duplicates fusion, verification, or session logic — that all
lives centrally so the "verified fix rate" metric means the same thing whether
it came from an agent's dev session or a manual web scan.

---

## 3. Core engine components

### 3.1 Evidence Fusion Layer
Runs multiple independent accessibility engines (axe-core + QualWeb to start,
architecture allows N engines) against the same rendered page, normalizes their
findings to a common schema (element selector + WCAG criterion, fuzzy-matched
since engines rarely report identically), and produces:

- **Agreement findings** — flagged by 2+ engines → high confidence, safe to
  auto-fix-and-verify.
- **Conflict findings** — flagged by one engine only → weighted by that engine's
  known bias (e.g. axe under-reports by design, so a lone axe flag is trusted
  more than a lone flag from a noisier engine) rather than simple majority vote.
- **Confidence score** attached to every finding, used downstream to decide
  whether the verification loop runs automatically or surfaces the finding for
  the agent/human to reason about first.

#### Evidence Fusion Protocol (EFP-1) — the novelty boundary

AccessLens does **not** call a finding high-confidence merely because two tools
vote for it. Engine agreement is often correlated: tools can share a rule,
dataset, implementation strategy, or blind spot. Instead, every finding keeps:

- raw per-engine rule, verdict, target, and explanatory evidence;
- a canonical DOM fingerprint and WCAG/ACT mapping used for matching;
- the reporting engine's methodology (rule engine, ACT evaluation, structural
  analysis, future vision model, etc.);
- a fusion explanation: `single-engine`, `multi-engine correlated/unknown`, or
  `cross-method corroborated` only when the matching evidence uses distinct
  declared methodologies;
- a calibration record learned from verified remediation outcomes rather than
  invented as a static probability.

This turns disagreement into a useful product output. A lone engine finding is
not suppressed; it remains inspectable with its provenance. Over time,
verified-fix outcomes make the actual precision of each engine/method visible
for the team's application types. The headline is therefore **auditable
evidence fusion**, not a black-box score.

### 3.2 Verification Loop
After a fix is applied (by the agent or a human), re-runs the Fusion Layer on
the same target and diffs the result against the pre-fix finding:

- Confirms the specific violation cleared.
- Confirms no new violation appeared in the same subtree (regression check).
- Logs the outcome and maintains a running **verified-fix-rate** for the
  session — the project's headline metric.

### 3.3 Session State Store
Postgres-backed, keyed by dev session (or scan session for the web app). Tracks,
across multiple calls/components rather than one page in isolation:

- IDs already used (catch duplicate `id`s introduced components apart).
- Heading hierarchy built so far (catch a skipped level).
- Landmark regions already declared (catch a second `<main>`).
- Accessible names used for repeated controls (catch inconsistent naming for
  the same function — WCAG 3.2.4).

This is what lets AccessLens catch issues that are invisible to a single-page,
stateless scan — which is what every existing MCP wrapper is limited to.

---

## 4. MCP tool surface (`accesslens-mcp`)

Exposed to any connected coding agent:

| Tool | Purpose |
|---|---|
| `analyze_accessibility_evidence(url_or_html)` | Runs the Fusion Layer, returns normalized findings with confidence scores. |
| `verify_fix(finding_id)` | Re-runs the check the finding came from, returns pass/fail + regression check, updates the session's verified-fix-rate. |
| `check_session_consistency()` | Runs Session State checks (duplicate IDs, heading gaps, landmark conflicts) against everything analyzed so far in this session. |
| `get_session_report()` | Returns the running verified-fix-rate and a summary of agreement vs. conflict findings for the session. |

A coding agent's MCP config (example, Claude Code / Cursor-style):

```json
{
  "mcpServers": {
    "accesslens": {
      "command": "npx",
      "args": ["-y", "accesslens-mcp"]
    }
  }
}
```

Once attached, the agent is instructed (via each tool's description) to call
`analyze_accessibility_evidence` before considering a UI-generating task done,
and `verify_fix` after applying any suggested fix — turning the loop from
"suggest and hope" into "suggest, apply, confirm."

---

## 5. Feature list

### Core (build first, demoable)
1. **Fix-Verification Loop + verified-fix-rate metric** — closes the loop every
   existing tool (including Deque's official MCP) leaves open.
2. **Multi-Engine Evidence Fusion** — axe-core + QualWeb, normalized and
   confidence-scored; architecture scales to more engines later.
3. **Session-State Cross-Component Tracker** — duplicate IDs, heading hierarchy,
   landmark conflicts caught across a whole build, not one page.

### Secondary (build if time allows)
4. **Reading-Order vs. Visual-Order Divergence Detector** — bounding-box
   comparison via Playwright against DOM/tab order (WCAG 1.3.2).

### Roadmap (name explicitly as future work, don't over-promise in the demo)
5. Alt-text truthfulness check (vision-grounded, compares image content to alt text).
6. Out-of-context link/button name judgment (LLM evaluates accessible name alone).
7. Live-interaction error message quality check (drives real form submission).
8. Real keyboard-behavior recorder (drives actual Tab/Shift-Tab/Escape sequences).

---

## 6. How the two consumption paths work together

- **Dev adds `accesslens-mcp` to their coding agent** → every UI-generating turn
  can call `analyze_accessibility_evidence` and `verify_fix` before the agent
  considers the task done. Session state persists for the length of the coding
  session.
- **Same session's data is visible in the AccessLens web app** → the dashboard
  reads from the same Session State Store, so a project owner can open the web
  app and see the verified-fix-rate and outstanding findings for a session an
  agent just worked through, without re-running anything.
- **Manual scans from the web app** feed the same Fusion Layer and Verification
  Loop, so a report generated by clicking "scan" in the UI uses identical logic
  to what the agent used mid-build — one engine, two front doors.

---

## 7. Explicit non-goals (state these in the pitch)

- Not claiming to reach 100% automated WCAG coverage — cognitive-load judgment,
  real assistive-tech user testing, and legal sign-off still need a human.
- Not competing with Deque's `analyze`/`remediate` on single-engine scanning —
  positioning is entirely on fusion, verification, and session awareness, which
  no shipped tool currently does.
