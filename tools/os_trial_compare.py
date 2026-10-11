#!/usr/bin/env python3
"""Temporary: compare the PDFs this runner just built with the archived ones.
Reports through a ::notice annotation; never fails the job."""
import glob, json, os, re, subprocess, sys, tempfile

def sh(*a):
    try:
        return subprocess.run(a, capture_output=True, text=True, timeout=120).stdout.strip()
    except Exception as e:
        return 'ERR %s' % e

def pgm(path):
    b = open(path, 'rb').read()
    m = re.match(rb'P5\s+(\d+)\s+(\d+)\s+(\d+)\s', b)
    w, h = int(m.group(1)), int(m.group(2))
    return w, h, b[m.end():m.end() + w * h]

def raster(pdf, d, tag):
    subprocess.run(['pdftoppm', '-gray', '-r', '60', pdf, os.path.join(d, tag)], check=True)
    return sorted(glob.glob(os.path.join(d, tag + '-*.pgm')))

out = []
osname = dict(l.split('=', 1) for l in open('/etc/os-release') if '=' in l).get('PRETTY_NAME', '?').strip().strip('"')
out.append('OS: %s' % osname)
out.append('Chrome: %s' % (sh('google-chrome', '--version') or sh('chromium', '--version') or 'NOT FOUND'))
out.append('Arial resolves to: %s' % sh('fc-match', 'Arial'))
out.append('poppler: %s' % (sh('pdfinfo', '-v') or subprocess.run(['pdfinfo', '-v'], capture_output=True, text=True).stderr.split('\n')[0]))
v = json.load(open('data/costing.json'))['version']
built = [p for p in glob.glob('_site/*.pdf')]
if not built:
    out.append('NO PDF WAS BUILT on this runner')
for new in sorted(built):
    old = 'versions/%s%s.pdf' % (v, '-expo' if 'Expo' in new else '')
    name = os.path.basename(new)
    if not os.path.exists(old):
        out.append('%s: no archived copy %s to compare with' % (name, old)); continue
    pn = re.search(r'Pages:\s+(\d+)', sh('pdfinfo', new)); po = re.search(r'Pages:\s+(\d+)', sh('pdfinfo', old))
    sn = re.search(r'Page size:\s+(.*)', sh('pdfinfo', new)); so = re.search(r'Page size:\s+(.*)', sh('pdfinfo', old))
    tn = sh('pdftotext', '-layout', new, '-').split('\n'); to = sh('pdftotext', '-layout', old, '-').split('\n')
    difflines = [(a, b) for a, b in zip(tn, to) if a != b]
    fn = sorted(set(l.split()[0] for l in sh('pdffonts', new).split('\n')[2:] if l.strip()))
    fo = sorted(set(l.split()[0] for l in sh('pdffonts', old).split('\n')[2:] if l.strip()))
    strip = lambda fs: sorted(set(f.split('+')[-1] for f in fs))
    out.append('%s: pages %s vs %s | size same: %s | text lines %d vs %d, differing: %d | fonts same: %s (%s)' % (
        name, pn and pn.group(1), po and po.group(1), bool(sn and so and sn.group(1) == so.group(1)),
        len(tn), len(to), len(difflines) + abs(len(tn) - len(to)), strip(fn) == strip(fo), ', '.join(strip(fn))))
    for a, b in difflines[:3]:
        out.append('   new: %s' % a.strip()[:110]); out.append('   old: %s' % b.strip()[:110])
    with tempfile.TemporaryDirectory() as d:
        try:
            rn, ro = raster(new, d, 'n'), raster(old, d, 'o')
            per = []
            for a, b in zip(rn, ro):
                wa, ha, da = pgm(a); wb, hb, db = pgm(b)
                if (wa, ha) != (wb, hb):
                    per.append('size!'); continue
                bad = sum(1 for x, y in zip(da, db) if abs(x - y) > 40)
                per.append('%.2f%%' % (100.0 * bad / len(da)))
            out.append('   pixels differing per page (60 dpi, >40/255): %s' % ' '.join(per))
        except Exception as e:
            out.append('   pixel compare failed: %s' % e)
msg = '\n'.join(out)
print(msg)
print('::notice title=OS trial ' + osname + '::' + msg.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'))
