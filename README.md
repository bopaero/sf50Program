# bop Aero — 2026 SF50 Ownership Program Options

Live (unlisted): https://sf50program.bopaero.com

**Costing has one source of truth: `data/costing.json`.** Every figure in the
document — and later the bopaero.com SF50 calculator — comes from it, through
one implementation of the math, `assets/costing.js`. `index.html` holds only the
document's wording and layout. The Pages file in iCloud `Detail Sheets/SF50` is
a historical record only.

## Changing costing — the costing editor

**https://bopaero-admin.compilotrc.workers.dev/sf50/** (private: Cloudflare Access). The Worker (`bopaero-admin`) lives in
bopaero/programs `admin/`; this repo holds only the SF50 editor page, `admin/editor.html`,
bundled into it. (Until 2026-10-21 it was the `sf50-costing` Worker in this repo.)

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

One Worker is the costing editor for **every** aircraft, all behind the same Cloudflare
Access login: SF50 at `/sf50`, SR22T at `/sr22t`. Its source, tests, deploy and secret are
documented in bopaero/programs `admin/` (deploy there with this repo and sr22tProgram
checked out beside it).

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

## Documents covering more than one program → programs.bopaero.com

Moved 2026-10-21 to **bopaero/programs** (programs.bopaero.com): the Letter of Intent, the customer
comparison (`comparison.html`) and the Founder's Circle Insert + Detail Sheet, with
`assets/founders.js` and their tests. That repo builds, archives and refreshes them (it polls both
costings and the comparison data every 15 minutes). Here:

- `comparison.html` and `founders-*.html` are redirects to the new addresses. Their PDFs can't
  redirect, so the last copies built here (`legacy/`) stay at the old PDF addresses, frozen.
  Their archives up to 2026-10-21 stay in `versions/`.
- The comparison data (`data/comparison.json`, `assets/comparison.js`), the admin Worker
  (`bopaero-admin`, with the internal planning guide and Founder's Circle Summary) and their tests
  moved to bopaero/programs on 2026-10-21. Only the SF50 editor page (`admin/editor.html`) stays
  here, bundled into that Worker.