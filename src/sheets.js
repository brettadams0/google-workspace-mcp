import { google } from 'googleapis';
import { z } from 'zod';

export async function readRange(auth, { spreadsheetId, range }) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values ?? [];
}

export async function writeRange(auth, { spreadsheetId, range, values }) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  return res.data;
}

export function registerSheetsTools(server, getClient) {
  server.registerTool(
    'sheets_read_range',
    {
      title: 'Read Sheets range',
      description: 'Reads cell values from a range in a Google Sheet (e.g. range "Sheet1!A1:C10").',
      inputSchema: {
        spreadsheetId: z
          .string()
          .describe('Spreadsheet id — the long string between "/d/" and "/edit" in the sheet URL. Not the sheet name.'),
        range: z
          .string()
          .describe('A1 notation range, e.g. "Sheet1!A1:C10", or a bare sheet name like "Sheet1" for all data. Quote sheet names containing spaces: "\'My Sheet\'!A1:B2".'),
      },
    },
    async ({ spreadsheetId, range }) => {
      const auth = await getClient();
      const values = await readRange(auth, { spreadsheetId, range });
      return { content: [{ type: 'text', text: JSON.stringify(values, null, 2) }] };
    }
  );

  server.registerTool(
    'sheets_write_range',
    {
      title: 'Write Sheets range',
      description:
        'Writes cell values into a range in a Google Sheet immediately, overwriting existing content in that range. No confirmation step.',
      inputSchema: {
        spreadsheetId: z
          .string()
          .describe('Spreadsheet id — the long string between "/d/" and "/edit" in the sheet URL. Not the sheet name.'),
        range: z
          .string()
          .describe('A1 notation range to write into, e.g. "Sheet1!A1". The written block extends right and down from the start cell, overwriting whatever is there.'),
        values: z
          .array(z.array(z.union([z.string(), z.number(), z.boolean()])))
          .describe('Rows of cell values, outer array = rows, inner = columns. e.g. [["Name","Score"],["Ada",91]].'),
      },
    },
    async ({ spreadsheetId, range, values }) => {
      const auth = await getClient();
      const result = await writeRange(auth, { spreadsheetId, range, values });
      return { content: [{ type: 'text', text: `Updated ${result.updatedCells} cells in ${result.updatedRange}` }] };
    }
  );
}
