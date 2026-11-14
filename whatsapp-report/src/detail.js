// Detailed Arabic text report sent right after the image card (morning and evening).
// Uses only live prices (CoinGecko/Yahoo) and fresh headlines from free RSS feeds;
// Gemini writes it and must not invent any number that is not in the data below.

const EVE = process.env.REPORT_KIND === 'evening';
const UA = { 'User-Agent': 'Mozilla/5.0 whatsapp-report' };
const GN = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=';
const FEEDS = {
  'Gulf markets': GN + encodeURIComponent('(Dubai OR "Abu Dhabi" OR Saudi OR Qatar) (stocks OR index OR market) when:1d'),
  'UAE economy': GN + encodeURIComponent('UAE (economy OR VARA OR crypto OR central bank) when:1d'),
  'US stocks': GN + encodeURIComponent('(Wall Street OR "S&P 500" OR Nasdaq OR Dow) stocks when:1d'),
  'Washington': GN + encodeURIComponent('(Congress OR Trump OR Fed) (dollar OR markets OR crypto) when:1d'),
  'Crypto': GN + encodeURIComponent('(bitcoin OR crypto OR Binance) when:1d'),
  'CryptoPanic': 'https://cryptopanic.com/news/rss/',
  'CNBC Markets': 'https://www.cnbc.com/id/10000664/device/rss/rss.html'
};
const BANNED = ['israel', 'gaza', 'netanyahu', 'europe', 'european', 'ecb', 'lagarde', 'eurozone', 'germany', 'france', 'britain', 'إسرائيل', 'غزة', 'أوروب'];

function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function feed(name, url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const title = decode((m[0].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const ts = new Date(decode((m[0].match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1])).getTime();
    const age = (Date.now() - ts) / 36e5;
    if (title && !isNaN(ts) && age <= 24 && !BANNED.some(w => title.toLowerCase().includes(w))) out.push('- [' + name + ', ' + Math.round(age) + 'h ago] ' + title);
    if (out.length >= 10) break;
  }
  return out;
}

async function yahoo(symbol) {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=1d', { headers: UA, signal: AbortSignal.timeout(20000) });
  const m = (await r.json()).chart.result[0].meta;
  const prev = m.chartPreviousClose || m.previousClose;
  return { price: m.regularMarketPrice, change: prev ? (m.regularMarketPrice / prev - 1) * 100 : null };
}

const fmt = (n, d = 0) => n == null ? 'n/a' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const pct = n => n == null ? 'n/a' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

// Manager rule (14 Nov): the text report is at most 50 words. Keep whole lines while within the limit.
function capWords(text, max = 50) {
  const out = []; let n = 0;
  for (const line of text.split('\n')) {
    const w = line.trim() ? line.trim().split(/\s+/).length : 0;
    if (out.length && n + w > max) break;
    out.push(line); n += w;
  }
  return out.join('\n').trim();
}

async function detailText(data, dateLabel) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const names = Object.keys(FEEDS);
  const lists = await Promise.allSettled(names.map(n => feed(n, FEEDS[n])));
  const heads = lists.flatMap((r, i) => r.status === 'fulfilled' ? r.value : (console.warn('[detail] feed failed', names[i]), []));
  const [spx, dxy] = await Promise.all([yahoo('^GSPC').catch(() => null), yahoo('DX-Y.NYB').catch(() => null)]);

  const c = data.crypto || [];
  const p = s => c.find(x => x.sym === s) || {};
  const facts = [
    'BTC ' + fmt(p('BTC').price) + ' USD (' + pct(p('BTC').change) + ' 24h)',
    'ETH ' + fmt(p('ETH').price) + ' USD (' + pct(p('ETH').change) + ' 24h)',
    'XRP ' + fmt(p('XRP').price, 2) + ' USD (' + pct(p('XRP').change) + ' 24h)',
    'Gold ' + fmt(data.gold && data.gold.price) + ' USD/oz (' + pct(data.gold && data.gold.change) + ')',
    'Brent ' + fmt(data.brent && data.brent.price, 1) + ' USD/bbl (' + pct(data.brent && data.brent.change) + ')',
    'S&P 500 ' + fmt(spx && spx.price) + ' (' + pct(spx && spx.change) + ', last session)',
    'US dollar index ' + fmt(dxy && dxy.price, 2) + ' (' + pct(dxy && dxy.change) + ')'
  ].join('\n');

  const title = (EVE ? 'الإغلاق المسائي' : 'التقرير الاقتصادي') + ' – ' + dateLabel;
  const prompt = [
    'You are the senior Arabic markets editor of Mr_Amwal. Write the ' + (EVE ? 'evening close (what happened today)' : 'morning report (what to know today)') + ' as ONE WhatsApp text message.',
    'LIVE PRICES (the ONLY numbers you may use):', facts, '',
    'HEADLINES from the last 24 hours (English):', heads.slice(0, 60).join('\n') || '(none)', '',
    'RULES: Modern Standard Arabic, concise, professional, no emojis, no tables, no source names, no investment advice.',
    'Use ONLY numbers listed in LIVE PRICES or written in a headline. Never invent index levels or percentages; if a figure is missing, describe without it.',
    'Never mention Europe or Israel.',
    'LENGTH (manager rule): the WHOLE message, title included, must be 50 words or fewer. Be extremely tight.',
    'FORMAT exactly (WhatsApp bold with *), four lines only:',
    '*' + title + '*',
    'One short sentence: the single most important development of the day.',
    'البيتكوين X دولار (±%) · الذهب X دولار (±%) · برنت X دولار (±%)',
    'One short sentence: what to watch next (US data/Fed, crypto or Gulf markets).',
    'Reply with the message text only.'
  ].join('\n');

  for (const model of ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.0-flash']) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }),
        signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').trim();
      if (text.length > 80) { console.log('[detail] written with', model); return capWords(text.replace(/^\x60{3}\w*\n?|\x60{3}$/g, '').trim()); }
      throw new Error('empty reply');
    } catch (e) {
      console.warn('[detail]', model, 'failed:', e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

module.exports = { detailText };
