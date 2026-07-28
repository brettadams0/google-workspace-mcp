# google-workspace-mcp

[![CI](https://github.com/brettadams0/google-workspace-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/brettadams0/google-workspace-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

An [MCP](https://modelcontextprotocol.io) server that gives Claude Code write access to a personal Google account — Gmail, Drive, Calendar, Sheets, and YouTube — backed by a **self-owned Google Cloud OAuth client** rather than a hosted third-party connector. It can **send real email**, not just draft it.

23 tools across 5 Google APIs. Runs locally over stdio.

```
You:    email me a summary of today's calendar
Claude: [calendar_list_events] → 4 events
        [gmail_send_email]     → delivered
```

## Install

```bash
claude mcp add google-workspace -- npx -y @brettadams0/google-workspace-mcp
```

You also need your own Google OAuth client and one run of `npm run authorize` (see Setup).

Published as [`@brettadams0/google-workspace-mcp`](https://www.npmjs.com/package/@brettadams0/google-workspace-mcp).
The scope is there because the unscoped name was already taken on npm by an
unrelated package. Cloning this repo and pointing `claude mcp add` at
`src/index.js` works identically.

## Why own the OAuth client

The hosted Google connectors are read-mostly. Making Claude Code *act* — send a real email, create a real invite, write a real spreadsheet cell — means holding the OAuth client yourself. That single decision drives most of what's interesting below.

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

### The refresh token expires every ~7 days — this is expected

The OAuth client sits in Google's **Testing** publishing mode, and Google invalidates refresh tokens for testing-mode apps after **7 days of inactivity**. Auth breaking after a week away is normal maintenance, not a bug:

```bash
npm run check-auth   # is the stored token still good?
npm run authorize    # re-consent in the browser; rewrites credentials/token.json
```

Moving to "In production" would remove the expiry but triggers exactly the verification review the scope choices above were made to avoid. For a single-user setup, periodic re-authorization is the cheaper trade.

### Irreversible tools say so in their own descriptions

A tool description is the only thing the model reads before deciding to call it, so the warnings live there rather than in a confirmation layer the model can route around. From `src/gmail.js`:

> *Sends an email immediately from the authorized Gmail account, optionally with file attachments. This is a real send with no draft/review step and cannot be undone.*

`calendar_create_event` and `sheets_write_range` carry equivalent warnings.

Several tools are externally visible under your real identity: `gmail_send_email` delivers to real inboxes, `calendar_create_event` with attendees emails invitations, and the YouTube comment tools post publicly. They are ordinary tools — but they're the ones where a mistake is visible to other people.

### Refreshed tokens are persisted

`googleapis` emits a `tokens` event when it silently refreshes an access token. `src/auth.js` listens and merges the result back to disk, so a long-lived session doesn't lose its refresh token across restarts.

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
npm install
npm run authorize
```

Opens a loopback listener on `localhost:53682`, prints a consent URL, and writes the refresh token to `credentials/token.json`. Google shows an "unverified app" warning — expected for a Testing-status client only you can use.

### 3. Register with Claude Code

```bash
claude mcp add google-workspace --scope user -- node /absolute/path/to/google-workspace-mcp/src/index.js
```

Then `claude mcp list` to confirm it connected.

## Tools

**Gmail**

| Tool | Purpose |
|---|---|
| `gmail_send_email` | Send a real message — delivered immediately, not a draft |
| `gmail_create_draft` | Compose without sending |
| `gmail_list_drafts` | List existing drafts |

**Calendar**

| Tool | Purpose |
|---|---|
| `calendar_list_events` | Events in a time range |
| `calendar_create_event` | Create an event, optionally with attendees |
| `calendar_update_event` | Modify an existing event |
| `calendar_delete_event` | Remove an event |

**Drive / Sheets**

| Tool | Purpose |
|---|---|
| `drive_create_file` | Create a file in Drive |
| `sheets_read_range` | Read an A1-notation range |
| `sheets_write_range` | Write an A1-notation range |

**YouTube**

| Tool | Purpose |
|---|---|
| `youtube_search` | Search videos, channels, playlists |
| `youtube_get_video` / `youtube_get_channel` | Metadata and statistics |
| `youtube_list_playlists` / `youtube_list_playlist_items` | Playlist contents |
| `youtube_create_playlist` / `youtube_add_to_playlist` | Build playlists |
| `youtube_get_comments` / `youtube_post_comment` / `youtube_reply_to_comment` | Comment threads |
| `youtube_rate_video` | Like / dislike / clear |
| `youtube_list_subscriptions` / `youtube_subscribe` | Subscriptions |

## Layout

```
src/auth.js            OAuth client construction, token load/refresh persistence
src/gmail.js           MIME assembly (incl. base64 attachments) + gmail_* tools
src/calendar.js        calendar_* tools
src/drive.js           drive_* tools
src/sheets.js          sheets_* tools
src/youtube.js         youtube_* tools
src/index.js           McpServer construction + stdio transport
scripts/authorize.js   one-time / periodic OAuth consent flow
scripts/check-token.js token health check
scripts/smoke-test.js  end-to-end check across the API surfaces
test/tools.test.js     schema + MIME tests — no network, no credentials
```

## Tests

```bash
npm test
```

Exercises the tool registry and the MIME builder only: no network, no credentials, safe in CI. Asserts that all 23 tools register under unique names, that registration never eagerly reaches for a token, that the tools capable of irreversible external side effects declare that in their descriptions, and that Gmail MIME assembly produces well-formed multipart messages with RFC 2045 line wrapping and base64url encoding.

## Auth files

Both live in `credentials/`, which is git-ignored:

- `client_secret.json` — the OAuth client, downloaded from Google Cloud Console
- `token.json` — access + refresh tokens, written by `npm run authorize`

Neither has ever been committed. If `credentials/` is lost, re-download the client secret and re-run `npm run authorize`.

## Notes

- Depends on `googleapis`, which is heavy (~109 MB of the ~126 MB `node_modules`). That is the package, not a mistake.
- Scopes are requested up front at authorize time. Adding a new API later means re-running `npm run authorize` so the new scope is granted.
- `package.json` pins an **override** of `gaxios` to `^7.3.0`. `googleapis-common` still resolves an older `gaxios`, which drags in `rimraf → glob → minimatch → brace-expansion` and a high-severity DoS advisory. The override is what takes `npm audit` to zero; removing it silently reintroduces six high-severity findings and ~37 packages. Drop it once `googleapis-common` ships a newer `gaxios` itself.

## Privacy policy

Google requires a published policy on the consent screen even for a Testing-status app: [brettadams0.github.io/google-workspace-mcp-policy](https://brettadams0.github.io/google-workspace-mcp-policy/) ([source](https://github.com/brettadams0/google-workspace-mcp-policy)).

## License

MIT — see [LICENSE](LICENSE).
