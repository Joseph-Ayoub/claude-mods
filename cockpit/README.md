# cockpit

One band above the Claude Code prompt that replaces the things you keep typing: quick replies, where the branch and PR stand, one-click answers to option questions, the manual steps Claude is waiting on, and a "save this as a standing rule?" offer. It never calls a model.

It owns the `AbovePrompt` band because that band is a single instance shared with surveys: several band mods would hide each other.

## What it shows

Each section folds to its toggle (the `▾`/`▸` label on its left); the fold is kept for the session.

1. **Replies.** Five buttons, each sending a fixed phrase as your own words (`$.prompt.submit({ text, asUser: true })`). After you click anything in the band it keeps the keyboard focus, and a letter you then type presses the band button with that hotkey. So only the two harmless replies, **Try again** and **Status**, have a hotkey (a letter, never a digit, because a bare digit typed into an empty prompt presses a band button with that digit). **Go**, **Resume** and **Session completion** set work in motion, so they have no hotkey and send only when you press the button itself: typing "make sure" or "wait" into the band never sends them.

   | Key | Button | Sends (default) |
   | --- | --- | --- |
   | - | Go | Go ahead. |
   | - | Resume | Resume from where you left off; do not restart from scratch. |
   | t | Try again | Try again. |
   | s | Status | Status update: what ran and passed, what is merged, what is pending, and the link where it can be seen. |
   | - | Session completion | Is everything done, completed and merged on green CI in this session, and communicated back to the lead session if there is one? If so, archive this session to wrap up; or is that already done? |

   A press is claimed before it is sent, and only one quick reply is in flight at a time: a double press, a press from a second surface, or a second press before the first reply's turn starts sends nothing more ("already queued"). While Claude is working a press sends nothing and says so; press again when the turn ends.

2. **Standing.** One line: `branch · PR #N open/mergeable · CI green|failing|pending · not merged · idle Nm`. When the session is fully done, an **Archive session** button follows the line, read fail-closed: the standing is fresh (under 3 minutes old, and started after the latest turn's Stop, matched by a Stop sequence number and a per-load token rather than a clock, so a standing saved by an earlier load never matches); the PR is merged at this exact HEAD (`headRefOid` equals `git rev-parse HEAD`), or there is no PR (gh's "no pull requests found" or "no git remotes found"), nothing is ahead of the upstream (`git rev-list --count @{u}..HEAD` is 0; no upstream counts as unknown) and HEAD is already in the remote default branch (`git merge-base --is-ancestor HEAD origin/<default>`, the default from `refs/remotes/origin/HEAD`; unknown blocks); a repository with no remote at all (`git remote` lists none) has nowhere to push or merge, so a clean tree counts as done and the reason reads `no remote, all committed`; `git status --porcelain` is empty; nothing is working or queued, no item waits on you, no decision card is open; the Stop after the latest turn listed no background task or wakeup (a new turn resets the count until its Stop); where the host raises no Stop to mods (the desktop app), the turn end reads the running subagents instead and background shell tasks and wakeups stay the app's to guard, which refuses to archive live work (the blocker then reads `N running agents`); and the lead: the app's `get_session` record is read once a minute (unknown until it answers, and a lead once known is never forgotten by a failed read), and when it names a parent session, this session's main loop sent it a delivered message (run by the engine, not answered by a hook, not refused, not errored) after the merge: GitHub's `mergedAt`, or the refresh that first saw it merged, kept only while the same PR on the same branch stays merged; with no PR, after the refresh that first saw HEAD in the default branch (the app's `send_message` to that id, or any `SendMessage`, which names sessions by title the band cannot match). The standing is stamped before its first git reading, and a refresh asked for while one runs (a turn's end, the press) waits for it and reads again, so readings from before an edit never pass. Pressing it asks `Archive this session (PR #N merged, tree clean, nothing waiting)? Finished side sessions sharing its worktree are archived with it.`, re-reads git and judges everything again after the answer (an edit, a wakeup or a task that arrived meanwhile stops it, with a toast; a re-read that does not land stops it too), and then calls the app's `archive_session` tool for this session, which ends it; the button exists only where that tool is listed, elsewhere the row reads `done: ready to archive (use the app)`. While the session is idle and not done, a dim line says what stands: `archive after: PR #12 open, 3 uncommitted changes, 1 waiting on you, lead session not told` (untracked files count as changes). Unknown never passes (an unreadable tree, no Stop seen yet). Child sessions this one started are the app's to guard: its archive refuses while a side session sharing the worktree is still working, and archives finished ones with it. Work parked in a git stash is invisible to the check, and GitHub's merge time is compared with this Mac's clock. It comes from `git rev-parse --abbrev-ref HEAD` and `gh pr view --json number,state,mergeable,mergeStateStatus,statusCheckRollup,mergedAt,url`, both run in the session's own directory (`$.session.cwd()`, so a worktree shows its own branch) with a 10-second timeout. It refreshes every minute and after every main-loop turn, but only while a surface that draws the band (terminal or desktop) is attached: a `-p` run never polls. "No pull requests found" reads as `no PR`; an empty or unknown CI rollup reads as `pending`, never `green`; a `gh` that hangs until the timeout reads as `PR unknown` for that round. `(stale Nm)` appears once the last refresh is over three minutes old. Idle counts from the last tool call.

