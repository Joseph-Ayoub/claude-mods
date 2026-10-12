# handoff

`/handoff` ends this session's conversation at a milestone without losing the thread: a handoff note is written from the conversation (goal, what is done, decisions, exact next steps, open questions, gotchas), saved under `~/.claude/handoffs/`, the conversation is cleared, and the next prompt is pre-filled to continue from the note. You press Enter; nothing is sent for you.

It is one command so the flow lives in one place: mem-gauge's **Hand off** button (on its context tip, past 150k tokens) and the cockpit band's **Hand off** chip (offered at a natural break) both run `/handoff`.

## Use it

```
/handoff
/handoff Phase 2: the cockpit chip
```

Anything after the name is the **focus**: one line (at most 300 characters) the note is asked to steer its next steps toward. Typed mid-turn, `/handoff` waits for the turn to end, so the note covers it.

### Compact or hand off?

They are not the same thing.

- **Compact** keeps the same session and summarizes the conversation so far in place: the model writes a summary, the old messages are replaced by it, and you keep going. Best mid-task, when there is no natural break and the recent context matters. It loses detail: exact tool outputs and file contents are gone, only what the summary keeps.
- **Hand off** starts fresh on purpose: a handoff note is written, the conversation is cleared, and the fresh conversation starts from the note. Best at a milestone (a PR merged, a phase done), when most of the context is history or failed attempts, or after many hours in one session. Every turn afterwards is cheaper and cleaner. It is only as good as the note, which is what the command automates.

The mods that offer it do so at an absolute token count (150k by default), not a share of the window, because a 1M window is capacity for reading a lot at once, not a target: per-turn cost, cache-miss cost and latency grow with the prefix and quality thins, and Anthropic's own compaction defaults to 150k.

### What it does, in order, and why nothing is lost if a step fails

The command answers at once (`handoff: confirm in the dialog. …`) and runs the rest a moment later, once its own answer is drawn:

