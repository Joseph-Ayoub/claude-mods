#!/bin/sh
# rd-ledger: the checks the kit cannot run (SPEC §11.13, panel CYB-12/TES-6, verifier V1).
# Run from anywhere: sh mods/rd-ledger/scripts/check.sh
set -u
MOD="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
say() { printf '%s\n' "$*"; }

say "== validate"
if ! claude plugin validate "$MOD" >/dev/null 2>&1; then say "validate failed"; fail=1; fi
if claude plugin validate --json "$MOD" 2>/dev/null | python3 "$MOD/scripts/validate-allowlist.py"; then :; else fail=1; fi

say "== source bans"
if python3 "$MOD/scripts/source-bans.py"; then :; else fail=1; fi

say "== tests"
out="$(claude plugin test "$MOD" 2>&1)"
rc=$?
printf '%s\n' "$out" | tail -3
if [ "$rc" -ne 0 ]; then say "plugin test exited $rc"; fail=1; fi
if printf '%s\n' "$out" | grep -q "(fail)"; then say "a test failed"; fail=1; fi
if ! printf '%s\n' "$out" | grep -q " pass"; then say "no test ran"; fail=1; fi

if [ "$fail" -eq 0 ]; then say "check: OK"; exit 0; fi
say "check: FAILED"; exit 1
