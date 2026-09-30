#!/usr/bin/env python3
"""Render index.html (the single source of truth) to the SF50 program PDF.

    python3 tools/build-pdf.py            # build, check, and write all copies
    python3 tools/build-pdf.py --check    # build to a temp file and check only

Writes three copies of the same PDF:
  1. <repo>/<DOC.pdfFile>              — linked from the site's Download PDF button
  2. <repo>/versions/<version>.pdf     — archive, so any version handed out can be recovered
  3. the canonical iCloud copy in Detail Sheets/SF50 under a FIXED name

Aborts (writing nothing) unless the render is exactly EXPECTED_PAGES pages and
the version stamp appears in the text — a dropped print stylesheet or a script
error shows up as the wrong page count or a missing stamp.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(REPO, 'index.html')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
ICLOUD_DIR = os.path.expanduser(
    '~/Library/Mobile Documents/com~apple~CloudDocs/Bop Aero/BopAeroMediaAssets/Detail Sheets/SF50')
ICLOUD_NAME = 'bop Aero SF50 Ownership Program Options.pdf'   # never version this filename
EXPECTED_PAGES = 9


def doc_value(html, key):
    m = re.search(r"var DOC = \{.*?%s:\s*'([^']+)'" % key, html, re.S)
    if not m:
        sys.exit('Could not find DOC.%s in index.html' % key)
    return m.group(1)


def render(out_pdf):
    subprocess.run([
        CHROME, '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
        '--virtual-time-budget=8000', '--run-all-compositor-stages-before-draw',
        '--print-to-pdf=' + out_pdf, 'file://' + INDEX,
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def page_count(pdf):
    info = subprocess.run(['pdfinfo', pdf], check=True, capture_output=True, text=True).stdout
    return int(re.search(r'^Pages:\s+(\d+)', info, re.M).group(1))


def main():
    check_only = '--check' in sys.argv
    html = open(INDEX, encoding='utf-8').read()
    version, pdf_name = doc_value(html, 'version'), doc_value(html, 'pdfFile')

    tmp = os.path.join(tempfile.mkdtemp(), pdf_name)
    render(tmp)
    pages = page_count(tmp)
    text = subprocess.run(['pdftotext', '-layout', tmp, '-'], check=True, capture_output=True, text=True).stdout
    problems = []
    if pages != EXPECTED_PAGES:
        problems.append('rendered %d pages, expected %d' % (pages, EXPECTED_PAGES))
    if text.count(version) != EXPECTED_PAGES:
        problems.append('version %s appears on %d pages, expected %d' % (version, text.count(version), EXPECTED_PAGES))
    # A formatting or data slip renders as literal JS values instead of figures
    leaks = sorted(set(re.findall(r'undefined|NaN|Infinity|\[object Object\]|native code|function\s*\w*\(', text)))
    if leaks:
        problems.append('rendering errors in text: ' + ', '.join(leaks))
    if problems:
        sys.exit('NOT WRITTEN — ' + '; '.join(problems) + '\n  render kept at ' + tmp)

    size = os.path.getsize(tmp)
    print('OK  %s  %d pages  %s bytes' % (version, pages, format(size, ',')))
    if check_only:
        print('    --check: nothing written (render at %s)' % tmp)
        return

    targets = [os.path.join(REPO, pdf_name), os.path.join(REPO, 'versions', version + '.pdf')]
    if os.path.isdir(ICLOUD_DIR):
        targets.append(os.path.join(ICLOUD_DIR, ICLOUD_NAME))
    else:
        print('    iCloud folder not found, skipped: ' + ICLOUD_DIR)
    for t in targets:
        os.makedirs(os.path.dirname(t), exist_ok=True)
        shutil.copyfile(tmp, t)
        print('    wrote ' + t)


if __name__ == '__main__':
    main()
