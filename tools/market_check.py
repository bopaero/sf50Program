#!/usr/bin/env python3
"""SF50 market check — compares the document's aircraft prices with the market.

    python3 tools/market_check.py            # check, write data/market.json
    python3 tools/market_check.py --dry-run  # check and print only

Sources (both public, both what Cirrus's own pages read):
  - Pre-owned: Cirrus's listings feed behind cirrusaircraft.com/pre-owned/
  - New:       the Vision Jet base price Cirrus publishes on the same page

For each pre-owned program, the comparables are listings that match the
program's `market` settings in data/costing.json (generation + model years),
are available (not sold, not pending), carry a plausible price, and were
updated within `maxListingAgeDays`. The proposed price is their median asking
price rounded to `roundTo`. A proposal exists only when that differs from the
published figure.

It never changes costing. It writes data/market.json, which the costing editor
shows, and prints a Markdown summary for the notification issue. Raymond
approves any change in the editor (decided 2026-10-02).

Exits non-zero if the feed looks broken (too few listings, no Vision Jets, no
price list), so a silent failure can't pass for "no change".
"""
import datetime as dt
import html
import json
import os
import re
import statistics
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEED = 'https://cirrusaircraft.com/wp-json/wp/v2/aircraft-listings?per_page=100&page=%d'
PRICE_PAGE = 'https://cirrusaircraft.com/pre-owned/'
UA = 'bop-Aero-SF50-market-check/1.0 (+https://sf50program.bopaero.com)'
PLAUSIBLE = (500_000, 8_000_000)     # outside this, a listing price is treated as a typo
MIN_LISTINGS, MIN_JETS = 100, 5      # below these, the feed is assumed broken


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json, text/html'})
    with urllib.request.urlopen(req, timeout=45) as r:
        # r.headers is case-insensitive — keep it that way. The feed sends
        # "X-Wp-Totalpages"; a plain dict lookup for "X-WP-TotalPages" misses it
        # and silently reads only page 1.
        return r.read().decode('utf-8', 'replace'), r.headers


def fetch_listings():
    """Every listing, and the total the feed says it holds (to prove none were missed)."""
    rows, page = [], 1
    while True:
        body, headers = get(FEED % page)
        batch = json.loads(body)
        rows += batch
        total, pages = int(headers.get('X-WP-Total') or 0), int(headers.get('X-WP-TotalPages') or 1)
        if page >= pages or not batch:
            return rows, total
        page += 1


def fetch_base_price():
    body, _ = get(PRICE_PAGE)
    m = re.search(r'var cirrus = (\{.*?\});\s*\n', body, re.S)
    if not m:
        return None
    for a in json.loads(m.group(1)).get('aircraft', []):
        if a.get('isJet') == '1' and re.search(r'vision jet', a.get('model', ''), re.I):
            return int(a['price'])
    return None


def money(s):
    digits = re.sub(r'[^0-9]', '', s or '')
    return int(digits) if digits else None


def hours(s):
    digits = re.sub(r'[^0-9]', '', s or '')
    return int(digits) if digits else None


def generation(r):
    g = str(r.get('generation') or '').strip()
    if g:
        return g
    y = int(r.get('year') or 0)
    return 'G1' if y and y <= 2018 else ''      # pre-2019 SF50s are all G1; Cirrus sometimes leaves it blank


def normalize(rows, today, max_age):
    """Available, priced, recent Vision Jet listings, one per airframe."""
    by_airframe = {}
    for r in rows:
        if str(r.get('model')) != 'Vision Jet':
            continue
        a = r.get('acf') or {}
        price = money(a.get('price'))
        modified = dt.date.fromisoformat(r['modified'][:10])
        item = {
            'registration': re.sub(r'\s*\(.*\)', '', a.get('registration_number') or '').strip(),
            'serial': str(a.get('serial_number') or '').strip(),
            'year': int(r.get('year') or 0), 'generation': generation(r),
            'variation': str(r.get('variation') or ''), 'hours': hours(a.get('flight_hours')),
            'price': price, 'modified': str(modified), 'link': r.get('link'),
            'certified': bool(a.get('is_cirrus_certified')),
            'available': not a.get('is_sold') and not a.get('is_pending_sale'),
        }
        # The same airframe can appear twice (relisted under a new registration);
        # keep the most recently updated entry, keyed by serial number.
        key = item['serial'] or item['registration'] or str(r.get('id'))
        if key not in by_airframe or item['modified'] > by_airframe[key]['modified']:
            by_airframe[key] = item
    out, excluded = [], {'sold or pending': 0, 'no price': 0, 'implausible price': 0, 'stale': 0}
    cutoff = today - dt.timedelta(days=max_age)
    for it in by_airframe.values():
        if not it['available']:
            excluded['sold or pending'] += 1
        elif not it['price']:
            excluded['no price'] += 1
        elif not PLAUSIBLE[0] <= it['price'] <= PLAUSIBLE[1]:
            excluded['implausible price'] += 1
        elif dt.date.fromisoformat(it['modified']) < cutoff:
            excluded['stale'] += 1
        else:
            out.append(it)
    return out, excluded


