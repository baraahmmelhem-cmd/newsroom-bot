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
const MAX_ITEMS = 3;          // up to 3 strong stories per run
const MAX_PER_DAY = 100000;   // no daily cap (user: quantity does not matter, only strength)

const GN = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=';
const FEEDS = {
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
  'CNBC Tech': 'https://www.cnbc.com/id/19854910/device/rss/rss.html',
  'Google News Big Tech': GN + encodeURIComponent('(Apple OR Google OR Microsoft OR Nvidia OR Meta OR Amazon OR Tesla OR OpenAI) (outage OR CEO OR launches OR lawsuit OR earnings OR antitrust) when:2h'),
  'Google News Payments': GN + encodeURIComponent('("Apple Pay" OR "Google Pay" OR Visa OR Mastercard OR PayPal OR Stripe OR "stablecoin payments" OR "crypto payments" OR "buy bitcoin") when:2h'),
  'Google News Trump': GN + encodeURIComponent('Trump when:2h'),
  'Google News China': GN + encodeURIComponent('China (economy OR tariffs OR yuan) when:2h'),
  'Google News Fed': GN + encodeURIComponent('("Federal Reserve" OR CPI OR "jobs report" OR Powell) when:2h'),
  'Google News Crypto': GN + encodeURIComponent('(bitcoin OR crypto OR Binance) when:2h'),
'Google News AI': GN + encodeURIComponent('("artificial intelligence" OR OpenAI OR Anthropic OR "AI chips" OR Nvidia) (US OR China OR regulation OR launch OR ban) when:2h'),
// Al Jazeera is the owner's reference source (18 Nov): English, Arabic and the Arabic economy section.
'Al Jazeera': 'https://news.google.com/rss/search?q=' + encodeURIComponent('(site:aljazeera.com/economy OR site:aljazeera.com/tag/technology OR site:aljazeera.com/tag/business-and-economy) when:2h') + '&hl=en-US&gl=US&ceid=US:en',
'Al Jazeera Arabic': 'https://news.google.com/rss/search?q=' + encodeURIComponent('(site:aljazeera.net/ebusiness OR site:aljazeera.net/tech) when:2h') + '&hl=ar&gl=EG&ceid=EG:ar',
'Arabic Economy': 'https://news.google.com/rss/search?q=' + encodeURIComponent('(site:aljazeera.net/ebusiness OR site:asharqbusiness.com OR site:alarabiya.net/aswaq) when:2h') + '&hl=ar&gl=EG&ceid=EG:ar',
'CoinDesk': 'https://www.coindesk.com/arc/outboundfeeds/rss/',
'Decrypt': 'https://decrypt.co/feed',
'The Block': 'https://www.theblock.co/rss.xml',
'Cointelegraph': 'https://cointelegraph.com/rss',
'Cointelegraph Arabic': 'https://ar.cointelegraph.com/rss',
'Wu Blockchain': 'https://wublock.substack.com/feed',
'Reuters Bloomberg': GN + encodeURIComponent('(site:reuters.com OR site:bloomberg.com) (markets OR economy OR Fed OR bitcoin OR oil OR gold OR dollar) when:2h')
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
    w = w.replace(/^(?:و|ف|ب|ل)(?=ال)/, ''); if (w.startsWith('ال') && w.length > 4) w = w.slice(2);
    if (!stop.has(w)) out.add(w);
  }
  return out;
}

function isRepeat(title, oldTitles) {
  const a = words(title);
  for (const old of oldTitles.slice(-80)) {
    const b = words(old);
    if (!a.size || !b.size) continue;
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    if (common / Math.min(a.size, b.size) >= 0.4) return old;
  }
  return null;
}

function setOutput(found) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'found=' + (found ? 'true' : 'false') + '\n');
}

