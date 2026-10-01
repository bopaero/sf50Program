# bop Aero — 2026 SF50 Ownership Program Options

Live (unlisted): https://sf50program.bopaero.com

**Costing has one source of truth: `data/costing.json`.** Every figure in the
document — and later the bopaero.com SF50 calculator — comes from it, through
one implementation of the math, `assets/costing.js`. `index.html` holds only the
document's wording and layout. The Pages file in iCloud `Detail Sheets/SF50` is
a historical record only.

## Changing costing — the costing editor

**https://sf50-costing.compilotrc.workers.dev** (private: Cloudflare Access,
one-time code e-mailed to an allowed address).

1. Edit any figure. The preview on the right is the real document, recalculated
   as you type; "Resulting figures" shows each per-owner change, with warnings
   for moves over 10%, share-count changes, and dropping "~" on a program.
2. Write a change note, **Review & publish**, confirm the listed changes.
3. The editor assigns the next version (`vYYYY-MM-DD.N`, Eastern date), commits
   `data/costing.json`, and the **Publish** workflow builds the PDF and deploys
   the site and PDF together (about two minutes). The editor shows when it's live.

Programs can't be added or renamed from the editor — each program's wording
lives in `PROGRAM_TEXT` in `index.html`, matched by key.

## How publishing works

`.github/workflows/publish.yml` runs on every push to `main`: installs Arial,
renders the page with headless Chrome (`tools/build-pdf.py --out _site`),
refuses to deploy unless the PDF is exactly 9 pages with the version on every
page and no rendering errors, archives `versions/<version>.pdf`, then deploys
the site and PDF in one step. The PDF is not committed at the repo root.

`python3 tools/build-pdf.py --check` renders and checks locally (macOS).

## The editor Worker (`admin/`)

`admin/worker.js` + `admin/editor.html`, deployed with
`npx wrangler deploy -c admin/wrangler.toml`. It verifies the Access JWT itself
(signature, audience, issuer, expiry, e-mail allowlist) and fails closed until
`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are set. Secret `GITHUB_TOKEN`: fine-grained,
this repo only, Contents read/write + Actions read — never committed.
