import { randomBytes } from 'node:crypto';
import { gmail as gmailApi } from '@googleapis/gmail';
import { z } from 'zod';
import { apiOptions, json, text } from './shared.js';

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// type/subtype with optional `; key=value` parameters, values a token or a
// quoted string. multipart/* and message/* are excluded: they cannot be sent
// base64-encoded (RFC 2045 §6.4), and a multipart needs a boundary we'd own.
const MIME_TYPE = /^(?!multipart\/|message\/)[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=(?:[\w.+-]+|"[^"\\]*"))*$/i;

/**
 * Refuse a header value containing a line break.
 *
 * Header values are interpolated into the message, so a CR or LF ends the
 * header and starts a new one: a subject of "Hi\r\nBcc: someone@example.com"
 * would quietly copy the mail to a stranger. Tool arguments are model output,
 * and model output can carry prompt-injected text, so this is an error rather
 * than something to strip and carry on from.
 */
function headerSafe(field, value) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain line breaks.`);
  }
  return value;
}

/**
 * Encode a header value for transport (RFC 2047).
 *
 * Headers are 7-bit ASCII, so anything else travels as "encoded words", one
 * per folded line. A line holding an encoded word may run to 76 characters, and
 * the first one also carries the field name ("Subject: "), so each word holds
 * at most 39 bytes of UTF-8: 52 characters of base64, 64 with its wrapper. A
 * word must not split a multi-byte character, hence chunking by code point.
 */
export function encodeHeaderValue(value) {
  if (PRINTABLE_ASCII.test(value)) return value;

  const chunks = [];
  let chunk = '';
  for (const char of value) {
    if (chunk && Buffer.byteLength(chunk + char) > 39) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);

  // Folded with CRLF + space, which a reader unfolds back into one line.
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c).toString('base64')}?=`).join('\r\n ');
}

/** `name=` and `filename=` parameters for an attachment, safe for any file name. */
function filenameParams(filename) {
  headerSafe('Attachment filename', filename);
  if (PRINTABLE_ASCII.test(filename)) {
    const quoted = `"${filename.replace(/[\\"]/g, '\\$&')}"`;
    return { name: `name=${quoted}`, filename: `filename=${quoted}` };
  }
  // RFC 2231 is the standard form for a non-ASCII filename; the RFC 2047 `name`
  // is what older clients look at instead. Percent-encoding triples the length,
  // so the value is split into numbered continuations (filename*0*=, *1*=, …)
  // on folded lines, never inside a %XX escape, to stay within line limits.
  const extended = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  const segments = [''];
  for (const unit of extended.match(/%[0-9A-F]{2}|[^%]/g)) {
    if (segments.at(-1).length + unit.length > 54) segments.push('');
    segments[segments.length - 1] += unit;
  }
  return {
    name: `name="${encodeHeaderValue(filename)}"`,
    filename: segments
      .map((segment, i) => `filename*${i}*=${i === 0 ? "UTF-8''" : ''}${segment}`)
      .join(';\r\n '),
  };
}

/** Wrap base64 at 76 characters per line (RFC 2045). */
function base64Wrap(base64) {
  return base64.match(/.{1,76}/g)?.join('\r\n') ?? base64;
}

/**
 * Normalise attachment content supplied by the caller.
 *
 * Models produce base64 wrapped across lines, or in the URL-safe alphabet,
 * often enough to accept both. Anything else is refused: Gmail would accept it
 * and deliver a corrupt attachment, which is worse than an error. Spaces and
 * tabs are refused rather than stripped, since base64 never contains them and
 * they are the usual sign of plain text passed where base64 was expected.
 */
function normaliseBase64(content, filename) {
  const invalid = () => new Error(`Attachment "${filename}" content is not valid base64.`);
  const compact = content.replace(/\r?\n/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const match = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(compact);
  if (!match) throw invalid();
  const [, data, padding] = match;
  // A final group of one character is never valid, and padding, when present,
  // must complete the last group exactly.
  if (data.length % 4 === 1) throw invalid();
  if (padding && (data.length + padding.length) % 4 !== 0) throw invalid();
  // Round-trip to restore any padding the caller dropped.
  return Buffer.from(compact, 'base64').toString('base64');
}

/**
 * A text body part. Bodies are base64-encoded rather than sent as raw 8-bit:
 * generated HTML is frequently one very long line, and SMTP limits lines to
 * 998 octets, so a relay is entitled to break it somewhere inside a tag.
 */
function textPart(mimeType, content) {
  return [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrap(Buffer.from(content ?? '', 'utf8').toString('base64')),
  ].join('\r\n');
}

function attachmentPart(attachment) {
  const filename = attachment.filename || 'attachment';
  const mimeType = attachment.mimeType || 'application/octet-stream';
  if (!MIME_TYPE.test(mimeType)) {
    throw new Error(`Attachment "${filename}" has an invalid MIME type: ${JSON.stringify(mimeType)}`);
  }
  const params = filenameParams(filename);
  return [
    `Content-Type: ${mimeType};\r\n ${params.name}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment;\r\n ${params.filename}`,
    '',
    base64Wrap(normaliseBase64(attachment.content, filename)),
  ].join('\r\n');
}

/**
 * Join parts under a fresh random boundary. A boundary must never occur inside
 * a part; with every part base64-encoded and the boundary containing `_`,
 * which base64 does not use, it cannot.
 */
function multipart(subtype, parts) {
  const boundary = `mcp_${subtype}_${randomBytes(12).toString('hex')}`;
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    '',
    ...parts.flatMap((part) => [`--${boundary}`, part]),
    `--${boundary}--`,
  ].join('\r\n');
}

