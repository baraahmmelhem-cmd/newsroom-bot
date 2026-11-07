// WhatsApp delivery through a linked device (Baileys).
// First run: "pair" prints an 8-character code; the user types it in
// WhatsApp > Linked devices > Link a device > Link with phone number.
// The session is saved in ./wa-session (encrypted by the workflow).

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, Browsers, delay
} = require('@whiskeysockets/baileys');

const SESSION_DIR = path.join(__dirname, '..', 'wa-session');
const logger = pino({ level: process.env.WA_LOG || 'silent' });

function phoneDigits() {
  const p = (process.env.WHATSAPP_PHONE || '').replace(/\D/g, '');
  if (!p) throw new Error('WHATSAPP_PHONE secret is missing (digits with country code, e.g. 9627XXXXXXXX)');
  return p;
}

// Opens a connection and resolves with the socket once it is "open".
// Handles the restart WhatsApp forces right after pairing.
function connect({ pairing } = {}) {
  return new Promise(async (resolve, reject) => {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version, auth: state, logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });
    sock.ev.on('creds.update', saveCreds);

    if (pairing && !state.creds.registered) {
      await delay(2500);
      try {
        const code = await sock.requestPairingCode(phoneDigits());
        const pretty = code.match(/.{1,4}/g).join('-');
        console.log('\n==============================================');
        console.log('  رمز الربط / PAIRING CODE:  ' + pretty);
        console.log('  WhatsApp > Linked devices > Link a device > Link with phone number');
        console.log('==============================================\n');
      } catch (e) { reject(new Error('requestPairingCode failed: ' + e.message)); return; }
    }

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open') { console.log('[wa] connected'); resolve(sock); }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log('[wa] connection closed, status', code);
        if (code === DisconnectReason.loggedOut) {
          reject(new Error('WhatsApp logged this device out. Delete the session and run pair again.'));
        } else if (code === DisconnectReason.restartRequired || code === 515 || (pairing && code !== DisconnectReason.loggedOut)) {
          console.log('[wa] restarting connection...');
          connect({ pairing: false }).then(resolve, reject);
        } else {
          reject(new Error('connection closed with status ' + code));
        }
      }
    });
  });
}

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms))]);
}

function hasSession() {
  return fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
}

async function sendToSelf({ imagePath, caption, text }) {
  if (!hasSession()) throw new Error('No WhatsApp session yet. Run the workflow with mode=pair first.');
  const sock = await withTimeout(connect({ pairing: false }), 120000, 'WhatsApp connection');
  const jid = phoneDigits() + '@s.whatsapp.net';
  await delay(1500);
  if (imagePath) {
    await sock.sendMessage(jid, { image: fs.readFileSync(imagePath), caption: caption || '' });
  } else {
    await sock.sendMessage(jid, { text: text || '' });
  }
  console.log('[wa] message sent to self chat');
  await delay(4000); // let the server ack before closing
  sock.end(undefined);
}

async function pair() {
  if (hasSession()) { console.log('[wa] session already exists; verifying connection'); }
  const sock = await withTimeout(connect({ pairing: true }), 240000, 'pairing (enter the code within 4 minutes)');
  const jid = phoneDigits() + '@s.whatsapp.net';
  await delay(3000);
  await sock.sendMessage(jid, { text: 'تم ربط تقرير MR_AMWAL الصباحي بنجاح. سيصلك التقرير يومياً الساعة 7:00 صباحاً.' });
  console.log('[wa] pairing complete, confirmation sent');
  await delay(4000);
  sock.end(undefined);
}

module.exports = { sendToSelf, pair, hasSession };
