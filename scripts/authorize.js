import { google } from 'googleapis';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadClientSecret, CREDENTIALS_DIR, TOKEN_PATH } from '../src/auth.js';

// Deliberately excludes gmail.readonly and drive.readonly — those are Google
// "Restricted" scopes requiring a paid CASA security assessment, which isn't
// worth it for a personal single-user tool. Reading Gmail/Drive is handled by
// the existing claude.ai connectors instead; this server only needs write access.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

async function main() {
  const { client_id, client_secret } = await loadClientSecret();
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\nOpen this URL in your browser and sign in with the Google account you want the server to use:\n');
  console.log(authUrl);
  console.log('\nWaiting for the redirect back to localhost...\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');

      if (error) {
        res.end('Authorization failed. Check the terminal for details.');
        server.close();
        reject(new Error(`Google returned an error: ${error}`));
        return;
      }
      if (code) {
        res.end('Authorized! You can close this tab and return to the terminal.');
        server.close();
        resolve(code);
        return;
      }
      res.end('Waiting for authorization...');
    });
    server.listen(PORT);
  });

  const { tokens } = await oAuth2Client.getToken(code);
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`Saved token to ${TOKEN_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