3. **Decisions.** After each main-loop answer, deterministic patterns look for option questions: a header (`Q1`, `Question 2`, `Decision 3:`, `1.`, or a line with a `?`) followed by at least two lettered options (`a)`, `(b)`, `C.`, `Option D`), or options written on the question line. A block counts only when its header or the lines under it ask you something (a `?` that ends the line, or is followed only by "pick one" and the like) or a "recommend" sits in it. Fenced code is skipped, and a question the text answers itself ("Did it regress? No.", "Why did CI fail? Two reasons:") is prose, so step lists, status lists, explanations and code samples do not raise cards.
   - **The recommendation.** Only two things preset a picker.
     - A line that opens with `Recommended:` (or `Recommendation:`) and holds nothing else but the options: `Recommended: b`, `Recommended: (b)`, `Recommended: option B`, `Recommended: Q1 a, Q2 c`, with at most a closing full stop. Any other word on the line voids all of it, so `Recommended: not Q1 a`, `Recommendation: avoid Q1 a; go with Q1 b`, `Recommended: (a) is NOT recommended` and `Recommended: a - avoid at all costs` name nothing. A line that names the same question twice with different letters names nothing for it.
     - The option's own label carrying a whole mark: a bracket holding nothing else (`(recommended)`, `[strongly recommended]`, `(my recommendation)`) and not led by a negating word (`not (recommended)`), or the label opening with `Recommended:` or closing with `— recommended`. The opening and closing forms count only when nothing else in the label is a negation cue (not, no, never, avoid, against, but, rather, least, risky, wrong, any `n't`, and the like), so `Recommended: no, too risky`, `Recommended — against: Postgres` and `avoid, recommended` mark nothing.
     - Prose never names an option (`I recommend option B` does not), and neither does a passing mention (`Use the recommended defaults`) or watered-down wording (`(least recommended)`, `Recommended against: Q1 a`). When two marks disagree there is no recommendation, so the picker is never preset to a guess. These are patterns, not understanding: the preview line under the buttons shows exactly what will be sent before you press.
   - Each question gets a picker preset to the recommended option; **Send answers** puts `Q1 a, Q2 c` into the prompt for you to send with Enter (or submits it directly where there is no prompt box). **Accept all recommended** shows only when every question has a recommendation. A dim line under the buttons shows the exact text each of them will send. While Claude is working these buttons are dimmed and a press only says so.
   - The cards clear when you send your next prompt (typed, from a phone, or from the desktop app). A background-task notification, a peer session's message, or a prompt that a hook beneath blocked does not clear them.

4. **Waiting on you.** Lines in the last answer starting `WAITING ON JOSEPH:` or `WAITING ON YOU:` (any case) become items (up to 200 characters each) with a **Done** button that sends `Done: <item>` as your words and removes it. Each item is cleaned to printable ASCII when it is read: invisible characters (controls, zero-width, bidi overrides, the Unicode tag block used to smuggle hidden text) are dropped, accents come off letters, typographic quotes, dashes and ellipses are spelled plainly, and any other character is dropped. The band draws exactly the cleaned text, and that is what Done sends. The item is drawn whole, wrapped over as many rows as it needs and never cut, because Done sends all of it: read it before pressing, since Claude wrote it. An answer without the marker leaves the list as it was; your next prompt clears it. Done does nothing while Claude is working. Add the marker convention to CLAUDE.md so Claude uses it.

5. **Save as a standing rule?** When a prompt you type contains "going forward", "from now on", "standing rule", "add/put this/that to/in memory", or a request to "remember that/to" (not bare "always" or "never"; "Do you remember that bug?" and "I can't remember" are not requests), the band shows that sentence with **Global rules**, **Project rules** and **Dismiss**. A lead-in ending in a colon ("Going forward:") takes the lines under it as the rule ("Going forward: use pnpm; no yarn"). Nothing is written until you press one. The sentence is cleaned of invisible and reordering characters (controls, zero-width, bidi overrides, the Unicode tag block) before it is shown, so what the band shows is exactly what is written to the file, which loads as standing instructions in later sessions.
   - Global writes to `$HOME/.claude/captured-rules.md` (created with a short header). That file loads only once `~/.claude/CLAUDE.md` has the line `@captured-rules.md`. The mod never edits `~/.claude/CLAUDE.md` itself; when the line is missing, the "Saved" message says so and names the file to add it to.
   - Project writes to `<session root>/CLAUDE.md`.
   - The rule goes under a `## Captured rules` heading, created if missing, at the end of that section: never a blind append, so a generated block at the end of a file stays whole. A heading inside a code block is not used, and a file with Windows line endings keeps them. The write re-checks the file's modification time just before writing and tries once more if another session changed it; if it keeps changing nothing is written and the offer stays.
   - Before offering, the band checks the global file and this project's `CLAUDE.md`. A rule already there as a line of its own (in any section, outside code), or saved there from an earlier prompt, is not offered again. Saving to one project does not stop the offer in another.

