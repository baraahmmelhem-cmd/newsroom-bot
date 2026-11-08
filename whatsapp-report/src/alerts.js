// Breaking-news alerts to the owner's own WhatsApp chat (runs on GitHub Actions).
// pick: read free news RSS feeds, ask Gemini to choose up to 3 NEW important stories
//       (crypto, USA, Trump, China, market shocks) and write them to out/alerts.json.
// send: send each picked story as its own WhatsApp message, then remember it.
// Never anything about Europe or Israel (user rule).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'alerts.json');
const STATE = path.join(ROOT, 'alerts-sent.json');
const FRESH_MIN = Number(process.env.ALERTS_FRESH_MIN || 75);
const MAX_ITEMS = 3;

const GN = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=';
const FEEDS = {
  'CryptoPanic': 'https://cryptopanic.com/news/rss/',
  'Cointelegraph': 'https://cointelegraph.com/rss',
  'CoinDesk': 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'The Block': 'https://www.theblock.co/rss.xml',
  'Decrypt': 'https://decrypt.co/feed',
  'Bitcoin Magazine': 'https://bitcoinmagazine.com/feed',
  'CryptoSlate': 'https://cryptoslate.com/feed/',
  'CryptoNews': 'https://cryptonews.com/news/feed/',
  'CNBC Economy': 'https://www.cnbc.com/id/20910258/device/rss/rss.html',
  'CNBC Markets': 'https://www.cnbc.com/id/10000664/device/rss/rss.html',
  'CNBC Politics': 'https://www.cnbc.com/id/10000113/device/rss/rss.html',
  'CNBC World': 'https://www.cnbc.com/id/100727362/device/rss/rss.html',
  'MarketWatch': 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  'Google News Trump': GN + encodeURIComponent('Trump when:2h'),
  'Google News China': GN + encodeURIComponent('China (economy OR tariffs OR yuan) when:2h'),
  'Google News Fed': GN + encodeURIComponent('("Federal Reserve" OR CPI OR "jobs report" OR Powell) when:2h'),
  'Google News Crypto': GN + encodeURIComponent('(bitcoin OR crypto OR Binance) when:2h')
};

const BANNED = ['israel', 'israeli', 'gaza', 'netanyahu', 'hamas', 'hezbollah', 'europe', 'european', ' eu ', "eu's",
  'ecb', 'lagarde', 'eurozone', 'brussels', 'germany', 'german ', 'france', 'french', 'italy', 'spain', 'britain',
  'british', 'england', ' uk ', 'greece', 'netherlands', 'dutch', 'poland', 'switzerland', 'swiss',
  'إسرائيل', 'اسرائيل', 'الإسرائيلي', 'غزة', 'أوروب', 'اوروب', 'اليورو', 'بريطانيا', 'ألمانيا', 'فرنسا', 'اليونان'];

function banned(text) {
  const s = ' ' + String(text || '').toLowerCase() + ' ';
  return BANNED.some(w => s.includes(w));
}

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#8217;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function fetchFeed(name, url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 whatsapp-alerts' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const it = m[0];
    const title = decode((it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const ts = new Date(decode((it.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1])).getTime();
    if (title && !isNaN(ts)) out.push({ title, source: name, ts });
  }
  return out;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return []; }
}

function saveState(items) {
  fs.writeFileSync(STATE, JSON.stringify(items.slice(-150), null, 2) + '\n');
}

function words(s) {
  const stop = new Set(['في', 'من', 'إلى', 'على', 'بعد', 'مع', 'عن', 'عاجل', 'دولار', 'مليون', 'مليار', 'the', 'a', 'to', 'of']);
  const out = new Set();
  for (let w of String(s).toLowerCase().match(/\d+|[\p{L}]{3,}/gu) || []) {
    if (w.startsWith('ال') && w.length > 4) w = w.slice(2);
    if (!stop.has(w)) out.add(w);
  }
  return out;
}

function isRepeat(title, oldTitles) {
  const a = words(title);
  for (const old of oldTitles.slice(-40)) {
    const b = words(old);
    if (!a.size || !b.size) continue;
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    if (common / Math.min(a.size, b.size) >= 0.5) return old;
  }
  return null;
}

function setOutput(found) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'found=' + (found ? 'true' : 'false') + '\n');
}

