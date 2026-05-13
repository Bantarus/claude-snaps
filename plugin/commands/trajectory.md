---
description: Show the full chronological trajectory of a session — every snapshot it observed, with notes inline.
disable-model-invocation: true
allowed-tools: Bash(harness sessions *)
argument-hint: "<session-id>"
---

Run `harness sessions "$ARGUMENTS"` (note the double-quotes so shell
metachars in the id like `<manual>` are passed literally) and format
the output as a tight chronological timeline. The CLI already marks
notes with `@`; preserve that convention in your output.

Format:

```
Session <id-prefix>  <first-event-iso> → <last-event-iso>
  <event-iso>  <kind>    <snapshot-id8>           [<note text> if @-marked]
  <event-iso>  <kind>    <snapshot-id8>
  ...
```

Keep snapshot ids to 8-hex prefixes. Don't paste anything not in
the `harness sessions` output. If the session id is unknown, the
CLI exits 1 — report the error verbatim and suggest
`harness sessions` (no args) to list available sessions.
