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
PDF_NAME = 'bop-Aero-SF50-Ownership-Program-Options.pdf'
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


def render(out_pdf):
    httpd = serve(REPO)
    try:
        url = 'http://127.0.0.1:%d/index.html' % httpd.server_address[1]
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

    tmp = os.path.join(tempfile.mkdtemp(), PDF_NAME)
    render(tmp)
    pages = page_count(tmp)
    text = subprocess.run(['pdftotext', '-layout', tmp, '-'], check=True, capture_output=True, text=True).stdout
    problems = []
    if pages != EXPECTED_PAGES:
        problems.append('rendered %d pages, expected %d' % (pages, EXPECTED_PAGES))
    if text.count(version) != EXPECTED_PAGES:
        problems.append('version %s appears on %d pages, expected %d' % (version, text.count(version), EXPECTED_PAGES))
    if 'could not be displayed' in text:
        problems.append('the page reported an error: ' + text.strip().splitlines()[0][:200])
    # A formatting or data slip renders as literal JS values instead of figures
    leaks = sorted(set(re.findall(r'undefined|NaN|Infinity|\[object Object\]|native code|function\s*\w*\(', text)))
    if leaks:
        problems.append('rendering errors in text: ' + ', '.join(leaks))
    if problems:
        sys.exit('NOT WRITTEN — ' + '; '.join(problems) + '\n  render kept at ' + tmp)

    print('OK  %s  %d pages  %s bytes' % (version, pages, format(os.path.getsize(tmp), ',')))
    if check_only:
        print('    --check: nothing written (render at %s)' % tmp)
        return
    targets = ([os.path.join(out_dir, PDF_NAME)] if out_dir else
               [os.path.join(REPO, PDF_NAME), os.path.join(REPO, 'versions', version + '.pdf')])
    for t in targets:
        os.makedirs(os.path.dirname(t), exist_ok=True)
        shutil.copyfile(tmp, t)
        print('    wrote ' + t)


if __name__ == '__main__':
    main()