function buildPrompt(headlines, sent) {
  const now = Date.now();
  const list = headlines.map(h => '- (' + Math.round((now - h.ts) / 60000) + ' min ago) ' + h.title + ' [' + h.source + ']').join('\n');
  const done = sent.slice(-40).map(s => '- ' + s.title).join('\n') || '(none)';
  return [
    'You are the urgent-news desk of Mr_Amwal, an Arabic crypto/economy news service for Arab traders.',
    'Fresh headlines (newest first, age in minutes, source):',
    list,
    '',
    'Already sent to the user (the SAME event is a repeat; only a genuinely new development counts as new):',
    done,
    '',
    'TASK: pick ONLY stories that are truly important or breaking right now. At most 3. Zero is fine and common.',
    'Topics allowed:',
    '- Crypto: big BTC/ETH/XRP moves, major hacks, exchange news (Binance etc.), ETF flows, regulation (SEC, CFTC, Congress).',
    '- USA: Fed decisions, key data (CPI, jobs, GDP, PCE), Congress or White House decisions that move markets.',
    '- Trump: statements or decisions that move markets (tariffs, crypto, the dollar, the Fed).',
    '- China: economy, tariffs, US-China relations, the yuan, crypto policy.',
    '- Market shocks: big moves in oil, gold, the dollar, stock market crashes.',
    'Skip: opinion pieces, price predictions, small altcoins, memecoins, ads, minor company news, sports,',
    'and NEVER anything about Europe (ECB, EU, European countries or companies) or Israel.',
    'FACTS: use only facts present in the headlines. Never invent numbers, names or quotes.',
    'WRITE in Modern Standard Arabic, like a phone push notification:',
    '- title: max 10 words, starting with one emoji (🚨 breaking, 📉/📈 price moves, 🏦 central banks or regulation,',
    '  🔐 hacks, 💵 US data, 🇨🇳 China, 🇺🇸 Trump/Washington). Put "عاجل:" after the emoji only for truly breaking,',
    '  market-moving news.',
    '- body: ONE short sentence (max 25 words) with the key detail. No source line, no advice, no hashtags.',
    'Reply with JSON only: {"items":[{"title":"...","body":"..."}]}  (use {"items":[]} when nothing qualifies)'
  ].join('\n');
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY secret is missing');
  const models = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.0-flash'];
  let last;
  for (const model of models) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      console.log('[alerts] model used:', model);
      return parsed;
    } catch (e) {
      last = model + ': ' + e.message;
      console.log('[alerts] model failed', last);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('No Gemini model worked (' + last + ')');
}

async function pick() {
  const sent = loadState();
  const now = Date.now();
  const names = Object.keys(FEEDS);
  const results = await Promise.allSettled(names.map(n => fetchFeed(n, FEEDS[n])));
  let items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else console.log('[alerts] feed failed:', names[i], r.reason && r.reason.message);
  });
  const seen = new Set();
  items = items
    .filter(h => { const age = (now - h.ts) / 60000; return age >= -10 && age <= FRESH_MIN && !banned(h.title); })
    .sort((a, b) => b.ts - a.ts)
    .filter(h => { const k = h.title.toLowerCase().slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 60);
  console.log('[alerts] fresh headlines (last ' + FRESH_MIN + ' min):', items.length);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!items.length) { fs.writeFileSync(OUT, '[]'); return setOutput(false); }

  const res = await askGemini(buildPrompt(items, sent));
  const oldTitles = sent.map(s => s.title);
  const picked = [];
  for (const x of (res && res.items) || []) {
    if (!x || !x.title || !x.body) continue;
    if (banned(x.title + ' ' + x.body)) { console.log('[alerts] skipped (Europe/Israel rule):', x.title); continue; }
    const dup = isRepeat(x.title, oldTitles.concat(picked.map(p => p.title)));
    if (dup) { console.log('[alerts] skipped as repeat of:', dup); continue; }
    picked.push({ title: String(x.title).trim(), body: String(x.body).trim() });
    if (picked.length >= MAX_ITEMS) break;
  }
  fs.writeFileSync(OUT, JSON.stringify(picked, null, 2));
  console.log('[alerts] picked:', picked.length ? picked.map(p => p.title).join(' | ') : 'nothing new');
  setOutput(picked.length > 0);
}

async function send() {
  const picked = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (!picked.length) return;
  const wa = require('./send');
  const sent = loadState();
  for (const it of picked) {
    await wa.sendToSelf({ text: '*' + it.title + '*\n' + it.body });
    sent.push({ title: it.title, ts: Date.now() });
    saveState(sent);
  }
  console.log('[alerts] sent', picked.length, 'message(s)');
}

(async () => {
  const mode = process.argv[2] || 'pick';
  try {
    if (mode === 'send') await send(); else await pick();
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    if (mode !== 'send') setOutput(false);
    process.exit(mode === 'send' ? 1 : 0);
  }
})();
