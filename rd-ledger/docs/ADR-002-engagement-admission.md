# ADR-002 — What counts as a human engagement event

**Status:** accepted. **Context:** rd-tracker's union-v2 counts human prompts only (SPEC §5,
`policy.py`): `type == user`, not meta/sidechain/compact, not a synthetic marker, entrypoint in
`{claude-desktop, cli}`; queued prompts count once at enqueue. The mod must match that so the
two records corroborate rather than disagree by construction.

**Decision.** The event is `prompt.submit` (fires at Enter, including mid-turn, which is the
enqueue moment). Admitted when `origin.kind` is `composer` or `bridge` and
`CLAUDE_CODE_ENTRYPOINT` is `claude-desktop` or `cli`; `sdk` origin is admitted only under the
`claude-desktop` entrypoint, because the desktop app drives the engine through its SDK host
(verified in this session: entrypoint `claude-desktop`). Every other origin, and an unset
entrypoint, is stored denied with a reason. The hook reads `origin.kind`, `turnId` and `wait`
and never `text`. Slash commands, button presses, model turns, task notifications and peer
messages are not human events.

**Alternatives rejected.** `turn.start` (main loop only, fires at dequeue for a queued prompt,
carries the text); `tool.call` activity (the model's work, not the person's); a trailing pad
after the last prompt (the agreed design has none).

**Consequences.** Hours match rd-tracker's Claude Code hours for the same days up to clock and
parse differences; the Review view shows both. The admission table is printed in every export.
If a future engine stamps desktop prompts differently, the stored verdicts let the rule be
re-derived (the reason string names the origin).
