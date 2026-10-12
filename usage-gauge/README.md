# usage-gauge

What this session has cost and used, live, without typing `/usage` and getting a card dropped into the transcript. A small chip in the prompt footer reads `$123`; click it (or type `/spend`) and a **Usage** pane opens with the cost, time, context window, rate limits, per-model tokens and cache hit, what the subagents spent, and the lines the session changed. Nothing lands in the transcript, nothing is written to disk, and nothing is sent anywhere.

## What you see

- **The chip, in the prompt footer.** On the desktop app it sits in the footer's mode row, right beside the context-window circle: `$123`, the session's cost (cents under $100, `$12.34`; whole dollars from there). With the `chipContext` option on it adds how full the context window is: `$123 · ctx 12%`. Before the first cost reading it reads `$ --`; on a host with no cost ledger it is not drawn (with `chipContext` on, `ctx 12%` alone). On the terminal it is the same chip on the hint line under the prompt, after the engine's own hint.
- **The Usage pane** (click the chip, or `/spend`):
  - **Header:** the headline figures, label left and the figure flush with the pane's right edge (the Context and Rate limits rows line up the same way): **Cost** (the engine's own ledger, the same figure `/cost` and the status line show), **Session** (how long since the session began), **Active** (time the main loop spent answering), **API** (every model request's wall time, across every loop, so parallel subagents add up past the session's length), **Turns**, **Requests**, and **Agent turns** once a subagent has run.
  - **Context bar:** a small 2 px pill at the right of the Context title, flush with the pane's edge just above the Window figure: a plain gray track and a fill in the theme's text colour (white on a dark theme) that animates to the new fill each time the window moves (still under Reduce Motion). On the terminal it is 16 cells, the track dim.
  - **Context:** `120k of 1.0M (12%)`, then, once the pane has read the breakdown (on open and on Refresh), tokens left **until compaction** and up to 8 categories (`Messages`, `System prompt`, ...) with their tokens and share of the window; free space and the compaction buffer come last, dim.
  - **Rate limits:** one row per window the engine reports (`5-hour`, `7-day`, `spend limit`), its percent used and when it resets in local time; `none reported` off a subscription.
  - **Models:** one row per model seen: requests, input, output, cache read, cache write, cache hit (cache read over everything the input was answered over), an estimate at list price and its share of the priced total, and a total row. A model the price table does not know reads `--`, never a guess.
  - **What's contributing:** `main loop 40% · subagents 60%` by estimated cost (by tokens when nothing is priced), then the top five subagent types (`builder 35% · verifier 15% · scout 5%`).
  - **Code changes:** `+4,321 −321 lines · 42 edits`, counted from the Edit, Write and NotebookEdit results (a refused or failed edit counts nothing).
  - **Refresh** (`r`) re-reads the figures and the breakdown; **Close** (`c`, or Esc).
  - On a narrow pane (under 60 columns) the model table keeps only output, est. $ and share; the bar stays.

## Install and load

From the marketplace (terminal session):

```
/plugin install usage-gauge --marketplace Joseph-Ayoub/claude-mods
```

While developing, load it from this folder:

```sh
claude --plugin-dir /absolute/path/to/claude-mods/usage-gauge
```

or install it at user scope from the local marketplace (`claude plugin install usage-gauge@joseph-mods --scope user`) so every session the desktop app or the terminal starts loads it (see `mods/README.md`).

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `footerButton` | true | Draw the footer figure as a button (a grey chip on the desktop) that opens the Usage pane; off, it is dim text and `/spend` opens the pane. |
| `chipContext` | false | Also show the context fill in the chip (`$123 · ctx 12%`). Off by default so the footer strip stays short (see Limits); the figure is in the pane. |

## How it works

