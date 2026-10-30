import { gmail as gmailApi } from '@googleapis/gmail';
import { getAuthorizedClient } from '../src/auth.js';
import { sendEmail } from '../src/gmail.js';
import { apiOptions } from '../src/shared.js';

async function main() {
  const auth = await getAuthorizedClient();
  // Send to the authorized account itself, whoever that is.
  const profile = await gmailApi({ version: 'v1', ...apiOptions(auth) }).users.getProfile({ userId: 'me' });
  const result = await sendEmail(auth, {
    to: [profile.data.emailAddress],
    subject: 'google-workspace-mcp smoke test',
    body: 'If you are reading this in your inbox, Gmail send via the custom MCP server works end to end.',
  });
  console.log('Sent. Message ID:', result.id);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
