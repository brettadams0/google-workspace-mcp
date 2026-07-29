import { google } from 'googleapis';
import { z } from 'zod';

function base64Wrap(base64) {
  return base64.match(/.{1,76}/g)?.join('\r\n') ?? base64;
}

function buildBodyPart({ body, htmlBody }) {
  if (!htmlBody) {
    return ['Content-Type: text/plain; charset="UTF-8"', '', body || ''].join('\r\n');
  }
  const boundary = `mcp_alt_${Date.now()}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body || '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    htmlBody,
    `--${boundary}--`,
  ].join('\r\n');
}

export function buildRawMessage({ to, cc, bcc, subject, body, htmlBody, attachments }) {
  const headers = [
    `To: ${to.join(', ')}`,
    cc?.length ? `Cc: ${cc.join(', ')}` : null,
    bcc?.length ? `Bcc: ${bcc.join(', ')}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  if (!attachments?.length) {
    const bodyPart = buildBodyPart({ body, htmlBody });
    const [contentTypeLine, ...rest] = bodyPart.split('\r\n');
    const mime = [...headers, contentTypeLine, ...rest].join('\r\n');
    return Buffer.from(mime).toString('base64url');
  }

  const mixedBoundary = `mcp_mixed_${Date.now()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

  const parts = [`--${mixedBoundary}`, buildBodyPart({ body, htmlBody })];
  for (const att of attachments) {
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename || 'attachment'}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename || 'attachment'}"`,
      '',
      base64Wrap(att.content)
    );
  }
  parts.push(`--${mixedBoundary}--`);

  const mime = [...headers, '', ...parts].join('\r\n');
  return Buffer.from(mime).toString('base64url');
}

export async function sendEmail(auth, params) {
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage(params);
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data;
}

export async function createDraft(auth, params) {
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage(params);
  const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return res.data;
}

export async function listDrafts(auth, { maxResults = 10 } = {}) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.drafts.list({ userId: 'me', maxResults });
  return res.data.drafts ?? [];
}

export function registerGmailTools(server, getClient) {
  const attachmentShape = z.object({
    filename: z.string().describe('Attachment file name including extension, e.g. "report.pdf".'),
    mimeType: z.string().optional().describe('MIME type, e.g. "application/pdf". Defaults to a generic binary type when omitted.'),
    content: z.string().describe('Base64-encoded file content'),
  });

  const emailShape = {
    to: z.array(z.string().email()).min(1).describe('Recipient email addresses. At least one required.'),
    cc: z.array(z.string().email()).optional().describe('Carbon-copy recipients.'),
    bcc: z.array(z.string().email()).optional().describe('Blind carbon-copy recipients — not visible to other recipients.'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('Plain-text body. Sent as the text/plain part, and used as the fallback when htmlBody is also supplied.'),
    htmlBody: z.string().optional().describe('Optional HTML body. When present the message is sent as multipart/alternative alongside body.'),
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
      const auth = await getClient();
      const data = await sendEmail(auth, params);
      return { content: [{ type: 'text', text: `Sent. Message ID: ${data.id}` }] };
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
      const auth = await getClient();
      const data = await createDraft(auth, params);
      return { content: [{ type: 'text', text: `Draft created. Draft ID: ${data.id}` }] };
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
    async ({ maxResults }) => {
      const auth = await getClient();
      const drafts = await listDrafts(auth, { maxResults });
      return { content: [{ type: 'text', text: JSON.stringify(drafts, null, 2) }] };
    }
  );
}
