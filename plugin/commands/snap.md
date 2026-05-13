---
description: Capture current .claude/ composition. Reports whether a new snapshot blob was written or a note was attached to existing HEAD.
disable-model-invocation: true
allowed-tools: Bash(harness snap *), Bash(harness log *)
argument-hint: "<note>"
---

Step 1: Run `harness snap "$ARGUMENTS"`.

Step 2: Look at the EXACT first word of the output.

  - If the first word is `Captured`: a NEW snapshot blob was written.
    The id is in that line. Then run `harness log --limit 1` and grab
    the diff summary from the row (the bit after `▶`, e.g.
    `~2 skills`, `+1 agent`, `+1 prompt`).

    Reply with: ✦ New snapshot \`<id>\` — diff: <summary>.

  - If the first word is `No`: NO new blob; only a note was attached
    to the existing HEAD snapshot. The id is on the same line after
    `since `. Do NOT run a second command.

    Reply with: ✦ Note attached to existing HEAD \`<id>\` — composition unchanged.

Do not invert the two cases. The first word of the harness output is
the dispositive signal. Do not pre-decide before reading it.

Keep the reply to that one line. No raw command output.
