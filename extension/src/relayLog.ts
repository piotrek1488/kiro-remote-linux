/**
 * Format a chunk of relay stdout/stderr for the "Kiro Remote" output channel.
 * Multi-line chunks (e.g. the terminal QR code) start on their own line, otherwise
 * the "[time] [relay]" prefix shifts the first row and the QR code cannot be scanned.
 */
export function formatRelayOutput(prefix: string, data: Buffer | string): string {
  const text = data.toString().trimEnd();
  return text.includes('\n') ? `${prefix}\n${text}` : `${prefix} ${text}`;
}
