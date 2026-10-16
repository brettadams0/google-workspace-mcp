import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
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
  const oAuth2Client = new OAuth2Client(client_id, client_secret, REDIRECT_URI);

  // `state` ties the redirect to this run, so a page that gets the browser to
  // hit the callback with its own code can't plant a token for another
  // account. PKCE binds the code to this process, so a code intercepted on the
  // way back is useless to whoever intercepted it.
  const state = crypto.randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = await oAuth2Client.generateCodeVerifierAsync();

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  console.log('\nOpen this URL in your browser and sign in with the Google account you want the server to use:\n');
  console.log(authUrl);
  console.log('\nWaiting for the redirect back to localhost...\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.statusCode = 404;
        res.end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');

      if (error) {
        res.end('Authorization failed. Check the terminal for details.');
        server.close();
        reject(new Error(`Google returned an error: ${error}`));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.end('State mismatch. Aborting.');
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF, aborting.'));
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
    // Loopback only: the callback carries an authorization code, and nothing
    // else on the network has any business reaching it.
    server.listen(PORT, 'localhost');
  });

  const { tokens } = await oAuth2Client.getToken({ code, codeVerifier });
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Saved token to ${TOKEN_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
