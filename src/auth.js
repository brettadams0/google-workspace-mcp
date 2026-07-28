import { google } from 'googleapis';
import { readFile, writeFile } from 'node:fs/promises';
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

export async function getAuthorizedClient() {
  if (cachedClient) return cachedClient;

  const { client_id, client_secret } = await loadClientSecret();
  const tokenRaw = await readFile(TOKEN_PATH, 'utf-8').catch(() => {
    throw new Error(`No token found at ${TOKEN_PATH}. Run "npm run authorize" first.`);
  });
  const token = JSON.parse(tokenRaw);

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret);
  oAuth2Client.setCredentials(token);

  oAuth2Client.on('tokens', (newTokens) => {
    const merged = { ...token, ...newTokens };
    writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2)).catch((err) => {
      console.error('Failed to persist refreshed Google token:', err);
    });
  });

  cachedClient = oAuth2Client;
  return cachedClient;
}
