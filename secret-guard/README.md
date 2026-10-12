# secret-guard

A Claude Code mod that stops a credential you paste into a prompt from
reaching the model. When a prompt carries a credential shape (a Shopify
token, an API key, a private key, a password line), the prompt is held and
you choose what happens:

- **Redact and reference**: the value is swapped for a placeholder such as
  `<REDACTED:shopify#1>`, and Claude gets a hidden note naming the kind of
  credential and where it really lives (an environment variable,
  `op read op://...`, `wrangler secret ...`), with an instruction never to ask
  you to paste it again.
- **Send anyway**: the prompt goes as typed, and a toast reminds you the value
  is now in the session transcript.
- **Cancel**: the prompt is not sent, and your draft comes back in the prompt
  box with the value already redacted.

If nobody answers (you dismiss the dialog, or the session is headless, such as
`claude -p`), the prompt is sent **redacted**. Messages you did not type
(another session, a background task, a schedule, a channel, a plugin) are
redacted with no dialog, because a dialog nobody started would stall the
session.

The value itself never appears anywhere the mod writes: not in the dialog, a
toast, a log line, an error or storage. You see the kind of credential only.

## Hooks it registers

Both are `prompt.submit` hooks that decide before the prompt goes on, and both
carry a fail-closed `.catch`: if a hook fails before deciding (a bug, a
timeout, a re-entry), the prompt is held with
`secret-guard: prompt held, possible credential detected`, never sent raw.
`claude plugin validate` lists each as a `gating hook with .catch`.

| Registration | Matcher | What it does |
| --- | --- | --- |
| Your own prompts | `origin.kind` is `composer`, `bridge` or `sdk`; `text` matches the candidate prefilter | Scans, asks, then redacts, sends or holds as above |
| Everything else | `origin.kind` is any other kind, including kinds a later Claude Code build adds; `text` matches the candidate prefilter | Scans and redacts with no dialog |

The candidate prefilter is a cheap case-insensitive regex of the literal every
detector needs (a vendor prefix, `PRIVATE KEY`, `authorization`, `cookie`,
`pass`, `token`, `api key` and so on), so most prompts never run the scan.

Other calls it makes: `$.ui.ask` (the dialog), `$.ui.toast` (a one-line
notice), `$.prompt.fill` with `$.clock.after` (the draft after Cancel), and
`$.ui.copy` (the draft goes to the clipboard when the session has no prompt
box, as in the desktop app). It keeps no state and makes no network or model
calls.

## What it detects

Every pattern is anchored on a prefix or a nearby label and has a bounded
length. Bare hex or base64 never matches on its own, so commit SHAs, UUIDs,
sha256 digests and 32-hex bundle paths pass untouched.

| Kind (placeholder) | Shape |
| --- | --- |
| `private-key` | `-----BEGIN ... PRIVATE KEY-----`; the whole block to its footer is redacted, or for a truncated paste the header line plus every base64 line after it |
| `shopify` | `shpat_`, `shpss_`, `shpca_`, `shppa_` + 32 hex |
| `anthropic` | `sk-ant-` + 20 or more of `[A-Za-z0-9_-]` |
| `openai` | `sk-proj-` + 20 or more; a bare `sk-` + 20 or more only after the start, whitespace, a quote or `=`/`:`, and only with a 16+ letters-and-digits run (so `task-`, `desk-`, `risk-` and URL slugs never match) |
| `github` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` + 36; `github_pat_` + 82 |
| `aws` | `AKIA`/`ASIA` + 16 `[A-Z0-9]`; a 40-character secret access key within 20 characters after a `secret_access_key` label |
| `google` | `AIza` + 35 |
| `slack` | `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-` + 10 or more, with a digit |
| `stripe` | `sk_live_` or `rk_live_` + 24 or more |
| `authorization` | `Authorization: Bearer` (or `token`, `Bot`) + 20 or more characters with Shannon entropy above 3.5; `Authorization: Basic` + a value that decodes to `user:password` |
| `cookie` | a `Cookie:` or `Set-Cookie:` line holding a `name=value` pair whose value is 20 or more characters; the whole header value is redacted |
| `api-token` | a Cloudflare-style 40-character `[A-Za-z0-9_-]` token, with a letter and a digit and not all hex, within 20 characters after a label such as `token`, `api key`, `access key` or `auth key` |
| `password` | `password`/`passwd` (or a `pass` key such as `DB_PASS=`) followed by `:` or `=` and a value of 8 or more characters, on a line shorter than 200 characters |

The password rule skips values that stand for a secret rather than being one:
`<placeholder>`, `${VAR}`, `$VAR`, `{{var}}`, `xxxxxxxx`, `********`,
`changeme`, type names (`string`, `Optional[str]`), and code references
(`os.environ[...]`, `getpass()`, `config.db.password`, `db_password`). Inside a
fenced code block that looks like a config template (one of its values is a
placeholder), documentation dummies such as `example-pass-123` are skipped too.

The same value twice shares one placeholder; distinct values of one kind are
numbered `#1`, `#2`. Overlapping hits (a Bearer header whose value is also an
Anthropic key) merge, so no part of a value survives. After redaction the text
is scanned again until nothing matches.

