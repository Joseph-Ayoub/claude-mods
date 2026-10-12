# Joseph's Claude Code mods

Function-hooks plugins built from the typed-history analysis in `reports/claude-mods-recommendations.md` (2026-10-09). Each folder is one plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, a `types/index.d.ts` state contract where `$.state` is used, tests under `hooks/*.test.ts`, and a README.

| Mod | What it removes from your typing | Surface |
|---|---|---|
| `cockpit` | one-word approvals, "resume", status polls, the session-completion question, lettered picks, "Done" after a manual step, "going forward" rules | band above the composer |
| `stall-watch` | "try again" after transient API errors, usage-limit watching | timers + status line |
| `wrap` | "is everything done, merged on green, archive this session" | `/wrap` |
| `model-pin` | `/model claude-fable-5-1` re-pins | status line + `/model-pin` |
| `secret-guard` | credentials pasted into chat | prompt hook |
| `mem-gauge` | "is the Mac starving?", which session eats RAM, and the compact-or-hand-off call at 80 % context | status line + `/mem` pane |
| `merge-lane` | sessions fighting over PR/CI/merge | `/lane` + Bash merge gate |
| `usage-gauge` | `/usage` dumps into the transcript to see what the session cost | footer chip + `/spend` pane |

## Load

**Every session (how it is set up, 2026-10-12):** this folder is added as the marketplace `joseph-mods` (`claude plugin marketplace add /absolute/path/to/mods`, recorded in user settings) and seven mods are installed from it at user scope (`claude plugin install <mod>@joseph-mods --scope user`: cockpit, stall-watch, wrap, model-pin, secret-guard, mem-gauge, usage-gauge), so every session the desktop app or the terminal starts loads them. The installed copies live under `~/.claude/plugins/cache/joseph-mods/<mod>/<version>/`, keyed by the version in each `plugin.json`: after a change here, bump that version, then `claude plugin marketplace update joseph-mods` and `claude plugin update <mod>@joseph-mods`, and `/reload-plugins` in a running session (or restart it). `merge-lane` is not installed: its Bash merge gate would sit on every session at once, and the lane protocol other sessions run by hand has not been reconciled with it; load it per session with `--plugin-dir` when wanted. (The `env.CLAUDE_CODE_PLUGIN_DIRS` route was tried first and did not reach desktop-hosted sessions on app 2.31226 / CLI 2.1.296; it is removed.)

For one session only: hot reload in the desktop app by copying a mod folder into that session's dev-mods folder (the app asks once to enable hot reloading; do not do this for a mod the settings already load, or the session loads it twice), or `claude --plugin-dir /absolute/path/to/mods/<mod>` in a terminal (repeat the flag for several).

Install from this repo as a marketplace (terminal session): `/plugin install <mod> --marketplace Joseph-Ayoub/claude-mods` (the public mirror of this folder), or add the folder directly: `claude plugin marketplace add /absolute/path/to/mods`.

## Check

```bash
claude plugin validate mods/<mod>
```

```bash
claude plugin test mods/<mod>
```

## Conventions the mods rely on

- `WAITING ON JOSEPH: <item>` lines in replies feed the cockpit band's needs-you list (rule in `~/.claude/CLAUDE.md`).
- Rules captured by the band go to `~/.claude/captured-rules.md` (imported by the global CLAUDE.md) or the project `CLAUDE.md` under `## Captured rules`.
- `~/.claude/settings.json` pins the session model (`model`) and fallback; `model-pin` reads it, never writes it.
- `merge-lane` keeps its lane state under `~/.claude/merge-lane/<repo-key>/`; `mem-gauge` keeps a per-session registry under `~/.claude/mem-gauge/sessions/`; `stall-watch` writes resume notes under `~/.claude/stall-watch/`.