## Hooks it registers

| Hook | Kind | What it does |
| --- | --- | --- |
| `session.start` | observer | Arms the one-minute standing refresh when a surface that draws the band (terminal or desktop) is attached, read from `$.session.surfaces()`, not from `isInteractive` (false for the desktop app's SDK-hosted session). With none attached (`-p`) it does not poll. |
| `session.attach` | observer | Arms the refresh when the desktop app attaches to a session that started without a band surface. |
| `tool.call` | observer, gating site with `.catch` that replays `next` | Stamps the last tool time (not awaited) and lazily re-arms the refresh after a hot reload (still only with a band surface attached). Never refuses a tool. |
| `turn.start` | observer | Clears a pending quick reply once its turn starts. |
| `turn.complete` | observer | Main loop only (`agentId` undefined): refreshes the standing line without holding the answer; on `reason: 'answer'` parses decision cards and waiting items. Returns the answer's result unchanged. |
| `prompt.submit` | guard, fails open (`.catch` replays `next`) | Drops an exact duplicate (normalized) of one of your last five prompts from the last ten minutes, only when it was typed over a running turn (`turnId` set), not queued on purpose (`wait` not true), and from you (`composer`, `bridge` or `sdk` origin: the desktop app hosts its sessions over the SDK); puts the text back in the prompt if it is empty. After the hooks beneath let a prompt through (never for one they dropped): a prompt from you (`composer`, `bridge` or `sdk`) retires the cards and the waiting items and is checked for a standing-rule sentence. |
| `ui.render` on `AbovePrompt` | drawing | Draws the band on terminal and desktop, sized to `bodyColumns`; yields (`next(e)`) to a survey and while a subagent's transcript is open. |

`claude plugin validate` lists `tool.call` and `prompt.submit` as gating hooks with `.catch`; both fail open by design, since neither should ever block you.

## Options

Each quick-reply phrase is a `userConfig` field, editable in `/config` or under `pluginConfigs.cockpit` in settings: `replyGo`, `replyResume`, `replyTryAgain`, `replyStatus`, `replyCompletion`. An empty value falls back to the default above. A custom phrase is cleaned to printable ASCII like a Done item, and the band shows it under the buttons (`Go sends: "..."`), since it goes out as your words.

## Loading it

From a terminal, for one session:

```sh
claude --plugin-dir /absolute/path/to/claude-mods/cockpit
```

Or set `CLAUDE_CODE_PLUGIN_DIRS` to that absolute path (in the process environment or the `env` block of `~/.claude/settings.json`) so sessions the desktop app starts load it too. Either way the folder is watched in an interactive session, so edits hot-reload.

Check and test it with:

```sh
claude plugin validate mods/cockpit
claude plugin test mods/cockpit
```

## Privacy

- Recent prompts are compared by the SHA-256 of their normalized text; the text itself is never kept.
- A drop reason quotes your prompt only when it is 60 characters or less and has nothing token-shaped in it; otherwise it says "your earlier prompt".
- A sentence that looks like it holds a credential (known token prefixes, private-key headers, any unbroken 32+ character run) is never offered as a rule.
- `$.store` (shared by every session) holds only hashes of saved rules, one key per rule and file it went to (`capturedRule:<sha256>`), so two sessions saving at once never overwrite each other's record.

## Known limits

- The band draws on the terminal and the desktop Code tab only; VS Code and mobile never raise it.
- The standing line needs `git` and the GitHub CLI reachable from the Claude process's own `PATH` (it also tries `/opt/homebrew/bin/gh` and `/usr/local/bin/gh`). `$.process` is documented as CLI-only, so where a host does not offer it the line reads `git unavailable`.
- If the refresh timer died with a hot reload, it is re-armed by the next session event (a prompt, a tool call, a finished turn), not by a redraw; until then the line shows `(stale Nm)` once its data is over three minutes old.
- Decision cards come from patterns, not understanding: an unusual layout can be missed, and a lettered list under a real question can still be read as one. Dismiss clears a wrong card. The recommendation rules are strict on purpose, so an unusual but honest recommendation ("b) Postgres, which I recommend", "I recommend option B" in prose, `Recommended: b, because it is faster`, or `b) Postgres, no migration needed — recommended`, whose "no" is a negation cue) leaves the picker unset rather than risk presetting an option argued against.
- When the prompt box refuses the answers for a reason the engine does not name (another plugin's refusal), the cards stay rather than being submitted, since only a definite "no prompt box" is safe to submit through. That fallback is unit-tested (`fillOutcome`) but not end to end: the test kit strips the refusal's cause.
- Clicking a band control may leave the keyboard focus on the band, where a typed `t` or `s` presses Try again or Status (the only two with hotkeys), at most one phrase at a time; there is no way for a plugin to hand the focus back to the prompt.
- Text sent as your words is ASCII only: a Done item in another script loses those characters (the band shows what is left before you press).
- The PR lookup is one GitHub API call per session per minute while a band surface is attached.
- Another plugin drawing the same band above this one hides it; this one does not draw what plugins beneath it would have (by design: it is meant to be the band's one owner).
- VS Code and mobile get nothing from this mod: there is no status-line or suggestion fallback for them (verifier V10; the spec does not require one, awaiting the lead's acceptance).
- While Claude works, a quick-reply press says `Claude is working, so <reply> was not sent` rather than the spec's "already queued", because nothing was queued (verifier V19, awaiting the lead's acceptance).
- The duplicate guard, rule capture and waiting list treat `composer`, `bridge` and `sdk` origins as you; every other origin (a notification, a peer, a schedule) is not you. That the desktop app stamps your prompts `sdk` was not checked on a live desktop session.
- After you click a band button, the keyboard focus can stay on it, and the declarations say Enter under the focus presses a focused Button. So an Enter pressed while the band holds the focus could press Go, Resume or Session completion again once the turn ends. Send answers, Done and the rule buttons cannot fire twice (each clears what it sends). Not reproduced: no interactive host was available, and the test kit cannot deliver keys to the band. Click back into the prompt before typing.
- The tests cannot type into the band (the kit's `key` reaches only a `Client`), so "typed letters never send Go" is checked by modelling the engine's hotkey dispatch over every printable character, plus the pinned hotkey list. Likewise the hot-reload re-arm is tested by events arriving with no new `session.start`, not by a real reload.
