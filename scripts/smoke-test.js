import { getAuthorizedClient } from '../src/auth.js';
import { sendEmail } from '../src/gmail.js';

const SELF_ADDRESS = 'adamsbrett00@gmail.com';

async function main() {
  const auth = await getAuthorizedClient();
  const result = await sendEmail(auth, {
    to: [SELF_ADDRESS],
    subject: 'google-workspace-mcp smoke test',
    body: 'If you are reading this in your inbox, Gmail send via the custom MCP server works end to end.',
  });
  console.log('Sent. Message ID:', result.id);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
