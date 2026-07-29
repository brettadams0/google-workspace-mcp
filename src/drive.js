import { google } from 'googleapis';
import { z } from 'zod';

export async function createFile(auth, { name, content, mimeType = 'text/plain', parentFolderId }) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: { name, parents: parentFolderId ? [parentFolderId] : undefined },
    media: { mimeType, body: content },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

export function registerDriveTools(server, getClient) {
  server.registerTool(
    'drive_create_file',
    {
      title: 'Create Drive file',
      description:
        'Creates a new file in Google Drive with the given text content. Scoped to drive.file (least privilege, avoids Google\'s restricted-scope security review) — it can only create and later manage files it creates itself, not read or edit pre-existing Drive files. Use the claude.ai Drive connector for reading arbitrary existing files.',
      inputSchema: {
        name: z.string().describe('File name including extension, e.g. "notes.md". Drive allows duplicate names in the same folder.'),
        content: z.string().describe('File contents as plain text.'),
        mimeType: z
          .string()
          .optional()
          .describe('MIME type, e.g. "text/plain", "text/markdown", "text/csv". Use "application/vnd.google-apps.document" to create a Google Doc. Defaults to "text/plain".'),
        parentFolderId: z
          .string()
          .optional()
          .describe('Id of the destination folder — the string after "/folders/" in its URL. Omit to create in My Drive root.'),
      },
    },
    async ({ name, content, mimeType, parentFolderId }) => {
      const auth = await getClient();
      const file = await createFile(auth, { name, content, mimeType, parentFolderId });
      return { content: [{ type: 'text', text: `Created: ${file.name} (${file.id})\n${file.webViewLink ?? ''}` }] };
    }
  );
}