/** Assemble an RFC 5322 message and encode it as base64url for Gmail's `raw` field. */
export function buildRawMessage({ to, cc, bcc, subject, body, htmlBody, attachments }) {
  const addresses = (field, list) => list.map((a) => headerSafe(field, a)).join(', ');

  const headers = [
    `To: ${addresses('To', to)}`,
    cc?.length ? `Cc: ${addresses('Cc', cc)}` : null,
    bcc?.length ? `Bcc: ${addresses('Bcc', bcc)}` : null,
    `Subject: ${encodeHeaderValue(headerSafe('Subject', subject))}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  const content = htmlBody
    ? multipart('alternative', [textPart('text/plain', body), textPart('text/html', htmlBody)])
    : textPart('text/plain', body);

  const message = attachments?.length
    ? multipart('mixed', [content, ...attachments.map(attachmentPart)])
    : content;

  return Buffer.from([...headers, message].join('\r\n')).toString('base64url');
}

export async function sendEmail(auth, params) {
  const gmail = gmailApi({ version: 'v1', ...apiOptions(auth) });
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: buildRawMessage(params) } });
  return res.data;
}

export async function createDraft(auth, params) {
  const gmail = gmailApi({ version: 'v1', ...apiOptions(auth) });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: buildRawMessage(params) } },
  });
  return res.data;
}

export async function listDrafts(auth, { maxResults = 10 } = {}) {
  const gmail = gmailApi({ version: 'v1', ...apiOptions(auth) });
  const res = await gmail.users.drafts.list({ userId: 'me', maxResults });
  return res.data.drafts ?? [];
}

export function registerGmailTools(server, getClient) {
  const attachmentShape = z.object({
    filename: z.string().describe('Attachment file name including extension, e.g. "report.pdf".'),
    mimeType: z.string().optional().describe('MIME type, e.g. "application/pdf". Defaults to application/octet-stream.'),
    content: z.string().describe('Base64-encoded file content'),
  });

  const emailShape = {
    to: z.array(z.string().email()).min(1).describe('Recipient email addresses. At least one required.'),
    cc: z.array(z.string().email()).optional().describe('Carbon-copy recipients.'),
    bcc: z.array(z.string().email()).optional().describe('Blind carbon-copy recipients — not visible to other recipients.'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('Plain-text body. Also the fallback part when htmlBody is given.'),
    htmlBody: z.string().optional().describe('Optional HTML body, sent alongside body as multipart/alternative.'),
    attachments: z.array(attachmentShape).optional().describe('Files to attach.'),
  };

  server.registerTool(
    'gmail_send_email',
    {
      title: 'Send Gmail email',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Sends an email immediately from the authorized Gmail account, optionally with file attachments. This is a real send with no draft/review step and cannot be undone.',
      inputSchema: emailShape,
    },
    async (params) => {
      const data = await sendEmail(await getClient(), params);
      return text(`Sent. Message ID: ${data.id}`);
    }
  );

  server.registerTool(
    'gmail_create_draft',
    {
      title: 'Create Gmail draft',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Creates a draft email, optionally with file attachments, that a human must open and send manually from Gmail.',
      inputSchema: emailShape,
    },
    async (params) => {
      const data = await createDraft(await getClient(), params);
      return text(`Draft created. Draft ID: ${data.id}`);
    }
  );

  server.registerTool(
    'gmail_list_drafts',
    {
      title: 'List Gmail drafts',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Lists existing draft emails in the authorized Gmail account.',
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional().describe('Maximum drafts to return, 1-50. Defaults to 10.'),
      },
    },
    async ({ maxResults }) => json(await listDrafts(await getClient(), { maxResults }))
  );
}
