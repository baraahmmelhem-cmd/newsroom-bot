// WhatsApp delivery through a linked device (Baileys).
// "pair": prints an 8-character code; the user types it in
// WhatsApp > Linked devices > Link a device > Link with phone number.
// A code expires after ~2 minutes; pair mode then prints a fresh one,
// for up to PAIR_WINDOW_MS in total.
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
const PAIR_WINDOW_MS = 9 * 60 * 1000;
const logger = pino({ level: process.env.WA_LOG || 'silent' });

function phoneDigits() {
  const p = (process.env.WHATSAPP_PHONE || '').replace(/\D/g, '');
  if (!p) throw new Error('WHATSAPP_PHONE secret is missing (digits with country code, e.g. 9627XXXXXXXX)');
  return p;
}

function hasSession() {
  return fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
}

function isRegistered() {
  try { return !!JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'creds.json'), 'utf8')).registered; }
  catch { return false; }
}

function wipeSession() {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
}

// One connection attempt. Resolves with the socket when "open".
// Rejects with an Error carrying .code (the WhatsApp status) when closed.
async function connectOnce({ pairing }) {
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
  sock.__saveCreds = saveCreds;

  return new Promise(async (resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open') { console.log('[wa] connected'); done(resolve, sock); }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log('[wa] connection closed, status', code);
        const err = new Error('connection closed with status ' + code);
        err.code = code;
        done(reject, err);
      }
    });

    if (pairing && !state.creds.registered) {
      await delay(2500);
      try {
        const code = await sock.requestPairingCode(phoneDigits());
        const pretty = code.match(/.{1,4}/g).join('-');
        console.log('\n==============================================');
        console.log('  رمز الربط / PAIRING CODE:  ' + pretty);
        console.log('  WhatsApp > Linked devices > Link a device > Link with phone number');
        console.log('  (valid for about 2 minutes; a new code is printed if it expires)');
        console.log('==============================================\n');
      } catch (e) { done(reject, new Error('requestPairingCode failed: ' + e.message)); }
    }
  });
}

// Connects with an existing, registered session (daily send).
async function connectExisting() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await connectOnce({ pairing: false }); }
    catch (e) {
      if (e.code === DisconnectReason.loggedOut) throw new Error('WhatsApp logged this device out. Run the workflow with mode=pair again.');
      if (e.code === DisconnectReason.restartRequired || e.code === 515) { console.log('[wa] restart required, reconnecting'); continue; }
      if (attempt < 3) { console.log('[wa] retrying...'); await delay(3000); continue; }
      throw e;
    }
  }
}

// Pairing flow: keep issuing codes until the phone links or the window ends.
async function connectPairing() {
  const deadline = Date.now() + PAIR_WINDOW_MS;
  if (hasSession() && !isRegistered()) wipeSession();
  while (Date.now() < deadline) {
    try {
      return await connectOnce({ pairing: !isRegistered() });
    } catch (e) {
      if (isRegistered()) {
        // The phone accepted the code; WhatsApp forces a restart right after pairing.
        console.log('[wa] paired, reconnecting with the new session');
        await delay(2000);
        return await connectExisting();
      }
      // Not registered yet: the code expired or was rejected. Start clean with a new code.
      console.log('[wa] code expired or not accepted (status ' + e.code + '); issuing a new code');
      wipeSession();
      await delay(1500);
    }
  }
  throw new Error('Pairing window ended without linking. Run pair again and enter the code within 2 minutes.');
}

async function sendToSelf({ imagePath, caption, text }) {
  if (!hasSession() || !isRegistered()) throw new Error('No WhatsApp session yet. Run the workflow with mode=pair first.');
  const sock = await connectExisting();
  const jid = phoneDigits() + '@s.whatsapp.net';
  await delay(1500);
  if (imagePath) {
    await sock.sendMessage(jid, { image: fs.readFileSync(imagePath), caption: caption || '' });
  } else {
    await sock.sendMessage(jid, { text: text || '' });
  }
  console.log('[wa] message sent to self chat');
  // Give WhatsApp time to ack and Baileys time to write every new key to disk, then save once more.
  // Closing too fast leaves the saved keys older than the phone's, and later messages arrive locked.
  await delay(10000);
  try { await sock.__saveCreds(); } catch (e) { console.log('[wa] final save failed', e.message); }
  sock.end(undefined);
  await delay(3000);
}

async function pair() {
  const sock = await connectPairing();
  const jid = phoneDigits() + '@s.whatsapp.net';
  await delay(3000);
  await sock.sendMessage(jid, { text: 'تم ربط تقرير MR_AMWAL الصباحي بنجاح. سيصلك التقرير يومياً الساعة 7:00 صباحاً.' });
  console.log('[wa] pairing complete, confirmation sent');
  await delay(4000);
  sock.end(undefined);
}

module.exports = { sendToSelf, pair, hasSession };
