# Changelog

Notable changes to this server. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version is the
server's, as reported to clients in `initialize`; the tool surface itself is
recorded in [`mcp-surface.json`](mcp-surface.json).

## [2.0.0] — 2026-10-16

### Security

- **Email header injection.** A line break in a subject, address or attachment
  filename is now refused. Previously it was written into the message as-is,
  so `Subject: Hi\r\nBcc: someone@example.com` would add a Bcc recipient.
- **Spreadsheet formula injection.** `sheets_write_range` writes values `RAW`
  by default. It used `USER_ENTERED`, which evaluates any string beginning `=`
  as a formula — including ones such as `IMPORTDATA` that make network
  requests with the sheet's contents.
- The `authorize` script now sends and checks an OAuth `state`, uses PKCE, and
  listens on loopback only instead of every interface.
- `credentials/token.json` is set to owner-only (0600) on every write,
  including one left world-readable by 1.0.0.
- `npm run smoke-test` sends to the authorized account's own address. It had
  a fixed recipient, so running it from a fork mailed the maintainer.
- Dependencies raised to clear every open `npm audit` advisory, including a
  critical one in `proxy-addr` and a high one in the MCP SDK's OAuth client.

### Changed

- **Breaking:** requires Node 22 or later. The per-API Google packages below
  declare `node >=22`, and Node 20 reached end of life in April 2026.
- **Breaking:** `sheets_write_range` no longer parses formulas, dates or
  numbers-in-strings unless called with `valueInputOption: "USER_ENTERED"`.
- `calendar_create_event`, `calendar_update_event` and `calendar_delete_event`
  email attendees by default (`sendUpdates: "all"`), as their descriptions
  already said they did; the Calendar API's own default notifies no one. Pass
  `sendUpdates: "none"` for a silent change.
- Replaced the monolithic `googleapis` package with the five `@googleapis/*`
  packages actually used, and `google-auth-library` directly: `node_modules`
  went from 282 MB to 45 MB. The `gaxios` override is gone; it is no longer
  needed.
- Tool results are compact JSON rather than indented, since the text goes into
  the model's context.
- The server reports the version from `package.json` instead of a fixed `1.0.0`.

### Fixed

- Message bodies are base64-encoded, so an HTML body written as one long line
  can no longer exceed SMTP's 998-octet line limit.
- Non-ASCII subjects and attachment filenames are encoded (RFC 2047 / 2231)
  instead of being sent as raw 8-bit header bytes.
- Attachment content is validated as base64 (line-wrapped, URL-safe and
  unpadded forms are normalised) instead of being sent corrupt. Text with
  spaces, and padding that can't complete the last group, are refused.
- Encoded subjects fold to RFC 2047's 76-character lines, and long non-ASCII
  filenames use RFC 2231 continuations instead of one overlong line.
- Attachment MIME types may carry parameters (`text/csv; charset=utf-8`);
  `multipart/*` and `message/*`, which can't be sent base64-encoded, are refused.
- MIME boundaries are random per message rather than derived from the clock.
- Every Google API request has a 30-second timeout.
- `youtube_get_channel` explains that it needs exactly one of `channelId`,
  `handle` or `mine` instead of passing YouTube's bare 400 through.
- `calendar_list_events` documented a default of 10 results; it returns 20.

### Added

- `mcp-surface.json` and a CI step that fails when the tool surface drifts
  from it. ESLint, Dependabot, Node 22 and 24 in the CI matrix.

## [1.0.0] — 2026-07-28

First public release: 23 tools across Gmail, Calendar, Drive, Sheets and
YouTube, with offline tests and CI.

[2.0.0]: https://github.com/brettadams0/google-workspace-mcp/compare/e259252...HEAD
[1.0.0]: https://github.com/brettadams0/google-workspace-mcp/tree/e259252