def round_to(n, step):
    return int((n + step / 2) // step * step)       # half-up, not banker's rounding


def main():
    dry = '--dry-run' in sys.argv
    costing = json.load(open(os.path.join(REPO, 'data', 'costing.json')))
    mconf = costing['common'].get('market', {'roundTo': 50000, 'maxListingAgeDays': 90})
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=-4))).date()

    rows, total = fetch_listings()
    jets = [r for r in rows if str(r.get('model')) == 'Vision Jet']
    base = fetch_base_price()
    problems = []
    if len(rows) != total:
        problems.append('read %d listings but the feed reports %d' % (len(rows), total))
    if len(rows) < MIN_LISTINGS:
        problems.append('feed returned only %d listings' % len(rows))
    if len(jets) < MIN_JETS:
        problems.append('feed returned only %d Vision Jet listings' % len(jets))
    if base is None:
        problems.append('Vision Jet base price not found on %s' % PRICE_PAGE)
    if problems:
        sys.exit('MARKET CHECK FAILED — ' + '; '.join(problems))

    listings, excluded = normalize(rows, today, mconf['maxListingAgeDays'])
    result = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
              'source': 'cirrusaircraft.com pre-owned listings', 'roundTo': mconf['roundTo'],
              'maxListingAgeDays': mconf['maxListingAgeDays'], 'costingVersion': costing['version'],
              'feedListings': len(rows), 'visionJetListings': len(jets), 'excluded': excluded,
              'programs': {}, 'proposals': []}

    for p in costing['programs']:
        if 'market' in p:
            m = p['market']
            comps = sorted((it for it in listings if it['generation'] == m['generation']
                            and m['yearFrom'] <= it['year'] <= m['yearTo']), key=lambda it: it['price'])
            entry = {'current': p['acquisition'], 'generation': m['generation'],
                     'years': [m['yearFrom'], m['yearTo']], 'count': len(comps), 'comparables': comps}
            if comps:
                med = statistics.median(it['price'] for it in comps)
                entry.update(median=med, proposed=round_to(med, mconf['roundTo']))
                if entry['proposed'] != p['acquisition']:
                    result['proposals'].append({'program': p['key'], 'field': 'acquisition',
                                                'from': p['acquisition'], 'to': entry['proposed']})
            result['programs'][p['key']] = entry
        elif 'basePrice' in p:
            result['programs'][p['key']] = {'currentBase': p['basePrice'], 'cirrusBase': base, 'options': p['options']}
            if base != p['basePrice']:
                result['proposals'].append({'program': p['key'], 'field': 'basePrice', 'from': p['basePrice'], 'to': base})

    print(summary(result))
    if not dry:
        with open(os.path.join(REPO, 'data', 'market.json'), 'w') as f:
            json.dump(result, f, indent=2)
            f.write('\n')


def summary(r):
    def usd(n): return '$' + format(int(round(n)), ',')
    lines = ['**SF50 market check** — %s, against costing %s' % (r['checkedAt'][:16].replace('T', ' ') + ' UTC', r['costingVersion']), '']
    lines += ['| Program | Published | Market median | Proposed | Comparables |', '|---|---|---|---|---|']
    for k, e in r['programs'].items():
        if 'cirrusBase' in e:
            lines.append('| %s (new, Cirrus base) | %s | %s | %s | Cirrus price list |' % (
                k, usd(e['currentBase']), usd(e['cirrusBase']),
                usd(e['cirrusBase']) if e['cirrusBase'] != e['currentBase'] else 'no change'))
        else:
            lines.append('| %s (%s %d–%d) | %s | %s | %s | %d |' % (
                k, e['generation'], e['years'][0], e['years'][1], usd(e['current']),
                usd(e['median']) if e.get('median') else '—',
                (usd(e['proposed']) if e.get('proposed') != e['current'] else 'no change') if e.get('proposed') else 'no comparables',
                e['count']))
    ex = ', '.join('%d %s' % (v, k) for k, v in r['excluded'].items() if v)
    lines += ['', 'From %d Vision Jet listings in the feed%s.' % (r['visionJetListings'], ' (excluded: ' + ex + ')' if ex else '')]
    lines += ['', ('**%d proposed change%s** — review and publish in the costing editor: https://sf50-costing.compilotrc.workers.dev'
                   % (len(r['proposals']), '' if len(r['proposals']) == 1 else 's')) if r['proposals'] else 'No changes proposed.']
    return '\n'.join(lines)


if __name__ == '__main__':
    main()
