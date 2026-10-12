#!/usr/bin/env python3
"""rd-ledger: holds `claude plugin validate --json` to SPEC §2's exact call and env allowlists (CYB-12).

Reads the JSON report on stdin. Exit 1 with one line per problem; exit 0 and print 'allowlist: OK' when clean.
"""
import json
import re
import sys

ALLOWED_CALLS = {
    "$.agent.list", "$.clock.after", "$.clock.every", "$.clock.now", "$.command.register", "$.env.get",
    "$.fs.exists", "$.fs.list", "$.fs.read", "$.fs.stat", "$.fs.write", "$.process.run",
    "$.session.cwd", "$.session.id", "$.session.model", "$.session.repo", "$.session.surfaces", "$.session.usage",
    "$.state.get", "$.state.set", "$.ui.ask", "$.ui.close", "$.ui.log", "$.ui.open", "$.ui.panes", "$.ui.resolve", "$.ui.toast",
}
ALLOWED_ENV = {"HOME", "CLAUDE_CODE_ENTRYPOINT", "TZ"}


def main() -> int:
    report = json.load(sys.stdin)
    notes = []
    for content in report.get("contents", []):
        notes.extend(content.get("notes", []))
    problems = []
    seen_calls = seen_env = False
    for note in notes:
        m = re.match(r"^\./register\.tsx calls: (.*)$", note)
        if m:
            seen_calls = True
            # Strip every "(via a, b)" group first: the group's own commas would split a call in two.
            calls = {part.strip() for part in re.sub(r"\s*\(via [^)]*\)", "", m.group(1)).split(",") if part.strip()}
            extra = calls - ALLOWED_CALLS
            if extra:
                problems.append(f"calls beyond the SPEC §2 allowlist: {sorted(extra)}")
            missing = ALLOWED_CALLS - calls
            if missing:
                problems.append(f"the SPEC §2 call list names calls the module no longer makes (update both): {sorted(missing)}")
        m = re.match(r"^\./register\.tsx env reads: (.*)$", note)
        if m:
            seen_env = True
            env = {e.strip() for e in m.group(1).split(",")} - {"nothing"}
            extra = env - ALLOWED_ENV
            if extra:
                problems.append(f"env reads beyond the allowlist: {sorted(extra)}")
        m = re.match(r"^\./register\.tsx env writes: (.*)$", note)
        if m and m.group(1).strip() != "nothing":
            problems.append(f"the module writes env: {m.group(1)}")
    if not seen_calls:
        problems.append("validate reported no calls line for ./register.tsx")
    if not seen_env:
        problems.append("validate reported no env-reads line for ./register.tsx")
    for p in problems:
        print(p)
    if problems:
        return 1
    print("allowlist: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