// Verified prices (owner rule, 17 Nov): only prices confirmed by at least 2 of CoinGecko, Coinbase, Kraken.
async function livePrices() {
  try { return await require('./verify').verifiedPrices(['BTC', 'ETH', 'XRP', 'SOL']); }
  catch (e) { console.log('[alerts] price check failed:', e.message); return {}; }
}
function fmtP(v) { return v.price >= 100 ? Math.round(v.price).toLocaleString('en-US') : v.price.toFixed(v.price < 10 ? 3 : 2); }
function chg(v) { return v.change == null ? '' : ' (' + (v.change >= 0 ? '+' : '') + v.change.toFixed(1) + '%)'; }
function pricesText(m) { return Object.entries(m).map(([k, v]) => k + ' ' + fmtP(v) + '$' + chg(v)).join(' · ') || '(not verified: write no coin prices)'; }

// Rejects an alert whose Bitcoin figure is not the verified live price, or that calls a sharp move the live 24h change does not show.
function priceProblem(x, m) {
  const btc = m.BTC;
  const txt = x.title + ' ' + x.body;
  if (!/بيتكوين|بتكوين|bitcoin|BTC/i.test(txt)) return null;
  const nums = (txt.match(/\d{1,3}(?:[,٬]\d{3})+|\d{5,6}/g) || []).map(v => Number(v.replace(/[,٬]/g, '')));
  for (const k of (txt.match(/\d{2,3}(?:[.,]\d)?\s*ألف/g) || [])) nums.push(Math.round(parseFloat(k.replace(',', '.')) * 1000));
  const btcNums = nums.filter(n => n >= 10000 && n <= 300000);
  if (!btc) return btcNums.length ? 'Bitcoin price could not be verified by 2 sources' : null;
  for (const n of btcNums) {
    if (Math.abs(n - btc.price) / btc.price > 0.015) return 'BTC figure ' + n + ' but verified price is ' + Math.round(btc.price);
  }
  if (btc.change != null && Math.abs(btc.change) < 2.5 && /بشدة|حاد|حادة|انهيار|تنهار|ينهار|تقفز|يقفز|قفزة|بقوة/.test(x.title)) {
    return 'calls a sharp move but live 24h change is ' + btc.change.toFixed(1) + '%';
  }
  return null;
}

// The outlet behind a headline (Google News titles end with " - Outlet").
function outletOf(h) {
  const m = String(h.title || '').match(/ - ([^-]{2,40})$/);
  return (m ? m[1] : String(h.source || '')).trim().toLowerCase();
}

