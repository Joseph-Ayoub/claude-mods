import { describe, expect, test } from 'claude-code/testing'

import { CUT_MARKER, HANDOFF_PROMPT, NOTE_MAX, capNote, cleanNote, handoffFile, handoffPath, redactSecrets, repoKey } from './handoff'

const T0 = 1_800_000_000_000 // 2027-01-15T08:00:00.000Z
const ID = '11111111-aaaa-4bbb-8ccc-000000000001'

describe('the handoff prompt', () => {
  test('asks for the six sections, a word cap, and forbids credentials and transcript quotes', () => {
    for (const section of ['## Goal', '## Where things stand', '## Decisions and why', '## Next steps', '## Waiting on / open questions', '## Gotchas'])
      expect(HANDOFF_PROMPT).toContain(section)
    expect(HANDOFF_PROMPT).toContain('at most 700 words')
    expect(HANDOFF_PROMPT).toContain('Never include credentials, tokens, keys, passwords, account numbers or personal data')
    expect(HANDOFF_PROMPT).toContain('No quotes from the transcript')
    expect(HANDOFF_PROMPT).toContain('Output the note alone')
  })
})

describe('redactSecrets', () => {
  test('each secret shape becomes [redacted]', () => {
    const cases: [string, string][] = [
      ['key sk-ant-api03-AbC_dEf-1234567890xyz here', 'key [redacted] here'],
      ['openai sk-abcdefghijklmnopqrstUVWX done', 'openai [redacted] done'],
      ['aws AKIAABCDEFGHIJKLMNOP id', 'aws [redacted] id'],
      ['gh ghp_abcdefghijklmnopqrstuvwxyz0123 ok', 'gh [redacted] ok'],
      ['gh gho_ABCDEFGHIJKLMNOPQRSTuv ok', 'gh [redacted] ok'],
      ['slack xoxb-1234567890-abcdef ok', 'slack [redacted] ok'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter', '[redacted]\nafter'],
      ['-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----', '[redacted]'],
      ['curl -H "Authorization: Bearer abcdefghijklmnop.qrstu" x', 'curl -H "Authorization: Bearer [redacted]" x'],
      ['Authorization:   ZXhhbXBsZTpwYXNzd29yZA== x', 'Authorization:   [redacted] x'],
      ['set API_KEY=supersecretvalue123 then', 'set API_KEY=[redacted] then'],
      ['api-key: abcdefgh12345', 'api-key: [redacted]'],
      ['client_secret = "s3cr3t-value-long"', 'client_secret = "[redacted]"'],
      ['TOKEN:abcdefgh12', 'TOKEN:[redacted]'],
      ['password=hunter2hunter2', 'password=[redacted]'],
      // Shapes a settings file, an env block or a curl line would carry.
      ['{"api_key": "abcdefghijklmnop1234"}', '{"api_key": "[redacted]"}'],
      ["'password': 'Pa55word-Pa55word'", "'password': '[redacted]'"],
      ['OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 x', 'OPENAI [redacted] x'],
      ['stripe sk_live_abcdefghijklmnop1234 x', 'stripe [redacted] x'],
      ['gh github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz x', 'gh [redacted] x'],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c x', 'jwt [redacted] x'],
      ['db postgres://admin:S3cretPassw0rd@db.example.com:5432/app x', 'db postgres://admin:[redacted]@db.example.com:5432/app x'],
      ['-----BEGIN OPENSSH PRIVATE KEY-----\nabc\nno end', '[redacted]'],
    ]
    for (const [input, output] of cases) expect(redactSecrets(input)).toBe(output)
  })

  test('ordinary prose about tokens, keys and short values is untouched (no false positives)', () => {
    const prose = [
      'The token budget was the problem: each token costs money, so we cut the prompt.',
      'Set token: abc for the fixture, and password: short too.',
      'Use the secret manager; the api key lives in the keychain.',
      // What the prompt asks the model to write instead of a value: no digits, so it reads as prose and stays.
      'Secret: lives-in-the-macOS-keychain',
      'The next token: implement-the-parser',
      'password: see-the-keychain-entry-named-shop',
      'sk-short is not a key, AKIA alone is not one, ghp_ alone neither, bearer of bad news.',
      'Run git push origin feat/x and open the PR.',
    ].join('\n')
    expect(redactSecrets(prose)).toBe(prose)
  })

  test('is idempotent', () => {
    const once = redactSecrets('token=abcdefgh12345 and sk-ant-abcdefgh1234')
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('cleanNote', () => {
  test('keeps lines and tabs; strips escape sequences, controls, bidi, zero-width and tag characters', () => {
    const dirty = '## Goal\r\n\tShip \u001b[31mred\u001b[0m it\u0007\n\u001b]0;title\u0007Next\u202Eevil\u202C\u200B\u{E0041}\n\n\n\nEnd\u2028more\u0000'
    expect(cleanNote(dirty)).toBe('## Goal\n\tShip red it\nNextevil\n\nEnd\nmore')
  })

  test('C1 controls and a lone ESC go too', () => {
    expect(cleanNote('a\u009b31mb\u0085c\u001bd')).toBe('abcd')
  })
})

describe('capNote', () => {
  test('cuts past the cap with the marker on its own line, and leaves a short note whole', () => {
    expect(capNote('short')).toBe('short')
    const long = 'a'.repeat(30_000)
    const cut = capNote(long)
    expect(cut.endsWith(`\n${CUT_MARKER}`)).toBe(true)
    expect(cut.length).toBe(NOTE_MAX + 1 + CUT_MARKER.length)
  })
})

describe('where the note lands', () => {
  test('repoKey: the repo part, cleaned, capped at 40, never dot-led; session when nothing is left', () => {
    expect(repoKey('claude-skills-lab · mods/mem-gauge')).toBe('claude-skills-lab')
    expect(repoKey('my repo! · main')).toBe('my-repo')
    expect(repoKey('../../etc · x')).toBe('etc')
    expect(repoKey('…')).toBe('session')
    expect(repoKey('')).toBe('session')
    expect(repoKey('a'.repeat(60))).toBe('a'.repeat(40))
  })

  test('handoffPath: under HOME/.claude/handoffs, UTC stamp to the second, repo key, session id prefix', () => {
    expect(handoffPath('/Users/tester', 'claude-skills-lab · main', ID, T0)).toBe(
      '/Users/tester/.claude/handoffs/2027-01-15-080000-claude-skills-lab-11111111.md',
    )
    // A second hand-off a moment later gets its own file.
    expect(handoffPath('/Users/tester', 'claude-skills-lab · main', ID, T0 + 30_000)).toBe(
      '/Users/tester/.claude/handoffs/2027-01-15-080030-claude-skills-lab-11111111.md',
    )
    // A crafted id cannot add path segments.
    expect(handoffPath('/Users/tester', 'x', '../../a/b', T0)).toBe('/Users/tester/.claude/handoffs/2027-01-15-080000-x-ab.md')
  })

  test('handoffFile: the mod\'s header, a blank line, then the cleaned and redacted note; empty when no text is left', () => {
    const text = handoffFile('## Goal\nShip it with sk-ant-abcdefgh12345678.', 'lab · main', ID, T0)
    expect(text).toBe(
      [
        '# Handoff — lab · main — 2027-01-15T08:00:00.000Z',
        `From session ${ID}; the old conversation stays resumable: claude --resume ${ID}`,
        '',
        '## Goal',
        'Ship it with [redacted].',
        '',
      ].join('\n'),
    )
    expect(handoffFile(' \u001b[0m\u200B\n\n ', 'lab', ID, T0)).toBe('')
  })

  test('a key straddling the cap is redacted before the cut, so no prefix of it survives', () => {
    const note = `${'a'.repeat(NOTE_MAX - 10)} sk-ant-abcdefghijklmnopqrstuvwxyz`
    const text = handoffFile(note, 'lab', ID, T0)
    expect(text).not.toContain('sk-ant')
  })
})
