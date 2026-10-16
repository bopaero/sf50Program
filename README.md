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

Since 2026-10-04 this one Worker is the costing editor for **every** aircraft, all
behind the same Cloudflare Access login: SF50 at `/`, SR22T at `/sr22t`
(`bopaero/sr22tProgram` — its editor page and `costing.js` are bundled from
`../../sr22tProgram`, so deploy with that repo checked out beside this one).

`admin/worker.js` + `admin/editor.html`, deployed with
`npx wrangler deploy -c admin/wrangler.toml`. It verifies the Access JWT itself
(signature, audience, issuer, expiry, e-mail allowlist) and fails closed until
`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are set. Secret `GITHUB_TOKEN`: fine-grained,
this repo only, Contents read/write + Actions read — never committed.

## Expo 1-pager

`expo.html` → `bop-Aero-SF50-Expo-1-Pager.pdf` (one Letter page for events and expos), rebuilt from
Raymond's Pages 1-pager on 2026-10-10. Program figures come from the costing like
the document; operating-cost estimates and aircraft specifications are wording in
`expo.html`. The Publish workflow builds it with the document (fails unless exactly
1 page with the version stamp) and archives `versions/<version>-expo.pdf`.

## Financial Detail Sheet

`financial.html` → `bop-Aero-SF50-Financial-Detail-Sheet.pdf` (2 Letter pages), rebuilt
2026-10-13 from Raymond's Pages sheet (Rev_6, the G3 program). The G3 owner investment
and its per-share breakdown, the Annual Program Fee, the Founder's Circle premium and
positions, and the fuel/pilot/type-training estimates (`common.operating`) all come from
the costing; footnote and contact wording is edited in `financial.html`. Publish builds it
(fails unless exactly 2 pages, each version-stamped) and archives
`versions/<version>-financial.pdf`.

Since 2026-10-16 there is one sheet per program. The same page renders the pre-owned
programs with `financial.html?p=G1` / `?p=G2` / `?p=G2%2B` →
`bop-Aero-SF50-G1|G2|G2plus-Financial-Detail-Sheet.pdf`, archived as
`versions/<version>-financial-g1|g2|g2plus.pdf`. Pre-owned sheets show `~` figures, name the
model years from the program's market range, give a connectivity installation its own line,
leave out Founder's Circle (G3 only), and carry the illustrative-figures footnote.

## Aircraft comparison (customer sheet + internal planning guide)

Added 2026-10-16. Two documents, both built from the live costings so they never go stale:

- **Customer sheet** — `comparison.html` → `bop-Aero-Aircraft-Ownership-Comparison.pdf` (2 Letter
  pages, public/unlisted). One owner buying a pre-owned aircraft outright vs one bop Aero share,
  fuel and pilot excluded, each class at its share's hours (pistons: SR22T `maxHours`; turbines:
  SF50 G3 `schedulingHours`), 3% depreciation. Only aircraft with FIKI, air conditioning and at
  least the matching bop aircraft's typical-trip payload are shown — computed, not hand-picked.
  Stamped `Comparison v… · SF50 v… · SR22T v…` and archived as
  `versions/<comparison>-comparison-sf50-<v>-sr22t-<v>.pdf`.
- **Internal planning guide** — `admin/planning.html`, served only by the editor Worker at
  `/planning` behind Cloudflare Access (never on the public site). Replaces the hand-kept
  "6-Seat Aircraft Financial Comparison": candidate programs, management-fee schedule (checked
  live against both costings), custom 2–8 partner economics, and the pre-owned screening.
  "Download PDF" prints it.

Inputs: `data/comparison.json` (pre-owned aircraft, candidates, assumptions, sources), validated
and computed by `assets/comparison.js`. Edit it in the editor Worker at `/comparison/` — publishing
commits the file with a version note and rebuilds the customer PDF, same as a costing publish.

Living triggers: an SF50 costing or comparison publish pushes here → Publish rebuilds. An SR22T
costing publish lands in the other repo, so `.github/workflows/comparison-refresh.yml` checks every
15 minutes whether the live SR22T costing differs from the one this site was built from
(`data/build.json`, written by the build) and starts Publish if so (repo GITHUB_TOKEN only).
Tests: `bash admin/test/run.sh` (comparison suite included).