| Hook | Why |
| --- | --- |
| `session.start` | registers `/spend`; reads `$.session.usage()` (start time, context, rate limits, cost); records when counting began, keeping an earlier value so a reload does not reset the counts |
| `session.measure` | keeps the latest context, rate limits and cost as the engine pushes them |
| `turn.step` | one model request in any loop: passes the response through untouched (`yield* next(e)`, called once) and then counts its tokens by model and by loop, and its wall time; a subagent's type is asked of `$.agent.list()` once per new agent id |
| `turn.complete` | main loop: one turn and its duration (Active); a subagent: one agent turn |
| `tool.call` Edit, Write, NotebookEdit | after the tool ran, counts the added and removed lines of its result's patch; the result is returned as the tool gave it, and the tool never runs twice |
| `command.run` `/spend` | opens the focused pane for your own origins (typed at the prompt, the Remote Control bridge, the SDK host behind the desktop app); where no pane can be placed (`claude -p`) answers a short plain table; a peer session, a plugin, a schedule or an unknown origin gets one summary line and no pane |
| `ui.render` `SessionMode` (desktop), `PromptHint` (terminal) | the chip |
| `ui.render` `Pane` `usage-gauge` | the pane, drawn from the plugin's state only |

Every accounting hook only observes: it hands the event on unchanged and keeps its bookkeeping inside a try/catch. The counts live in the plugin's state, which a hot reload keeps. No prompt, answer, file path or tool argument is ever stored or drawn; model ids, agent types and category names are drawn as one capped line (control characters, escape codes and line breaks become spaces; bidi, zero-width and tag characters are dropped), so none can forge lines in the pane or the `/spend` table.

## Tests

`claude plugin validate mods/usage-gauge` and `claude plugin test mods/usage-gauge`. The tests cover:

- the pure helpers: dollars, tokens, durations, short model names, cache hit, patch counting (refused, failed and held edits count nothing), shares, bounded records, the chip label in each state, the breakdown, the plain report; the price table's prefix rule and estimates;
- the chip on the desktop mode row and the terminal hint line, each state of its label, `footerButton` and `chipContext` off, and a press opening the pane;
- a request's chunks and result passing through untouched with the model asked once, and an Edit returned as the tool gave it;
- the pane on terminal (cell bar) and desktop (pill bar, and that it animates from the last fill) after a busy session: a measurement, a main-loop request on Opus 5.5 and a subagent request on Sonnet 5.5 with the clock moved between, both turns, an Edit and a refused one; model rows, shares, main loop against subagents, the subagent named from the agent list, the lines changed; Refresh drawing the category rows; narrow panes on all four surfaces; usage refused; before any reading;
- `/spend` from the person, from a plugin, headless and unplaced;
- hostile model ids, agent types and category names; a second start (as a reload) keeping the counts.

## Limits

- **The desktop's context-window popover is the app's own.** The circle beside the model name, its "until compaction" bar and its "View usage" arrow (which sends `/usage`) are drawn by the desktop app itself, not by the engine, and no mod can draw inside them. So the chip sits right beside that icon in the footer instead, and opens its own pane. `/usage` and `/cost` are left alone.
- **Two clocks.** The headline cost is the engine's own ledger, from the session's start. The per-model, per-agent, time and code-change figures are counted by this mod from when it loaded; in a session it joined late (installed mid-session, or the first load after an update), they cover only the part since.
- **Estimates are list price** (as of 2026-10-06, copied from rd-ledger's table) with every cache write at the 5-minute rate (1.25x input), so a 1-hour cache write reads low; they are for comparing models and agents, never a bill.
- **API time adds up across loops**: three subagents answering at once count three times. It is the model's working time, not the session's.
- **Rate limits** are whatever the last response reported; none off a subscription.
- **The footer strip is narrow and all-or-nothing.** The desktop draws every plugin's footer chips in one nowrap strip (`overflow: hidden; text-overflow: ellipsis`) beside its own controls; once the chips overflow it, the end of the row is cut to `…` (the full text shows in a tooltip). Plugins loaded earlier draw first, so with mem-gauge's memory and disk chips ahead of this one, this chip is the first to go. That is why the label is short and the context is off by default. If `…` still shows: widen the window, keep `chipContext` off, or set mem-gauge's `footerButtons` off (plain text takes no chip padding).
- **Where the chip can sit.** The desktop app raises the footer's mode row to plugins but not the hint line; the terminal raises the hint line. VS Code and mobile raise neither, so there `/spend` is the way in. That a click reaches the chip is proven by the test kit; confirm it with a live click.
- **No status line.** The mod never sets one (on the desktop host clearing one stops every later render from reaching the plugin).
