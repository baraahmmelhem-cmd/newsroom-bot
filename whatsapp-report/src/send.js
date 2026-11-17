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


// ---- GREEN-API delivery (preferred) ----
// The WhatsApp link lives on GREEN-API's servers and stays connected, so messages never arrive locked.
// Baileys below is only a fallback when GREENAPI_API_TOKEN is missing.
const GREEN_ID = process.env.GREENAPI_ID_INSTANCE || '710722798836';
const GREEN_HOST = process.env.GREENAPI_URL || 'https://7107.api.greenapi.com';
// Destination: the owner's WhatsApp group «وين المصادر ؟» (owner decision, 14 Nov). Its id is looked up by name
// through GREEN-API (no id needs to be stored). Set WHATSAPP_CHAT_ID to force a chat id; if the group
// cannot be found, messages fall back to the owner's own number.
const GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || 'وين المصادر';
let _target;
function arNorm(s) {
  return String(s || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069«»"'.,:!؟?\-_|]/g, '')
    .replace(/[\u064b-\u0652\u0640]/g, '')          // harakat + tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')                // emoji and symbols
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
async function greenTarget() {
  if (_target) return _target;
  if (process.env.WHATSAPP_CHAT_ID) return (_target = process.env.WHATSAPP_CHAT_ID);
  const base = GREEN_HOST + '/waInstance' + GREEN_ID;
  const token = process.env.GREENAPI_API_TOKEN;
  const want = arNorm(GROUP_NAME);
  const hit = name => { const n = arNorm(name); return n && (n === want || n.includes(want)); };
  let groups = [];
  for (const method of ['getContacts', 'getChats']) {
    try {
      const r = await fetch(base + '/' + method + '/' + token, { signal: AbortSignal.timeout(30000) });
      const list = await r.json();
      const gs = (Array.isArray(list) ? list : []).filter(c => String(c.id || '').endsWith('@g.us'));
      const g = gs.find(c => hit(c.name) || hit(c.contactName) || hit(c.subject));
      if (g) { console.log('[green] destination: group ' + g.id); return (_target = g.id); }
      if (gs.length > groups.length) groups = gs;
    } catch (e) { console.log('[green] ' + method + ' failed: ' + e.message); }
  }
  console.log('[green] group names seen: ' + groups.slice(0, 60).map(c => c.name || '(no name)').join(' | '));
  // Names are missing for some groups in the contact list: ask each group's subject.
  for (const c of groups.filter(c => !c.name).slice(0, 70)) {
    try {
      const r = await fetch(base + '/getGroupData/' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: c.id }), signal: AbortSignal.timeout(20000)
      });
      const d = await r.json();
      if (hit(d.subject)) { console.log('[green] destination: group ' + c.id + ' (found by subject)'); return (_target = c.id); }
    } catch (e) { /* keep looking */ }
    await delay(400);
  }
  // Owner rule (17 Nov): never send to the private number. If the group cannot be found, send nothing.
  throw new Error('WhatsApp group not found; nothing sent (never to the private number)');
}

function greenOn() { return !!process.env.GREENAPI_API_TOKEN; }
async function greenSend({ imagePath, caption, text }) {
  const token = process.env.GREENAPI_API_TOKEN;
  const chatId = await greenTarget();
  const base = GREEN_HOST + '/waInstance' + GREEN_ID;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      let res;
      if (imagePath) {
        const ext = path.extname(imagePath).toLowerCase();
        const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
        const fd = new FormData();
        fd.append('chatId', chatId);
        fd.append('caption', caption || '');
        fd.append('file', new Blob([fs.readFileSync(imagePath)], { type }), path.basename(imagePath));
        res = await fetch(base + '/sendFileByUpload/' + token, { method: 'POST', body: fd });
      } else {
        res = await fetch(base + '/sendMessage/' + token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, message: text || '' })
        });
      }
      const body = await res.text();
      if (res.ok && /idMessage/.test(body)) { console.log('[green] message sent to self chat ' + body); return; }
      console.log('[green] attempt ' + attempt + ' failed: HTTP ' + res.status + ' ' + body.slice(0, 200));
    } catch (e) { console.log('[green] attempt ' + attempt + ' error: ' + e.message); }
    await delay(5000 * attempt);
  }
  throw new Error('GREEN-API send failed after 4 attempts');
}

async function sendToSelf({ imagePath, caption, text }) {
  if (greenOn()) return greenSend({ imagePath, caption, text });
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

module.exports = { sendToSelf, pair, hasSession: () => greenOn() || hasSession() };
