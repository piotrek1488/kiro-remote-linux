import QRCode from 'qrcode';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qrcodeTerminal = require('qrcode-terminal') as {
  generate: (text: string, opts: { small?: boolean }, cb: (qr: string) => void) => void;
};

/**
 * Build the whole terminal message (header, QR, link) as ONE string that starts with
 * a newline. The extension prefixes every chunk of relay output with "[time] [relay] ";
 * the leading newline keeps that prefix on its own line so the QR rows stay aligned
 * and the code remains scannable, even with older extension versions.
 */
export function renderTerminalQR(url: string): string {
  let qr = '';
  qrcodeTerminal.generate(url, { small: true }, (out) => { qr = out; });
  return ['', '📱 Scan this QR code with your Android phone:', '', qr.trimEnd(), '', `🔗 Or open: ${url}`, ''].join('\n');
}

export async function printQRToTerminal(url: string): Promise<void> {
  console.log(renderTerminalQR(url));
}

export async function saveQRToPNG(url: string, outputPath: string): Promise<void> {
  await QRCode.toFile(outputPath, url, {
    type: 'png',
    width: 400,
    margin: 2,
    color: { dark: '#1a1a2e', light: '#ffffff' }
  });
}
