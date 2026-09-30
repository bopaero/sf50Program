# bop Aero — 2026 SF50 Ownership Program Options

Live (unlisted): https://sf50program.bopaero.com

**`index.html` is the single source of truth.** The PDF is generated from it.
The Pages file in `Detail Sheets/SF50` is a historical record only — edits made
there do not flow here.

## Changing a figure

Every figure is entered once, in the **PROGRAM DATA** block near the top of the
`<script>` in `index.html`:

- `COMMON` — values shared by every program (fixed-cost reference, JetStream,
  closing, tax rate)
- `PROGRAMS` — one entry per program (shares, acquisition value, connectivity,
  management, reserve, wording that differs by program)

Capitalization, per-share capital, annual fees, the 5-year reserve, the fee
ladder, the sensitivity table, equity and schedule concentration are all
calculated. `approx: true` marks pre-owned planning values, whose
acquisition-side figures print with "~".

## Publishing a change

1. Edit the data in `index.html` and bump `DOC.version` (`vYYYY-MM-DD.N`).
2. `python3 tools/build-pdf.py` — renders with headless Chrome and writes the
   same PDF to the repo root (the site's Download PDF), `versions/<version>.pdf`,
   and `Detail Sheets/SF50/bop Aero SF50 Ownership Program Options.pdf` in iCloud.
   It refuses to write anything unless the render is exactly 9 pages, every
   page carries the version, and no JavaScript values leaked into the text.
   `--check` renders and checks without writing.
3. Commit and push; GitHub Pages publishes.
