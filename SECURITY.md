# Security

This server holds an OAuth refresh token that can send email, edit calendars,
write spreadsheets and post to YouTube as the account that authorized it.

## Threat model

The caller is your own MCP client, but the *arguments* come from a model, and a
model can be steered by text it has read — a web page, an email, a document.
The server therefore treats every argument as untrusted input:

- Values that end up in email headers may not contain line breaks.
- Spreadsheet writes do not evaluate formulas unless explicitly asked to.
- Tools with external, irreversible effects say so in their descriptions and
  declare MCP annotations, so a client can require confirmation for them.

The tests in `test/tools.test.js` cover each of these.

Credentials live in `credentials/`, which is git-ignored, and CI fails if a
real credential file is ever tracked.

## Reporting a vulnerability

Please email **adamsbrett00@gmail.com** rather than opening a public issue.
You'll get a reply within a few days.