1. Asks you to confirm (Hand off or Cancel). Cancel or closing the dialog does nothing. If a turn started while the dialog was open, it stops there too: nothing is written, and the toast says to run `/handoff` once the turn has finished.
2. Makes one model call: it asks this session's own model, over this session's own conversation (`$.model.fork`, served from the session's prompt cache, every tool denied, so it can only write text), for a note of at most 700 words with fixed sections, no credentials and no quotes from the transcript. Your focus, if you gave one, is added as a last paragraph.
3. Cleans the note (escape codes, control characters and invisible characters removed; cut at 20,000 characters), blanks anything shaped like a secret (API keys, AWS key ids, GitHub and Slack tokens, JSON web tokens, a URL's password, private key blocks, `Bearer …`, `token: …`, `password=…` become `[redacted]`), and writes it to `~/.claude/handoffs/<date-time>-<repo>-<session id start>.md` under a header naming the repo and branch, the old session and how to resume it (`claude --resume <id>`). If the model gave no note or the file cannot be written, it says so and **nothing is cleared**.
4. Checks the turn once more, then runs `/clear`. If a turn started while the note was being written, the note stays, nothing is cleared, and the toast names the note and says to run `/clear` (or `/handoff`) once the turn has finished. The old conversation is not deleted; it stays resumable by its id. If `/clear` is refused, the note stays and the toast tells you to run `/clear` yourself.
5. Leaves a dim line in the fresh conversation, `handoff: note at <path>` (not sent to the model), so the path survives the toast.
6. Puts `Continue from the handoff note at <path>: read it first, then carry on with its next step.` in the prompt box. It is **never sent for you**: read the note, edit if you like, then press Enter. A draft you typed meanwhile is kept and the line goes under it. If the box cannot take it, the toast tells you to paste the path.

Refused without doing anything:

- from any origin but your own (typed at the prompt, the Remote Control bridge, the SDK host behind the desktop app) or a mod's button: a peer session, a task notification, a scheduled trigger or an unknown origin cannot clear this conversation;
- while a turn is running (a mod's button pressed mid-turn): the note would miss the turn's work;
- while another hand-off is in progress: one dialog at a time. A hand-off whose flow never began (another plugin refused its timer, so no dialog ever opened) stops blocking after 10 seconds and the next `/handoff` takes over; one that began (its dialog is open, or it is writing the note) is never taken over, and a late timer from a claim that was taken over does nothing.

A mod's button passes no focus; text after `/handoff` from a mod is ignored, because the focus is labelled as yours.

## Install and load

From the marketplace (terminal session):

```
/plugin install handoff --marketplace Joseph-Ayoub/claude-mods
```

or install it at user scope from the local marketplace so every session the desktop app or the terminal starts loads it (see `mods/README.md`):

```sh
claude plugin install handoff@joseph-mods --scope user
```

While developing, load it from this folder: `claude --plugin-dir /absolute/path/to/claude-mods/handoff`. After `claude plugin update`, a running session needs a restart to load the new version. Without this mod, mem-gauge's button and the cockpit chip say so in a toast with the install line.

## How it works

| Hook | Why |
| --- | --- |
| `session.start` | registers `/handoff` (before the plugins beneath start, so mem-gauge and cockpit see it in the command list) |
| `turn.start`, `turn.complete` (main loop only) | knows when a turn is running, so a hand-off waits for it; the flag clears even when a hook beneath fails; the prompt text is never read |
| `command.run` `/handoff` | checks the origin, the turn and a hand-off in flight, answers at once, and starts the flow from a zero-delay timer (the engine runs `/clear` and the prompt fill only outside a command's own hook); any failure still answers the command (`handoff: could not start; nothing was done.`) |

## Privacy

- **One model call**, the fork in step 2, only after you confirm. It reads this session's own conversation, nothing else.
- **One file**, the note, under `~/.claude/handoffs/`: one file per hand-off, never in the repository, never removed by the mod: delete them yourself when you no longer need them.
- **One process**, `git rev-parse --abbrev-ref HEAD` in the session's folder (argv only, 3 s), for the branch in the note's header and nothing else. Any failure leaves the repo name alone.
- Reads `HOME` (checked absolute, no `.` or `..`) and nothing else from the environment. No state, no options, no network beyond the model call.

## Tests

`claude plugin validate mods/handoff` and `claude plugin test mods/handoff`. The tests cover:

- the note's pure half: the prompt's sections and rules, each secret shape and a false-positive guard, idempotent redaction, cleaning of escape codes, controls, bidi and zero-width characters, the 20,000-character cut, the file name (UTC stamp, repo key, session id prefix, a crafted id cannot add path segments) and the header;
- `/handoff` from the composer: the answer before the flow, the dialog text, the order fork, write, `/clear`, log line, fill, the note's header and path, `replace` mode, and `append` under a draft;
- the focus: cleaned to one line, cut at 300, dropped when nothing printable is left, ignored from a plugin;
- origins: composer, bridge, SDK and a plugin (mem-gauge, cockpit) accepted; a task notification, a peer, a scheduled trigger, a channel and an unclassified origin refused with nothing done;
- guards: a main-loop turn in flight (a subagent's turn ending does not count), a failing hook beneath `turn.complete` (the turn still ends), a second `/handoff` in flight, two runs before the timer fires, a refused timer (in flight for 10 seconds, then taken over), a taken-over claim's late timer (no second dialog), a started hand-off never taken over, a refused clock read (the command is still answered); a turn started while the dialog is open (nothing written) or between the write and `/clear` (the note stays, nothing cleared);
- nothing cleared when a step fails: Cancel, a dismissed dialog, nothing to fork, an API error, an empty reply, a note empty once cleaned, a refused write, an unusable HOME, a session id of the wrong shape; a refused `/clear` (the note stays); a composer that will not take the fill;
- the label: git failing or refused (the repo name alone), a repo name that is only dots (the file is named `session`), a repo name with a space and a bidi override; a hostile note cleaned and redacted on disk.

## Limits

- **Not yet seen live on the desktop app**: `/clear` run from the timer after the command answered, and the prompt fill after it. The test kit proves the order; confirm with one real hand-off before relying on it.
- The guard against a running turn is per load: a hot reload mid-turn forgets the turn until the next one starts.
- A turn that starts mid-flow is caught at three points: when `/handoff` is run, after the dialog answers, and right before `/clear`. One sent in the instant between that last check and `/clear` running is not caught.
- Redaction is a fixed list of secret shapes under the prompt's own rule against credentials; a shape not on it relies on that rule.
- The note is only as good as the model's summary of the conversation; read it before pressing Enter.
