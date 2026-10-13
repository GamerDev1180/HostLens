import QRCode from 'qrcode';
import type { PairingCodeResponse } from './types.ts';

/** "ABCDEFGH" → "ABCD-EFGH", easier to read and type. */
export const formatCode = (code: string) => code.replace(/^(.{4})(.{4})$/, '$1-$2');

/** Prints a pairing QR code with the code and where it points. */
export async function printPairing(pairing: PairingCodeResponse) {
    const qr = await QRCode.toString(pairing.link, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
    const minutes = Math.round((Date.parse(pairing.expiresAt) - Date.now()) / 60_000);
    console.log('');
    console.log('  Scan with the HostLens app to pair a device:');
    console.log(qr.replace(/^/gm, '  '));
    console.log(`  Code: ${formatCode(pairing.code)}   (works once, expires in ${minutes} min)`);
    console.log(`  Address: ${pairing.urls.join(', ')}`);
    if (pairing.localOnly) {
        console.log('');
        console.log('  Only this computer can connect: the agent listens on 127.0.0.1.');
        console.log('  To pair a phone, restart it with HOSTLENS_HOST=0.0.0.0 (trusted networks only).');
    }
    console.log('');
}
