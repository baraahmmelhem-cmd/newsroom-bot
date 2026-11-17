// Verified coin prices (owner rule, 17 Nov: nothing reaches the group unless it is 100% right).
// A price is used only when at least two independent sources (CoinGecko, Coinbase, Kraken) agree
// within 1%; the published price is their median. If they do not agree, the price is NOT used.

const UA = { 'User-Agent': 'Mozilla/5.0 mr-amwal-verify', 'Accept': 'application/json' };
const CG_ID = { BTC: 'bitcoin', ETH: 'ethereum', XRP: 'ripple', SOL: 'solana' };
const KRAKEN = { BTC: 'XBTUSD', ETH: 'ETHUSD', XRP: 'XRPUSD', SOL: 'SOLUSD' };
const AGREE = 0.01;

async function getJSON(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function coingecko(syms) {
  const ids = syms.map(s => CG_ID[s]).filter(Boolean).join(',');
  const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd&include_24hr_change=true');
  const out = {};
  for (const s of syms) {
    const v = j[CG_ID[s]];
    if (v && v.usd) out[s] = { price: v.usd, change: typeof v.usd_24h_change === 'number' ? v.usd_24h_change : null };
  }
  return out;
}

async function coinbase(syms) {
  const out = {};
  await Promise.all(syms.map(async s => {
    try { out[s] = { price: Number((await getJSON('https://api.coinbase.com/v2/prices/' + s + '-USD/spot')).data.amount) }; }
    catch (e) { /* this coin not available here */ }
  }));
  return out;
}

async function kraken(syms) {
  const pairs = syms.map(s => KRAKEN[s]).filter(Boolean).join(',');
  const j = await getJSON('https://api.kraken.com/0/public/Ticker?pair=' + pairs);
  const out = {};
  for (const [k, v] of Object.entries(j.result || {})) {
    const s = Object.keys(KRAKEN).find(x => k.includes(KRAKEN[x].replace('USD', '')) || k.includes(x));
    if (s && syms.includes(s)) out[s] = { price: Number(v.c[0]) };
  }
  return out;
}

const median = a => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

// Returns { BTC: { price, change, sources: ['CoinGecko', ...] }, ... } with only the verified coins.
async function verifiedPrices(syms = ['BTC', 'ETH', 'XRP', 'SOL']) {
  const results = {};
  for (const [name, fn] of [['CoinGecko', coingecko], ['Coinbase', coinbase], ['Kraken', kraken]]) {
    try { results[name] = await fn(syms); } catch (e) { console.log('[verify]', name, 'failed:', e.message); results[name] = {}; }
  }
  const out = {};
  for (const s of syms) {
    const quotes = Object.entries(results).filter(([, r]) => r[s] && isFinite(r[s].price) && r[s].price > 0).map(([n, r]) => [n, r[s].price]);
    if (quotes.length < 2) { console.log('[verify]', s, 'only', quotes.length, 'source(s); not used'); continue; }
    const mid = median(quotes.map(q => q[1]));
    const agree = quotes.filter(([, p]) => Math.abs(p - mid) / mid <= AGREE);
    if (agree.length < 2) { console.log('[verify]', s, 'sources disagree; not used:', quotes.map(q => q.join(' ')).join(', ')); continue; }
    const price = median(agree.map(q => q[1]));
    const cg = results.CoinGecko[s];
    const change = cg && Math.abs(cg.price - price) / price <= AGREE ? cg.change : null;
    out[s] = { price, change, sources: agree.map(q => q[0]) };
  }
  console.log('[verify] prices:', Object.entries(out).map(([s, v]) => s + ' ' + v.price + ' (' + v.sources.join('+') + ')').join(', ') || 'none verified');
  return out;
}

module.exports = { verifiedPrices };
