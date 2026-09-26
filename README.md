# AccessLens MCP

AccessLens is a local MCP server for accessibility evidence, fix verification,
and consistency checks across an agent session. It scans a rendered page with
axe-core, stores DOM fingerprints rather than brittle selectors alone, and
compares the evidence after a fix.

## Install

```powershell
npx accesslens-mcp --install-browser
```

After it is published to npm, a client can launch it directly with
`npx -y accesslens-mcp`. The setup command downloads Playwright Chromium once;
the browser is required to scan rendered pages.

Until the npm package is published, use the GitHub package spec instead:

```powershell
npx -y github:AbhishekX-dev/AccessLens-mcp --install-browser
```

## Add to an MCP client

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

## Evidence Fusion Protocol

Every finding carries its raw engine evidence, DOM fingerprint, methodology,
and fusion explanation. AccessLens only labels a result **cross-method
corroborated** when separate methodologies report the same criterion on the
same target. It does not convert a vote count into a false probability of truth.
Verification outcomes feed a per-engine calibration record, making the fusion
policy empirically auditable over time.

## Human-review gate

AccessLens follows **report → human review → approved remediation → verify**.
After every scan, an agent must call `run_accessibility_review` (or
`get_review_report` after a legacy scan), show it to the human,
and wait. Only explicit human decisions may be recorded with
`record_human_review`. `verify_fix` refuses to run for a finding without an
approved review record. This makes the intended MCP workflow human-in-the-loop;
the coding agent's own system prompt should separately prohibit file edits until
that approval is received.

The installed engines are axe-core, QualWeb ACT Rules (URL scans), and the
AccessLens semantic analyzer. When a scan cannot preserve equivalent rendering
context, that engine is explicitly marked unavailable rather than silently
excluded or treated as agreement.

## Tools

- `run_accessibility_review`: recommended one-call workflow. Renders the target
  once with Playwright and returns engine status, traceable grouped issues,
  session checks, advisory checks, and a pending-human-review report.
- `crawl_accessibility_review`: crawls same-origin anchor links breadth-first
  (default: 10 pages, depth 2), runs the full review on every discovered page,
  and returns one combined pending-human-review report. It never follows
  external links or invents unlinked SPA routes.
- `analyze_accessibility_evidence`: scan a URL or HTML, collect evidence, and
  store a snapshot in a session.
- `verify_fix`: re-scan an explicit updated URL/HTML and compare the original
  finding plus its affected subtree.
- `check_session_consistency`: detect duplicate IDs, heading-level jumps,
  invalid landmark counts, and inconsistent accessible names.
- `get_session_report`: returns outcome metrics and open findings.
- `analyze_reading_order`, `analyze_alt_text`, `analyze_control_names`, and
  `analyze_keyboard_paths`: advisory modules for the roadmap checks.

Findings are returned in a versioned normalized schema designed for multiple
engines and a provenance-preserving Evidence Fusion Protocol.

## Security model

This is intended for local development targets. By default it accepts only
`http(s)` URLs and blocks localhost/private-network targets unless
`ACCESSLENS_ALLOW_PRIVATE_TARGETS=true` is set. HTML input never makes a
network request.