function buildPrompt(headlines, sent, market = {}) {
  const now = Date.now();
  const list = headlines.map((h, i) => '[' + (i + 1) + '] (' + Math.round((now - h.ts) / 60000) + ' min ago) ' + h.title + ' [' + h.source + ']').join('\n');
  const done = sent.slice(-60).map(s => '- ' + s.title + (s.event ? '  {event: ' + s.event + '}' : '')).join('\n') || '(none)';
  return [
    'You are the urgent-news desk of Mr_Amwal, an Arabic crypto/economy news service for Arab traders.',
    'Fresh headlines (newest first, age in minutes, source):',
    list,
    '',
    'LIVE PRICES RIGHT NOW (verified by at least 2 of CoinGecko/Coinbase/Kraken, 24h change): ' + pricesText(market),
    'PRICE RULE (very important): these verified prices are the ONLY coin prices you may write. Headlines are often hours',
    'old: never copy a coin price from a headline. If a headline puts Bitcoin at a level that differs from the live price,',
    'it is outdated: do not send it as a price story. Call a move sharp only if the live 24h change is at least 3%.',
    'CONFIRMATION RULE (very important): send a story ONLY if at least TWO different outlets in the list report the same',
    'event. In "refs" list the [numbers] of ALL headlines above that report it.',
'AL JAZEERA (owner rule): Al Jazeera is our reference source. Any Al Jazeera headline ([Al Jazeera], [Al Jazeera Arabic],',
'[Al Jazeera Economy] or ending "- Al Jazeera" / "الجزيرة") on our topics may be sent even if no other outlet has it yet. Never miss them.',
    '',
    'Already sent to the user, with the event key of each where known. NO REPEATS (owner rule): a story about the SAME',
'event or topic is a repeat even with other words, another outlet or a small update. Follow-ups like "arrives",',
'"begins tour", "comments again", "still falling", "talks continue" are repeats. Only a major NEW development counts',
'(a new official decision, a new official number, a signed deal, a resignation). For every item give "event": a short',
'English key of the underlying event (e.g. trump-asia-trip, nvidia-ceo-search, binance-hack); REUSE the key from the',
'list below when it is the same event (such items are not sent).',
    done,
    '',
    'TASK: send EVERY HOUR at least ONE story: the strongest market story in the list that is confirmed by two outlets',
    'and is not a repeat, plus any other genuinely strong stories (up to 3 per run). Never leave a strong story out.',
    'ALWAYS send these immediately when they appear in the headlines:',
    '- Any notable Bitcoin price move: Bitcoin rising or falling sharply, breaking or losing a key level, a new',
    '  high or low, big liquidations. Write the direction and the price/percent from the headline.',
    '- Fed / US interest-rate decisions, Powell remarks, CPI, jobs, GDP, PCE and other key US data.',
    '- Trump statements or decisions that can move markets (tariffs, crypto, the dollar, the Fed, China).',
    '- Sudden breaking news: exchange hacks or collapses, big ETF flows, new US crypto laws or rulings.',
'Topics allowed:',
    '- Crypto: big moves of the owner HALAL coins ONLY (BTC, ETH, XRP, SOL, XLM, BNB; never write about the price of any other coin or memecoin), major hacks, exchange news (Binance etc.), ETF flows, regulation (SEC, CFTC, Congress).',
    '- USA: Fed decisions, key data (CPI, jobs, GDP, PCE), Congress or White House decisions that move markets.',
    '- Trump: statements or decisions that move markets (tariffs, crypto, the dollar, the Fed).',
    '- China: economy, tariffs, US-China relations, the yuan, crypto policy.',
    '- Market shocks: big moves in oil, gold, the dollar, stock market crashes.',
    '- Big tech: important news about Apple, Google, Microsoft, Nvidia, Meta, Amazon, Tesla, OpenAI (major service outages,',
    '  CEO or leadership changes, big launches, big lawsuits or regulation, earnings shocks).',
  '- AI: important artificial-intelligence news in the US or China (OpenAI, Anthropic, Google, Nvidia, AI chips, AI laws, export bans).',
    '- Payments: Apple Pay, Google Pay, Visa, Mastercard, PayPal, Stripe, stablecoin or crypto payments, and any new way for',
    '  people to buy, hold or pay with bitcoin and crypto (cards, wallets, banks, apps).',
    'Skip: routine or weekly data (Fed balance sheet, weekly H.4.1, minor speeches), anything vague like "raises questions",',
    'analysis, opinion pieces, price predictions, small altcoins, memecoins, ads, minor company news, sports,',
    'and NEVER anything about Europe (ECB, EU, European countries or companies) or Israel.',
    'FACTS: use only facts present in the headlines. Never invent numbers, names or quotes.',
    'WRITE in Modern Standard Arabic, like a phone push notification:',
    '- title: max 10 words, starting with one emoji (📉/📈 price moves, 🏦 central banks or regulation,',
    '  🔐 hacks, 💵 US data, 🇨🇳 China, 🇺🇸 Trump/Washington, 💻 big tech, 💳 payments). Never write "عاجل" and never use the 🚨 emoji.',
    '- body: ONE short sentence (max 25 words) with the key detail. No source line, no advice, no hashtags.',
    '- impact_dir: the effect on the market: إيجابي, سلبي or محايد.',
    '- impact_strength: عالي (moves the whole market now: Fed/rates, surprise CPI/jobs, record ETF flows, bitcoin >=5% in 24h, big US regulation, a market-moving Trump statement), متوسط (one asset/sector or sentiment, bitcoin 2-5%) or منخفض (background, a move under 2%).',
    '- impact_reason: one or two professional Modern Standard Arabic sentences (max 40 words) explaining HOW this news moves the market (investor confidence, liquidity, interest rates, institutional demand), mentioning the market reaction if a number is in the headlines. No emoji, no advice, no predictions.',
    'Reply with JSON only: {"items":[{"title":"...","body":"...","impact_dir":"سلبي","impact_strength":"عالي","impact_reason":"...","refs":[1,7],"event":"short-english-key"}]}  (use {"items":[]} when nothing qualifies)'
  ].join('\n');
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY secret is missing');
  // Ask Google which models this key can use, so a retired model name never breaks the alerts.
  let models = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  try {
    const lm = await (await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + key, { signal: AbortSignal.timeout(20000) })).json();
    const names = (lm.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.split('/').pop())
      .filter(n => /flash/.test(n) && !/image|tts|live|audio|embedding|exp/.test(n));
    models = [...new Set([...models, ...names])].slice(0, 6);
  } catch (e) { console.log('[alerts] model list failed', e.message); }
  models = [...models, ...models.slice(0, 2)]; // busy (503) models get a second try after a pause
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
      await new Promise(r => setTimeout(r, 6000));
    }
  }
  throw new Error('No Gemini model worked (' + last + ')');
}

