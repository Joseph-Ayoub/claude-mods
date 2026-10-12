# ADR-006 — Distribution: a new public `claude-mods` repository (proposal; Joseph decides)

**Status:** proposed; nothing is created or pushed until Joseph says yes. **Context:**
`claude-skills-lab` has no remote and must never be pushed (its `usage-data/` holds session
mirrors); rd-tracker is private, so `/plugin install … --marketplace Joseph-Ayoub/rd-tracker`
would fail for anyone else.

**Proposal.** A new public repository `Joseph-Ayoub/claude-mods` whose root holds
`.claude-plugin/marketplace.json` (name `joseph-mods`) and one folder per mod, mirrored from
`claude-skills-lab/mods/` by a copy script that refuses anything outside the mod folders.
Install line: `/plugin install rd-ledger --marketplace Joseph-Ayoub/claude-mods`.

**What would be published for rd-ledger (and nothing else):** `.claude-plugin/plugin.json`,
`hooks/hooks.json`, `hooks/*.ts`, `hooks/*.tsx`, `hooks/fixtures/*.ts`, `types/index.d.ts`,
`README.md`, `SPEC.md`, `docs/*.md`, `scripts/check.sh`. Before the first push the lead
produces, and shows Joseph: the file list; a leak scan of every file (the mod's own deny-list,
which is rd-tracker's plus the panel's additions); a scan for real business facts that must not
be published (entity legal names, Joseph's zone, home paths, `usage-data/`, `invoices/`,
`store/`, `~/.claude/rd-ledger/`); and a check that every example in the docs uses the
fictitious `acme` / `Example Co` names (PRV-15). Fixtures contain synthetic ids and names only.

**Open to Joseph:** repository name; whether all seven existing mods go too (the marketplace
already lists them) or rd-ledger alone first; licence (MIT suggested); whether the mirror runs
from the weekly `claude-setup` sync.
