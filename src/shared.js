import { readFileSync } from 'node:fs';

/**
 * The installed package version. The server reports it in `initialize`, so it
 * is read from package.json rather than written as a literal that drifts.
 */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Upper bound on any single Google API request. Without one, a stalled
 * connection holds the tool call open until the client gives up, and the model
 * learns nothing about why.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Options shared by every Google API client this server constructs. */
export const apiOptions = (auth) => ({ auth, timeout: REQUEST_TIMEOUT_MS });

/**
 * A tool result carrying JSON. Compact rather than indented: the text goes
 * straight into the model's context, where indentation is pure token cost.
 */
export function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** A tool result carrying a short confirmation message. */
export function text(message) {
  return { content: [{ type: 'text', text: message }] };
}
