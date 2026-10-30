import { OAuth2Client } from 'google-auth-library';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CREDENTIALS_DIR = path.join(__dirname, '..', 'credentials');
export const CLIENT_SECRET_PATH = path.join(CREDENTIALS_DIR, 'client_secret.json');
export const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'token.json');

export async function loadClientSecret() {
  const raw = await readFile(CLIENT_SECRET_PATH, 'utf-8').catch(() => {
    throw new Error(
      `Missing ${CLIENT_SECRET_PATH}. Download the OAuth client secret JSON from Google Cloud Console and save it there.`
    );
  });
  const parsed = JSON.parse(raw);
  return parsed.installed ?? parsed.web;
}

let cachedClient = null;

/**
 * Write the token file readable by its owner only. `writeFile`'s `mode` applies
 * only when it creates the file, so a token.json left at 0644 by an earlier
 * version is tightened explicitly: the refresh token in it can send mail as
 * the account.
 */
export async function saveToken(token) {
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600);
}

export async function getAuthorizedClient() {
  if (cachedClient) return cachedClient;

  const { client_id, client_secret } = await loadClientSecret();
  const tokenRaw = await readFile(TOKEN_PATH, 'utf-8').catch(() => {
    throw new Error(`No token found at ${TOKEN_PATH}. Run "npm run authorize" first.`);
  });
  const token = JSON.parse(tokenRaw);

  const oAuth2Client = new OAuth2Client(client_id, client_secret);
  oAuth2Client.setCredentials(token);

  // Google refreshes the access token silently and announces it here. Merge it
  // back to disk so a long-lived session doesn't lose the refresh token, which
  // Google only sends once.
  oAuth2Client.on('tokens', (newTokens) => {
    Object.assign(token, newTokens);
    saveToken(token).catch((err) => {
      console.error('Failed to persist refreshed Google token:', err);
    });
  });

  cachedClient = oAuth2Client;
  return cachedClient;
}