## Options

Each kind has two `userConfig` fields, shown as rows in `/config` and stored
under `pluginConfigs["secret-guard"]` in settings:

- `scan<Kind>` (boolean, default `true`): set it to `false` to stop scanning
  for that kind. Anything other than an explicit `false` keeps the kind on.
- `hint<Kind>` (string): where that credential lives, told to Claude in the
  note. A hint that is empty, multi-line, longer than 200 characters or itself
  credential-shaped is ignored in favour of the default. Never put a credential
  in a hint.

| Kind | Fields | Default hint |
| --- | --- | --- |
| private key | `scanPrivateKey`, `hintPrivateKey` | the key file on disk (for example ~/.ssh/id_ed25519), referenced by path |
| Shopify | `scanShopify`, `hintShopify` | `wrangler secret SHOPIFY_ADMIN_TOKEN` |
| Anthropic | `scanAnthropic`, `hintAnthropic` | the ANTHROPIC_API_KEY environment variable |
| OpenAI-style | `scanOpenai`, `hintOpenai` | the OPENAI_API_KEY environment variable |
| GitHub | `scanGithub`, `hintGithub` | `gh auth token` |
| AWS | `scanAws`, `hintAws` | the AWS profile in ~/.aws/credentials (aws configure) |
| Google API | `scanGoogle`, `hintGoogle` | the GOOGLE_API_KEY environment variable |
| Slack | `scanSlack`, `hintSlack` | the SLACK_BOT_TOKEN environment variable |
| Stripe | `scanStripe`, `hintStripe` | `wrangler secret STRIPE_SECRET_KEY` |
| Authorization header | `scanAuthorization`, `hintAuthorization` | the API_TOKEN environment variable |
| session cookie | `scanCookie`, `hintCookie` | a fresh login in the browser (cookies are never pasted) |
| API token | `scanApiToken`, `hintApiToken` | `wrangler secret CLOUDFLARE_API_TOKEN` |
| password | `scanPassword`, `hintPassword` | `op read "op://Private/<item>/password"` |

## How to load it

From a terminal, for one session:

```sh
claude --plugin-dir /absolute/path/to/mods/secret-guard
```

Where no flag can be given (a session the desktop app or an SDK host starts),
name the folder in `CLAUDE_CODE_PLUGIN_DIRS`, in the process environment or in
the `env` block of `~/.claude/settings.json`.

To check it:

```sh
claude plugin validate /absolute/path/to/mods/secret-guard
claude plugin test /absolute/path/to/mods/secret-guard
```

The tests generate every credential fixture at run time from a seeded
generator, so the repository never holds a credential-shaped string.

## Known limits

- **Prompt history.** The composer's up-arrow history may keep the unredacted
  text. No hook reaches it.
- **Only the prompt's text is scanned.** Pasted images and documents, files
  pulled in with `@`, context other hooks attach, and anything the model reads
  through a tool (`cat .env`, command output) are not. A `session.append`
  redactor would be the sibling mod for tool output.
- **Send anyway means sent.** The value lands in the transcript file and in
  any `UserPromptSubmit` settings hooks; the toast says so.
- **Mid-turn prompts.** A prompt typed while a turn runs raises the dialog
  over that turn.
- **Desktop app.** If the desktop surface cannot show the dialog, the prompt is
  sent redacted (never dropped). After Cancel there is no prompt box to refill
  there, so the redacted draft goes to the clipboard, which replaces what was
  on it.
- **Heuristics.** Generic shapes are deliberately narrow: an unlabelled token
  with no vendor prefix, a labelled token that is not exactly 40 characters,
  a password on a line of 200 characters or more (minified JSON), or a
  password written in prose without `:` or `=` is not caught. In the other
  direction, an obvious documentation dummy such as `DB_PASSWORD=mypassword`
  outside a template fence still raises the dialog, because it cannot be told
  from a real weak password.
- **Retries the test kit cannot drive.** The refill's retry (a dialog still
  closing) and clipboard fallback (no prompt box) depend on refusal causes only
  the engine sets; their decision logic is unit-tested, the wiring is not.