async function pick() {
  const sent = loadState();
  const now = Date.now();
  const today = sent.filter(s => now - (s.ts || 0) < 24 * 3600 * 1000).length;
  if (today >= MAX_PER_DAY) {
    console.log('[alerts] daily cap reached (' + today + ' in 24h); sending nothing.');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, '[]');
    return setOutput(false);
  }
  const names = Object.keys(FEEDS);
  // Google News blocks bursts (HTTP 429): its feeds start 1.5 s apart, the others at once.
const results = await Promise.allSettled(names.map((n, i) => new Promise(r => setTimeout(r, /news\.google\.com/.test(FEEDS[n]) ? i * 1500 : 0)).then(() => fetchFeed(n, FEEDS[n]))));
  let items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else console.log('[alerts] feed failed:', names[i], r.reason && r.reason.message);
  });
  const seen = new Set();
  items = items
    .filter(h => { const age = (now - h.ts) / 60000; return age >= -10 && age <= (/^(Al Jazeera|Arabic Economy|Cointelegraph Arabic)/.test(h.source) ? 360 : FRESH_MIN) && !banned(h.title); })
    .sort((a, b) => b.ts - a.ts)
    .filter(h => { const k = h.title.toLowerCase().slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((h, i) => i < 60 || /^(Al Jazeera|Arabic Economy|Cointelegraph Arabic)/.test(h.source));
  console.log('[alerts] fresh headlines (last ' + FRESH_MIN + ' min):', items.length);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!items.length) { fs.writeFileSync(OUT, '[]'); return setOutput(false); }

  const market = await livePrices();
  const oldTitles = sent.map(s => s.title);
  const picked = [];
  const tried = [];
  // Owner rule (17 Nov): one confirmed story every hour. If round 1 gives nothing that passes the checks, ask once more.
  // Owner 22 Nov: headlines behind a rejected repeat are removed before the next round, so the model must pick another story.
  const dropIdx = new Set();
  const refsOf = x => (Array.isArray(x && x.refs) ? x.refs : []).map(Number).filter(n => n >= 1 && n <= items.length);
  for (let round = 1; round <= 4 && !picked.length; round++) {
  if (dropIdx.size) { items = items.filter((h, k) => !dropIdx.has(k + 1)); console.log('[alerts] removed headlines of rejected repeats:', dropIdx.size, 'left:', items.length); dropIdx.clear(); }
  const extra = round === 1 ? '' : '\nIMPORTANT: these earlier picks were REJECTED because they were already sent before or failed the checks. Do NOT return them again and do NOT return the same event in other words: (' + (tried.join(' | ') || 'none') + '). Pick a DIFFERENT event from the list. Choose the next-best story that IS reported by at least two different outlets in the list and is not a repeat; use {"items":[]} only if truly nothing qualifies.';
  const res = await askGemini(buildPrompt(items, sent, market) + extra);
  for (const x of (res && res.items) || []) {
    if (x && x.title) tried.push(String(x.title));
    if (!x || !x.title || !x.body) continue;
    if (banned(x.title + ' ' + x.body)) { console.log('[alerts] skipped (Europe/Israel rule):', x.title); continue; }
    const dup = isRepeat(x.title, oldTitles.concat(picked.map(p => p.title)));
    if (dup) { refsOf(x).forEach(n => dropIdx.add(n)); console.log('[alerts] skipped as repeat of:', dup); continue; }
const ev = String(x.event || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
if (ev && (sent.some(s => s.event === ev && now - (s.ts || 0) < 36 * 3600 * 1000) || picked.some(p => p.event === ev))) { refsOf(x).forEach(n => dropIdx.add(n)); console.log('[alerts] skipped (same event already sent):', ev, '-', x.title); continue; }
const btcMove = t => /📉|📈/.test(t) && /بيتكوين|بتكوين|bitcoin|BTC/i.test(t);
if (btcMove(x.title) && !(market.BTC && Math.abs(market.BTC.change || 0) >= 5) && sent.concat(picked).some(s => btcMove(s.title) && now - (s.ts || now) < 4 * 3600 * 1000)) { refsOf(x).forEach(n => dropIdx.add(n)); console.log('[alerts] skipped (Bitcoin move already sent in the last 4h):', x.title); continue; }
    const refs = [...new Set((Array.isArray(x.refs) ? x.refs : []).map(Number).filter(n => n >= 1 && n <= items.length))];
    const outlets = new Set(refs.map(n => outletOf(items[n - 1])));
    const trusted = [...outlets].some(o => /jazeera|الجزيرة|reuters|رويترز|bloomberg|بلومبرغ|asharq|الشرق|cointelegraph arabic/i.test(o));
if (outlets.size < 2 && !trusted) { console.log('[alerts] skipped (not confirmed by 2 outlets):', x.title, '-', [...outlets].join(', ') || 'no refs'); continue; }
    const bad = priceProblem(x, market);
    if (bad) { console.log('[alerts] skipped (price not verified):', x.title, '-', bad); continue; }
// Owner rule 18 Nov: only halal coins (BTC, ETH, XRP, SOL, XLM, BNB). Stories about other coins are dropped.
if (/\b(ADA|KAVA|DOGE|SHIB|PEPE|LTC|AVAX|TRX|TON|LINK|SUI|HYPE|ZEC|XMR|BCH|DOT|MATIC|UNI|AAVE|WIF|BONK|FLOKI)\b|(?:^|[\s(«"])(?:و|ب|ل)?(?:كاردانو|كافا|دوجكوين|دوج كوين|شيبا|بيبي|لايتكوين|أفالانش|ترون|تشينلينك|سوي|بولكادوت|بوليغون|يونيسواب)(?=$|[\s)»".,:،])|عملة ميم|عملات الميم/.test(x.title + ' ' + x.body)) { console.log('[alerts] skipped (not a halal coin):', x.title); continue; }
    let body = String(x.body).trim();
    if (market.BTC && /بيتكوين|بتكوين|bitcoin|BTC/i.test(x.title + ' ' + body)) body += '\nBTC ' + fmtP(market.BTC) + '$' + chg(market.BTC);
    // Owner's manager (26 Nov): same short market-impact line as the newsroom items.
    { const d = String(x.impact_dir || '').trim(), st = String(x.impact_strength || '').trim(), r = String(x.impact_reason || '').trim();
      const DOT = { 'عالي': '🔴', 'متوسط': '🟡', 'منخفض': '⚪' };
      if (/^(إيجابي|سلبي|محايد)$/.test(d) && DOT[st]) body += '\n\n📊 *التأثير: ' + d + ' ' + DOT[st] + ' ' + st + '*' + (r ? '\n' + r : ''); }
    picked.push({ event: ev, title: String(x.title).replace(/🚨\s*/g, '').replace(/عاجل\s*[:：]?\s*/g, '').replace(/\s+/g, ' ').trim(), body });
    if (picked.length >= MAX_ITEMS) break;
  }
  }
  // Owner rule 18 Nov: every fresh Al Jazeera Arabic headline on our topics goes out, even if the model did not pick it
// (currencies, gold, silver, oil, Wall Street, the Fed, crypto, big tech, AI, payments). Repeats and Europe/Israel are still skipped.
const AJ_TOPIC = /بيتكوين|بتكوين|العملات|كريبتو|إيثيريوم|إيثريوم|الذهب|ذهب|الفضة|النفط|نفط|برنت|الخام|وول ستريت|الأسهم الأمريكية|داو جونز|ناسداك|الفدرالي|الفيدرالي|الاحتياطي الاتحادي|باول|الفائدة|الدولار|إنفيديا|أبل|آبل|غوغل|مايكروسوفت|ميتا|أمازون|تسلا|أوبن إيه آي|أنثروبيك|الذكاء الاصطناعي|فيزا|ماستركارد|باي بال|المدفوعات|هرمز/;
const ajIcon = t => /ذهب|الفضة/.test(t) ? '🪙' : /نفط|برنت|الخام|هرمز/.test(t) ? '🛢️' : /وول ستريت|الأسهم|داو جونز|ناسداك/.test(t) ? '📊' : /الفدرالي|الفيدرالي|الاحتياطي|باول|الفائدة/.test(t) ? '🏦' : /بيتكوين|بتكوين|كريبتو|إيثيريوم|إيثريوم|المشفرة|الرقمية/.test(t) ? '💰' : /الذكاء الاصطناعي|إنفيديا|أبل|آبل|غوغل|مايكروسوفت|ميتا|أمازون|تسلا|أوبن|أنثروبيك/.test(t) ? '💻' : /فيزا|ماستركارد|باي بال|المدفوعات/.test(t) ? '💳' : '💵';
for (const h of items) {
  if (!['Al Jazeera Arabic', 'Arabic Economy', 'Cointelegraph Arabic'].includes(h.source)) continue;
  const m = h.title.match(/\s+-\s+([^-]{2,40})\s*$/);
  const t = h.title.replace(/\s+-\s+[^-]{2,40}\s*$/, '').trim();
  const src = h.source === 'Cointelegraph Arabic' ? 'كوينتيليغراف عربي' : (m ? m[1].trim() : 'الجزيرة نت');
  if (!AJ_TOPIC.test(t) || banned(t)) continue;
  if (/(?:^|[\s(«"])(?:و|ب|ل)?(?:كاردانو|كافا|دوجكوين|شيبا|بيبي|لايتكوين|سوي)(?=$|[\s)»".,:،])|عملة ميم|عملات الميم/.test(t)) continue;
  if (isRepeat(t, oldTitles.concat(picked.map(p => p.title)))) { console.log('[alerts] Al Jazeera repeat skipped:', t); continue; }
  if (priceProblem({ title: t, body: '' }, market)) { console.log('[alerts] Al Jazeera price not verified, skipped:', t); continue; }
  picked.push({ event: '', title: ajIcon(t) + ' ' + t, body: 'المصدر: ' + src });
  console.log('[alerts] Al Jazeera headline added:', t);
}
// Owner 19 Nov: economy and markets only. No sports, no wars, no Africa, no human-interest stories.
const SPORT_AFRICA = /الصومال|السودان|ليبيا|تونس|الجزائر|المغرب|موريتانيا|مصر(?!ف)|إثيوبيا|أفريقيا|إفريقيا|لاعب|منتخب|مباراة|كأس|الدوري|بطولة|ميدالية|أولمبي|رياضي|النادي|الفيفا|تتويج|التتويج|ذهبية|ذهبيتين|فضية|برونزية|بطل|بطلة|المصري|المصرية|شلاتين|القاهرة|السويس/;
const WAR = /حرب|الحرب|قصف|غارة|غارات|اشتباك|قتلى|قتيل|جرحى|مسلح|ميليشيا|صاروخ|صواريخ|مسيرات|عسكري|الجيش|جنود|هدنة|انفجار|اغتيال|معارك|المفقود|مفقود|البحار|بحار|والد|والدة|عائلة|أسرة|طفل|أطفال|ضحايا|عصيبة|يروي|تروي|قصة/;
const MARKET_WORDS = /النفط|نفط|برنت|الخام|أسعار|الأسواق|الأسهم|الدولار|بيتكوين|الذهب|الشحن|ناقلات/;
const ECON = /اقتصاد|كريبتو|بيتكوين|بتكوين|إيثريوم|إيثيريوم|ريبل|سولانا|بينانس|ستيلر|بلوكتشين|مشفر|الرقمية|مستقرة|عملة|العملات|الدولار|اليوان|الين|اليورو|الروبل|الذهب|أونصة|الفضة|النفط|نفط|برنت|الخام|أوبك|الغاز|مصافي|وول ستريت|ناسداك|داو جونز|ستاندرد|البورصة|الأسهم|أسهم|سهم|سندات|الخزانة|الأسواق|السوق|أسعار|سعر|أرباح|إيرادات|استثمار|تمويل|ميزانية|ضرائب|الرسوم|جمرك|تجار|صادرات|واردات|عقوبات|بنك|مصرف|تضخم|الفائدة|الوظائف|البطالة|الناتج|ركود|شركة|شركات|إنفيديا|أبل|آبل|غوغل|جوجل|مايكروسوفت|ميتا|أمازون|تسلا|أوبن إيه آي|أنثروبيك|الذكاء الاصطناعي|رقائق|أشباه الموصلات|فيزا|ماستركارد|ماستر كارد|باي بال|المدفوعات|الدفع|ترامب|الصين|روسيا|بوتين|شي جين|قمة|اجتماع|خطاب|الفدرالي|الفيدرالي|الاحتياطي|باول|وارش|تريليون|مليار|اختراق|سيبراني|سيبرانية|قرصنة|إلكتروني|بيانات|تسريب|فدية/;
const QUESTION = /[؟?]|^(هل|كيف|لماذا|ماذا|ما هي|ما هو|ما الذي|متى|أين|من هو|من هي|إليك|دليل|نصائح|خطوات|تعرف على)\s/;
const isQ = t => QUESTION.test((t || '').replace(/^[^ء-يa-zA-Z]+/, '').trim());
for (let i = picked.length - 1; i >= 0; i--) {
  const tt = picked[i].title || '';
  const off = isQ(tt) || SPORT_AFRICA.test(tt) || (WAR.test(tt) && !MARKET_WORDS.test(tt)) || !ECON.test(tt);
  if (off) { console.log('[alerts] off-topic dropped:', tt); picked.splice(i, 1); }
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
  // Owner 21 Nov: check the live Bitcoin price again right before sending; skip if it moved more than 1.5%.
  const market = await livePrices();
  for (const it of picked) {
    const pp = priceProblem(it, market);
    if (pp) { console.log('[alerts] price moved before send, skipped:', it.title, '-', pp); continue; }
    await wa.sendToSelf({ text: '*' + it.title + '*\n' + it.body });
    sent.push({ title: it.title, event: it.event || undefined, ts: Date.now() });
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
