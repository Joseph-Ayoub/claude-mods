#!/bin/sh
# rd-ledger: what would be published, and a scan of it (ADR-006). Read-only.
# Lists every file of the mod folder, scans each for credential shapes, email
# addresses, home paths, and the real business facts that must not leave this
# Mac, and refuses when anything is found. Run from the repository root:
#   sh mods/rd-ledger/scripts/publish-check.sh
set -eu
MOD="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MOD"
echo "== files that would be published (git-tracked under $(basename "$MOD"))"
git ls-files . | sed 's#^#  #'
echo "== scan"
python3 - "$MOD" <<'PY'
import re, sys, os, subprocess
mod = sys.argv[1]
files = subprocess.check_output(['git', 'ls-files', '.'], cwd=mod, text=True).split()
rules = [
    ('anthropic-key', re.compile(r'sk-ant-[A-Za-z0-9_-]{12,}')),
    ('openai-key', re.compile(r'\bsk-[A-Za-z0-9_-]{16,}')),
    ('stripe-key', re.compile(r'\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}')),
    ('github-token', re.compile(r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}')),
    ('github-pat', re.compile(r'\bgithub_pat_[A-Za-z0-9_]{20,}')),
    ('gitlab-token', re.compile(r'\bglpat-[A-Za-z0-9_-]{16,}')),
    ('npm-token', re.compile(r'\bnpm_[A-Za-z0-9]{30,}')),
    ('google-api-key', re.compile(r'\bAIza[0-9A-Za-z_-]{30,}')),
    ('slack-token', re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{10,}')),
    ('shopify-token', re.compile(r'\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}')),
    ('aws-access-key', re.compile(r'\bAKIA[0-9A-Z]{16}\b')),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}')),
    ('pem-block', re.compile(r'-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)')),
    ('ein', re.compile(r'\b\d{2}-\d{7}\b')),
    ('email', re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')),
    ('home-path', re.compile(r'/Users/[A-Za-z0-9._-]+')),
]
exempt_email = re.compile(r'(noreply@anthropic\.com|users\.noreply\.github\.com|@example\.(com|net|org)|@x\.test|@acme\.io)$')
# Real business facts that must not be published (ADR-006, PRV-15): the mod's docs use acme / Example Co.
# The list itself is a business fact, so it lives OUTSIDE the repository, one entry per line in
# ~/.claude/rd-ledger/publish-facts.txt (or $RD_LEDGER_PUBLISH_FACTS); without it the check refuses.
facts_path = os.environ.get('RD_LEDGER_PUBLISH_FACTS') or os.path.expanduser('~/.claude/rd-ledger/publish-facts.txt')
try:
    facts = [line.strip() for line in open(facts_path, encoding='utf-8') if line.strip() and not line.startswith('#')]
except OSError:
    print(f'REFUSED: the local facts list is missing ({facts_path}); create it before publishing', file=sys.stderr)
    sys.exit(2)
if not facts:
    print(f'REFUSED: the local facts list is empty ({facts_path})', file=sys.stderr)
    sys.exit(2)
allowed_fact_files = set()  # none: every file must be clean
hits = []
fixtures = []
SYNTHETIC_HOMES = ('/Users/tester', '/Users/t', '/Users/x', '/Users/someone', '/Users/..')
FACT_MENTION_OK = {'docs/ADR-006-distribution.md', 'scripts/publish-check.sh'}  # they name the excluded paths as the things being excluded
for f in files:
    p = os.path.join(mod, f)
    try:
        text = open(p, encoding='utf-8', errors='replace').read()
    except OSError:
        continue
    for name, rx in rules:
        for m in rx.finditer(text):
            v = m.group(0)
            if name == 'email' and exempt_email.search(v):
                continue
            if name == 'home-path' and (v in SYNTHETIC_HOMES or (f.startswith('scripts/') and 'Users/[' in text)):
                continue
            line = text.count('\n', 0, m.start()) + 1
            # A credential shape or an address inside a *.test.ts is the leak scan's own fixture: listed for the eye, not refused.
            (fixtures if (f.endswith('.test.ts') and name != 'home-path') else hits).append((f, line, name))
    for fact in facts:
        if fact in text and f not in FACT_MENTION_OK:
            # The test world and fixtures use America/New_York as the fixture zone; that names no person.
            if fact == 'America/New_York':
                continue
            idx = text.index(fact)
            hits.append((f, text.count('\n', 0, idx) + 1, f'business-fact:{fact}'))
if fixtures:
    print('fixture shapes in test files (synthetic; review by eye):')
    for h in fixtures:
        print(f'  {h[0]}:{h[1]} {h[2]}')
if hits:
    print('REFUSED: the following would publish something that must stay local (file, line, kind):')
    for h in hits:
        print(f'  {h[0]}:{h[1]} {h[2]}')
    sys.exit(1)
print('clean: no credential shape outside test fixtures, no non-exempt email, no home path beyond the synthetic test homes, no real business fact')
PY
