import { drive as driveApi } from '@googleapis/drive';
import { z } from 'zod';
import { apiOptions, text } from './shared.js';

export async function createFile(auth, { name, content, mimeType = 'text/plain', parentFolderId }) {
  const drive = driveApi({ version: 'v3', ...apiOptions(auth) });
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Creates a new file in Google Drive with the given text content. Scoped to drive.file: it can only manage files it created itself, and cannot read or edit pre-existing Drive files.',
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
      const file = await createFile(await getClient(), { name, content, mimeType, parentFolderId });
      return text(`Created: ${file.name} (${file.id})\n${file.webViewLink ?? ''}`);
    }
  );
}
