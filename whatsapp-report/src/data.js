// Fetches live market data from free, keyless sources.
// Every figure on the card comes from here; nothing is invented.
// If a source fails, its field becomes null and the card shows "—".

const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept': 'application/json,text/plain,*/*' };

async function getJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal, ...opts });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function safe(name, fn) {
  try { return await fn(); }
  catch (e) { console.warn(`[data] ${name} failed: ${e.message}`); return null; }
}

// --- Crypto: CoinGecko (free, no key) -------------------------------------
async function crypto() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,ripple&sparkline=true&price_change_percentage=24h';
  const rows = await getJSON(url);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  const pick = (id, sym, name) => by[id] ? {
    sym, name,
    price: by[id].current_price,
    change: by[id].price_change_percentage_24h,
    spark: (by[id].sparkline_in_7d?.price || []).slice(-48) // last ~48h
  } : { sym, name, price: null, change: null, spark: [] };
  const list = [pick('bitcoin', 'BTC', 'Bitcoin'), pick('ethereum', 'ETH', 'Ethereum'), pick('ripple', 'XRP', 'Ripple')];
  // Owner rule (17 Nov): a price is shown only when at least 2 of CoinGecko/Coinbase/Kraken agree within 1%.
  try {
    const v = await require('./verify').verifiedPrices(['BTC', 'ETH', 'XRP']);
    for (const c of list) {
      const ok = v[c.sym];
      if (!ok) { console.warn('[data]', c.sym, 'price not verified by 2 sources; hidden'); c.price = null; c.change = null; continue; }
      if (c.price == null || Math.abs(c.price - ok.price) / ok.price > 0.01) { c.price = ok.price; c.change = ok.change; }
    }
  } catch (e) {
    console.warn('[data] price verification failed; prices hidden:', e.message);
    for (const c of list) { c.price = null; c.change = null; }
  }
  return list;
}

async function global() {
  const g = (await getJSON('https://api.coingecko.com/api/v3/global')).data;
  return {
    mcapChange: g.market_cap_change_percentage_24h_usd,
    mcapUsd: g.total_market_cap?.usd,
    btcDominance: g.market_cap_percentage?.btc
  };
}

// --- Fear & Greed: alternative.me (free, no key) ---------------------------
async function fearGreed() {
  const d = await getJSON('https://api.alternative.me/fng/?limit=1');
  const v = d.data?.[0];
  return v ? { value: Number(v.value), label: v.value_classification } : null;
}

// --- Gold & Brent: Yahoo Finance chart endpoint (free, no key) -------------
const STOOQ = { 'GC=F': 'xauusd', 'BZ=F': 'cb.f' };

async function yahooOnce(host, symbol) {
  const u = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const d = await getJSON(u);
  const m = d.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice) throw new Error('no price');
  const prev = m.chartPreviousClose || m.previousClose;
  const change = prev ? ((m.regularMarketPrice / prev) - 1) * 100 : null;
  const closes = (d.chart.result[0].indicators?.quote?.[0]?.close || []).filter(x => x != null);
  return { price: m.regularMarketPrice, change, spark: closes };
}

// Stooq daily CSV (free, no key): backup when Yahoo rate-limits (HTTP 429).
async function stooq(symbol) {
  const s = STOOQ[symbol];
  if (!s) throw new Error('no stooq symbol');
  const r = await fetch(`https://stooq.com/q/d/l/?s=${s}&i=d`, { headers: UA });
  if (!r.ok) throw new Error('stooq ' + r.status);
  const rows = (await r.text()).trim().split('\n').slice(1).map(l => l.split(',')).filter(c => c.length >= 5 && !isNaN(parseFloat(c[4])));
  const closes = rows.slice(-6).map(c => parseFloat(c[4]));
  if (closes.length < 2) throw new Error('stooq: no data');
  const price = closes[closes.length - 1], prev = closes[closes.length - 2];
  return { price, change: ((price / prev) - 1) * 100, spark: closes.slice(-5) };
}

// CNBC quote service (free, no key): main backup for gold and Brent.
const CNBC = { 'GC=F': '@GC.1', 'BZ=F': '@LCO.1' };
async function cnbc(symbol) {
  const s = CNBC[symbol];
  if (!s) throw new Error('no cnbc symbol');
  const u = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=' + encodeURIComponent(s) + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  const d = await getJSON(u);
  const q = [].concat(d?.FormattedQuoteResult?.FormattedQuote || [])[0];
  const price = q ? parseFloat(String(q.last).replace(/,/g, '')) : NaN;
  if (!isFinite(price)) throw new Error('cnbc: no price');
  const change = q.change_pct != null ? parseFloat(String(q.change_pct).replace(/[%+,]/g, '')) : null;
  const prev = isFinite(change) ? price / (1 + change / 100) : price;
  return { price, change: isFinite(change) ? change : null, spark: [prev, price] };
}

// gold-api.com (free, no key): last resort for gold price only.
async function goldApi() {
  const d = await getJSON('https://api.gold-api.com/price/XAU');
  if (!isFinite(d?.price)) throw new Error('gold-api: no price');
  return { price: d.price, change: null, spark: [d.price, d.price] };
}

async function yahoo(symbol) {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try { return await yahooOnce(host, symbol); }
    catch (e) { console.warn(`[data] ${symbol} via ${host}: ${e.message}`); await new Promise(r => setTimeout(r, 1500)); }
  }
  for (const fn of [() => cnbc(symbol), () => stooq(symbol), () => (symbol === 'GC=F' ? goldApi() : Promise.reject(new Error('no more sources')))]) {
    try { return await fn(); }
    catch (e) { console.warn(`[data] ${symbol} backup: ${e.message}`); }
  }
  throw new Error('all sources failed');
}

// --- News headlines (English RSS) for the optional AI summary ---------------
const FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
  'https://feeds.content.dowjones.io/public/rss/mw_topstories'
];
async function headlines() {
  const out = [];
  for (const f of FEEDS) {
    try {
      const r = await fetch(f, { headers: UA });
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12);
      for (const it of items) {
        const title = (it[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1];
        const date = (it[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
        if (!title) continue;
        const age = date ? (Date.now() - new Date(date).getTime()) / 36e5 : 0;
        if (age <= 30) out.push({ title: title.trim(), source: new URL(f).hostname.replace('www.', ''), hoursAgo: Math.round(age) });
      }
    } catch (e) { console.warn(`[data] feed failed ${f}: ${e.message}`); }
  }
  return out.slice(0, 30);
}

async function fetchAll() {
  const [c, g, fg, gold, brent, news] = await Promise.all([
    safe('crypto', crypto), safe('global', global), safe('fearGreed', fearGreed),
    safe('gold', () => yahoo('GC=F')), safe('brent', () => yahoo('BZ=F')), safe('headlines', headlines)
  ]);
  return {
    crypto: c || [],
    global: g,
    fearGreed: fg,
    gold: gold ? { sym: 'XAU', name: 'Gold / oz', ...gold } : { sym: 'XAU', name: 'Gold / oz', price: null, change: null, spark: [] },
    brent: brent ? { sym: 'BRENT', name: 'Crude', ...brent } : { sym: 'BRENT', name: 'Crude', price: null, change: null, spark: [] },
    headlines: news || []
  };
}

module.exports = { fetchAll };
