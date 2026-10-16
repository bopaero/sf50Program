#!/usr/bin/env python3
"""Render the SF50 program document to its PDF.

    python3 tools/build-pdf.py                 # build + check, write to the repo
    python3 tools/build-pdf.py --check         # build + check only, write nothing
    python3 tools/build-pdf.py --out DIR       # write the PDF into DIR (the publish workflow)

The page loads data/costing.json, so it is served over HTTP for the render
(Chrome refuses fetch() from file://). Runs on macOS and on the GitHub Actions
Ubuntu runner.

Nothing is written unless the render is exactly EXPECTED_PAGES pages, every
page carries the costing version, and no JavaScript values or the page's
error message leaked into the text.
"""
import functools
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPECTED_PAGES = 9
# (page, PDF file, exact page count). The expo 1-pager was added 2026-10-10 so
# it is rebuilt from the costing on every publish, like the document.
PDF_NAME = 'bop-Aero-SF50-Ownership-Program-Options.pdf'
EXPO_PDF = 'bop-Aero-SF50-Expo-1-Pager.pdf'
FINANCIAL_PDF = 'bop-Aero-SF50-Financial-Detail-Sheet.pdf'
# (page, PDF file, exact pages, archive suffix in versions/). The Financial Detail
# Sheet was added 2026-10-13 (rebuilt from Raymond's Rev_6).
DOCS = [('index.html', PDF_NAME, EXPECTED_PAGES, ''), ('expo.html', EXPO_PDF, 1, '-expo'),
        ('financial.html', FINANCIAL_PDF, 2, '-financial')]
# One Financial Detail Sheet per pre-owned program, added 2026-10-16 (same page, ?p=<key>)
DOCS += [('financial.html?p=' + k.replace('+', '%2B'), 'bop-Aero-SF50-%s-Financial-Detail-Sheet.pdf' % k.replace('+', 'plus'),
          2, '-financial-' + k.replace('+', 'plus').lower()) for k in ('G1', 'G2', 'G2+')]
# Customer comparison (added 2026-10-16): pre-owned aircraft vs bop Aero shares. It depends on
# THREE versions (this costing, the SR22T costing, data/comparison.json), so it is stamped and
# archived with all three and checked against the comparison version.
COMPARISON_PDF = 'bop-Aero-Aircraft-Ownership-Comparison.pdf'
DOCS += [('comparison.html', COMPARISON_PDF, 2, None)]
SR22T_COSTING = 'https://sr22tprogram.bopaero.com/data/costing.json'
MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def chrome_binary():
    for c in (os.environ.get('CHROME'), MAC_CHROME, shutil.which('google-chrome'), shutil.which('chromium')):
        if c and os.path.exists(c):
            return c
    sys.exit('Chrome not found (set CHROME=/path/to/chrome)')


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def render(out_pdf, page='index.html'):
    httpd = serve(REPO)
    try:
        url = 'http://127.0.0.1:%d/%s' % (httpd.server_address[1], page)
        args = [chrome_binary(), '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
                '--virtual-time-budget=10000', '--run-all-compositor-stages-before-draw',
                '--print-to-pdf=' + out_pdf, url]
        if os.environ.get('CI'):
            args.insert(1, '--no-sandbox')
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        httpd.shutdown()


def page_count(pdf):
    info = subprocess.run(['pdfinfo', pdf], check=True, capture_output=True, text=True).stdout
    return int(re.search(r'^Pages:\s+(\d+)', info, re.M).group(1))


def main():
    args = sys.argv[1:]
    check_only = '--check' in args
    out_dir = args[args.index('--out') + 1] if '--out' in args else None
    version = json.load(open(os.path.join(REPO, 'data', 'costing.json')))['version']
    cmp_version = json.load(open(os.path.join(REPO, 'data', 'comparison.json')))['version']
    sr22t_version = None

    built, problems = [], []
    for page, name, expected, suffix in DOCS:
        tmp = os.path.join(tempfile.mkdtemp(), name)
        render(tmp, page)
        pages = page_count(tmp)
        text = subprocess.run(['pdftotext', '-layout', tmp, '-'], check=True, capture_output=True, text=True).stdout
        bad = []
        if pages != expected:
            bad.append('rendered %d pages, expected %d' % (pages, expected))
        stamp = version if suffix is not None else 'Comparison ' + cmp_version
        if text.count(stamp) != expected:
            bad.append('version %s appears on %d pages, expected %d' % (stamp, text.count(stamp), expected))
        if suffix is None:
            m = re.search(r'Comparison (v[\d.-]+) · SF50 (v[\d.-]+) · SR22T (v[\d.-]+)', text)
            if not m or m.group(1) != cmp_version or m.group(2) != version:
                bad.append('comparison stamp does not name comparison %s and SF50 %s' % (cmp_version, version))
            else:
                sr22t_version = m.group(3)
                suffix = '%s-comparison-sf50-%s-sr22t-%s' % (cmp_version, version, sr22t_version)
        if 'could not be displayed' in text:
            bad.append('the page reported an error: ' + text.strip().splitlines()[0][:200])
        # A formatting or data slip renders as literal JS values instead of figures
        leaks = sorted(set(re.findall(r'undefined|NaN|Infinity|\[object Object\]|native code|function\s*\w*\(', text)))
        if leaks:
            bad.append('rendering errors in text: ' + ', '.join(leaks))
        problems += ['%s: %s (render kept at %s)' % (page, b, tmp) for b in bad]
        built.append((name, tmp, pages, suffix))
    if problems:
        sys.exit('NOT WRITTEN — ' + '; '.join(problems))

    for name, tmp, pages, suffix in built:
        print('OK  %s  %s  %d page%s  %s bytes' % (version, name, pages, '' if pages == 1 else 's', format(os.path.getsize(tmp), ',')))
    if check_only:
        print('    --check: nothing written')
        return
    if out_dir:
        # What this build was made from; the comparison refresh compares it with the live SR22T costing
        os.makedirs(os.path.join(out_dir, 'data'), exist_ok=True)
        with open(os.path.join(out_dir, 'data', 'build.json'), 'w') as fh:
            json.dump({'sf50': version, 'sr22t': sr22t_version, 'comparison': cmp_version}, fh)
        print('    wrote ' + os.path.join(out_dir, 'data', 'build.json'))
    for name, tmp, pages, suffix in built:
        archive = (suffix + '.pdf') if suffix.startswith(cmp_version + '-comparison') else (version + suffix + '.pdf')
        targets = ([os.path.join(out_dir, name)] if out_dir else
                   [os.path.join(REPO, name), os.path.join(REPO, 'versions', archive)])
        for t in targets:
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copyfile(tmp, t)
            print('    wrote ' + t)

if __name__ == '__main__':
    main()
