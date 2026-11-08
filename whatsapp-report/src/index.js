// Entry point.  Modes:
//   pair    — link this bot to WhatsApp (one time) and send a confirmation
//   send    — fetch data, render the card, send it to the owner's own chat
//   render  — only build out/report.png (no WhatsApp), useful for testing

const fs = require('fs');
const path = require('path');
const { fetchAll } = require('./data');
const { arabicNews } = require('./news');
const { buildHtml, renderPng, arabicDate } = require('./render');
const wa = require('./send');

const OUT = path.join(__dirname, '..', 'out');

async function buildCard() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('[1/3] fetching market data...');
  const data = await fetchAll();
  const ok = data.crypto.filter(c => c.price != null).length;
  console.log(`      crypto ok=${ok}/3 gold=${data.gold.price ?? '—'} brent=${data.brent.price ?? '—'} headlines=${data.headlines.length}`);
  if (ok === 0) throw new Error('No crypto prices available; refusing to send an empty card.');

  console.log('[2/3] writing Arabic summary...');
  const news = await arabicNews(data);
  console.log(news ? `      AI summary: ${news.items.length} items` : '      no GEMINI_API_KEY (or it failed): prices-only card');

  console.log('[3/3] rendering card...');
  const html = buildHtml(data, news);
  fs.writeFileSync(path.join(OUT, 'report.html'), html);
  const png = await renderPng(html, path.join(OUT, 'report.png'));
  const btc = data.crypto[0];
  const caption = `${process.env.REPORT_KIND === 'evening' ? 'الإغلاق المسائي' : 'التقرير الاقتصادي'} – ${arabicDate()}\n${news?.headline || (btc.price ? `BTC ${Math.round(btc.price).toLocaleString('en-US')}$ (${btc.change?.toFixed(1)}%)` : '')}`.trim();
  return { png, caption, data };
}

(async () => {
  const mode = process.argv[2] || 'send';
  try {
    if (mode === 'pair') {
      await wa.pair();
    } else if (mode === 'render') {
      const { png } = await buildCard();
      console.log('card written to', png);
    } else {
      const { png, caption, data } = await buildCard();
      await wa.sendToSelf({ imagePath: png, caption });
      // Detailed text report right after the card (prices, crypto, US, UAE/Gulf, stocks).
      try {
        const text = await require('./detail').detailText(data, arabicDate());
        if (text) await wa.sendToSelf({ text }); else console.warn('[detail] no text written');
      } catch (e) { console.warn('[detail] failed:', e.message); }
    }
    console.log('done');
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
