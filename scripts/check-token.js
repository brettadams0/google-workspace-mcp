import { getAuthorizedClient } from '../src/auth.js';
import { google } from 'googleapis';

async function main() {
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  console.log(`OK: ${profile.data.emailAddress}`);
}

main().catch((err) => {
  console.error(`EXPIRED_OR_MISSING: ${err.message}`);
  process.exit(1);
});
