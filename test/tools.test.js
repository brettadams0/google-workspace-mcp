import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRawMessage, registerGmailTools } from '../src/gmail.js';
import { registerDriveTools } from '../src/drive.js';
import { registerCalendarTools } from '../src/calendar.js';
import { registerSheetsTools } from '../src/sheets.js';
import { registerYoutubeTools } from '../src/youtube.js';

// Collects registerTool() calls without touching the network or credentials.
// getClient is never invoked at registration time, so a throwing stub is a
// useful assertion in itself: if registration ever starts eagerly authorizing,
// these tests fail loudly instead of silently reaching for real tokens.
function collectTools() {
  const tools = new Map();
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, { name, config, handler });
    },
  };
  const getClient = () => {
    throw new Error('getClient must not be called during tool registration');
  };

  registerGmailTools(server, getClient);
  registerDriveTools(server, getClient);
  registerCalendarTools(server, getClient);
  registerSheetsTools(server, getClient);
  registerYoutubeTools(server, getClient);

  return tools;
}

function decode(raw) {
  return Buffer.from(raw, 'base64url').toString('utf-8');
}

test('every module registers its tools without needing credentials', () => {
  const tools = collectTools();
  assert.equal(tools.size, 23, `expected 23 tools, got ${tools.size}`);
});

test('tool names are unique and follow the <api>_<action> convention', () => {
  const tools = collectTools();
  const names = [...tools.keys()];

  assert.equal(new Set(names).size, names.length, 'duplicate tool name registered');

  for (const name of names) {
    assert.match(
      name,
      /^(gmail|drive|calendar|sheets|youtube)_[a-z0-9_]+$/,
      `"${name}" does not match <api>_<action>`
    );
  }
});

test('every tool declares a title, a description, and an input schema', () => {
  for (const { name, config } of collectTools().values()) {
    assert.ok(config.title?.trim(), `${name} is missing a title`);
    assert.ok(config.description?.trim(), `${name} is missing a description`);
    assert.ok(config.inputSchema, `${name} is missing an inputSchema`);
  }
});

// The tool description is the only thing the model reads before deciding to
// call a tool, so tools with irreversible external side effects must carry the
// warning in the description itself rather than relying on a confirmation layer.
test('irreversible tools warn about it in their descriptions', () => {
  const tools = collectTools();
  const irreversible = [
    'gmail_send_email',
    'calendar_create_event',
    'calendar_delete_event',
    'sheets_write_range',
  ];

  for (const name of irreversible) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is not registered`);
    assert.match(
      tool.config.description,
      /immediat|cannot be undone|no confirmation|overwrit|real send|permanent/i,
      `${name} does not warn that its effect is immediate or irreversible`
    );
  }
});

test('gmail_create_draft is described as the reviewable alternative', () => {
  const { config } = collectTools().get('gmail_create_draft');
  assert.match(config.description, /draft/i);
  assert.doesNotMatch(config.description, /cannot be undone/i);
});

test('plain-text message carries headers and a text/plain body', () => {
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com'],
      subject: 'Hello',
      body: 'Plain body',
    })
  );

  assert.match(mime, /^To: a@example\.com\r\n/);
  assert.match(mime, /\r\nSubject: Hello\r\n/);
  assert.match(mime, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime, /Plain body/);
  assert.doesNotMatch(mime, /multipart/);
});

test('multiple recipients, cc and bcc are comma-joined into their own headers', () => {
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
      subject: 'Many',
      body: 'x',
    })
  );

  assert.match(mime, /To: a@example\.com, b@example\.com/);
  assert.match(mime, /Cc: c@example\.com/);
  assert.match(mime, /Bcc: d@example\.com/);
});

test('cc and bcc headers are omitted entirely when not supplied', () => {
  const mime = decode(
    buildRawMessage({ to: ['a@example.com'], subject: 'S', body: 'x' })
  );

  assert.doesNotMatch(mime, /\r\nCc:/);
  assert.doesNotMatch(mime, /\r\nBcc:/);
});

test('supplying htmlBody produces a multipart/alternative with both parts', () => {
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com'],
      subject: 'S',
      body: 'text version',
      htmlBody: '<p>html version</p>',
    })
  );

  const boundary = mime.match(/multipart\/alternative; boundary="([^"]+)"/)?.[1];
  assert.ok(boundary, 'no multipart/alternative boundary found');
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(mime, /text version/);
  assert.match(mime, /<p>html version<\/p>/);
  // Closing delimiter must be the boundary followed by a trailing "--".
  assert.ok(mime.includes(`--${boundary}--`), 'multipart/alternative is not closed');
});

test('attachments produce a closed multipart/mixed with base64 transfer encoding', () => {
  const content = Buffer.from('hello attachment').toString('base64');
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com'],
      subject: 'S',
      body: 'see attached',
      attachments: [{ filename: 'note.txt', mimeType: 'text/plain', content }],
    })
  );

  const boundary = mime.match(/multipart\/mixed; boundary="([^"]+)"/)?.[1];
  assert.ok(boundary, 'no multipart/mixed boundary found');
  assert.match(mime, /Content-Disposition: attachment; filename="note\.txt"/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  assert.match(mime, /Content-Type: text\/plain; name="note\.txt"/);
  assert.ok(mime.includes(`--${boundary}--`), 'multipart/mixed is not closed');
  assert.ok(mime.includes(content), 'attachment payload missing from message');
});

test('attachments fall back to sane defaults for filename and mimeType', () => {
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com'],
      subject: 'S',
      body: 'x',
      attachments: [{ content: Buffer.from('data').toString('base64') }],
    })
  );

  assert.match(mime, /Content-Type: application\/octet-stream; name="attachment"/);
  assert.match(mime, /filename="attachment"/);
});

// Gmail rejects base64 payloads on excessively long lines, so the builder wraps
// them at 76 characters per RFC 2045.
test('long attachment payloads are wrapped at 76 characters', () => {
  const content = Buffer.from('x'.repeat(500)).toString('base64');
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com'],
      subject: 'S',
      body: 'x',
      attachments: [{ filename: 'big.bin', content }],
    })
  );

  const payloadLines = mime
    .split('\r\n')
    .filter((line) => /^[A-Za-z0-9+/=]{20,}$/.test(line));

  assert.ok(payloadLines.length > 1, 'payload was not wrapped across lines');
  for (const line of payloadLines) {
    assert.ok(line.length <= 76, `line of ${line.length} chars exceeds the 76-char limit`);
  }
});

test('the encoded message is base64url — safe for the Gmail raw field', () => {
  const raw = buildRawMessage({
    to: ['a@example.com'],
    subject: 'Subject with + and / characters',
    body: '?'.repeat(40),
  });

  assert.doesNotMatch(raw, /[+/]/, 'raw contains standard-base64 characters');
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
});
