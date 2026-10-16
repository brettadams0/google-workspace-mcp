import { getAuthorizedClient } from '../src/auth.js';
import { gmail as gmailApi } from '@googleapis/gmail';
import { apiOptions } from '../src/shared.js';

async function main() {
  const auth = await getAuthorizedClient();
  const gmail = gmailApi({ version: 'v1', ...apiOptions(auth) });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  console.log(`OK: ${profile.data.emailAddress}`);
}

main().catch((err) => {
  console.error(`EXPIRED_OR_MISSING: ${err.message}`);
  process.exit(1);
});
