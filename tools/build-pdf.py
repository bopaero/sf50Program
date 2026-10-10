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
DOCS = [('index.html', PDF_NAME, EXPECTED_PAGES), ('expo.html', EXPO_PDF, 1)]
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

    built, problems = [], []
    for page, name, expected in DOCS:
        tmp = os.path.join(tempfile.mkdtemp(), name)
        render(tmp, page)
        pages = page_count(tmp)
        text = subprocess.run(['pdftotext', '-layout', tmp, '-'], check=True, capture_output=True, text=True).stdout
        bad = []
        if pages != expected:
            bad.append('rendered %d pages, expected %d' % (pages, expected))
        if text.count(version) != expected:
            bad.append('version %s appears on %d pages, expected %d' % (version, text.count(version), expected))
        if 'could not be displayed' in text:
            bad.append('the page reported an error: ' + text.strip().splitlines()[0][:200])
        # A formatting or data slip renders as literal JS values instead of figures
        leaks = sorted(set(re.findall(r'undefined|NaN|Infinity|\[object Object\]|native code|function\s*\w*\(', text)))
        if leaks:
            bad.append('rendering errors in text: ' + ', '.join(leaks))
        problems += ['%s: %s (render kept at %s)' % (page, b, tmp) for b in bad]
        built.append((name, tmp, pages))
    if problems:
        sys.exit('NOT WRITTEN — ' + '; '.join(problems))

    for name, tmp, pages in built:
        print('OK  %s  %s  %d page%s  %s bytes' % (version, name, pages, '' if pages == 1 else 's', format(os.path.getsize(tmp), ',')))
    if check_only:
        print('    --check: nothing written')
        return
    for name, tmp, pages in built:
        suffix = '' if name == PDF_NAME else '-expo'
        targets = ([os.path.join(out_dir, name)] if out_dir else
                   [os.path.join(REPO, name), os.path.join(REPO, 'versions', version + suffix + '.pdf')])
        for t in targets:
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copyfile(tmp, t)
            print('    wrote ' + t)

if __name__ == '__main__':
    main()
