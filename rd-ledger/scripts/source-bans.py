#!/usr/bin/env python3
"""rd-ledger: the source bans the kit cannot run (SPEC §8, §11.13). Scans hooks/*.ts and *.tsx,
leaving out tests, the test world and fixtures. Exit 1 on any hit, naming file:line and the ban."""
import os
import re
import sys

BANS = [
    (r"\be\.text\b", "reads the prompt or answer text"),
    (r"\be\.answer\b", "reads the answer text"),
    (r"\.\.\.e\b", "spreads the event object"),
    (r"JSON\.stringify\(e[,)]", "serializes the event object"),
    (r"\['text'\]", "indexes a text field"),
    (r"session\.messages", "reads the transcript"),
    (r"\$\.http", "network access"),
    (r"\bfetch\(", "network access"),
    (r"\$\.store\.", "the plugin's hidden store"),
    (r"ui\.status\(", "the status line (stops every later render on the desktop host)"),
    (r"Date\.now\(", "the wall clock outside $.clock"),
    (r"\bnew Date\(\)", "the wall clock outside $.clock"),
    (r"Math\.random\(", "randomness"),
    # $.agent.list() is read for id and type only (SPEC §2, §8): an entry's task description never reaches the state.
    (r"\.description\b", "reads an agent entry's description (task text)"),
    (r"\[\s*['\"]description['\"]\s*\]", "reads an agent entry's description (task text)"),
    (r"\[\s*'(mv|rm|git|sh|bash|zsh|curl|wget|nc|ssh|scp|gh|shasum|readlink|which|python3?|mkdir|rmdir)'", "a bare executable name in an argv literal"),
]


def main() -> int:
    mod = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    hooks = os.path.join(mod, "hooks")
    hits = []
    for name in sorted(os.listdir(hooks)):
        path = os.path.join(hooks, name)
        if not os.path.isfile(path) or not (name.endswith(".ts") or name.endswith(".tsx")) or name.endswith(".test.ts"):
            continue
        with open(path, encoding="utf-8") as f:
            for lineno, line in enumerate(f, 1):
                for pattern, why in BANS:
                    if re.search(pattern, line):
                        hits.append(f"hooks/{name}:{lineno} {why} ({pattern})")
    for h in hits:
        print(h)
    if hits:
        return 1
    print("source bans: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
