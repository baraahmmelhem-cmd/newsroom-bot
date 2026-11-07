// Builds the 1080x1350 report card (navy & gold, institutional style)
// and renders it to PNG with Playwright/Chromium.

const { chromium } = require('playwright');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => n == null ? '—' : Number(n).toLocaleString('en-US', n < 10 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 });
const pct = n => n == null ? null : `${n < 0 ? '▼' : '▲'} ${Math.abs(n).toFixed(1)}%`;

function spark(arr, up) {
  if (!arr || arr.length < 2) return '';
  const w = 150, h = 34, min = Math.min(...arr), max = Math.max(...arr), span = (max - min) || 1;
  const pts = arr.map((v, i) => `${(i / (arr.length - 1) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(' ');
  const col = up === false ? 'var(--dn)' : 'var(--up)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/></svg>`;
}

function tick(a) {
  const c = a.change;
  const cls = c == null ? 'fl' : c < 0 ? 'dn' : 'up';
  return `<div class="t"><div class="s">${esc(a.sym)}<span>${esc(a.name)}</span></div>
  <div class="p">${money(a.price)}</div><div class="c ${cls}">${pct(c) || '—'}</div>${spark(a.spark, c == null ? null : c >= 0)}</div>`;
}

function arabicDate(d = new Date()) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Amman' }).format(d);
}

function fgLabel(v) {
  if (v == null) return '—';
  if (v <= 24) return 'خوف شديد'; if (v <= 44) return 'خوف'; if (v <= 55) return 'حياد'; if (v <= 75) return 'طمع'; return 'طمع شديد';
}

function buildHtml(data, news) {
  const assets = [...data.crypto, data.gold, data.brent];
  const g = data.global || {};
  const fg = data.fearGreed;
  const btc = data.crypto[0] || {};

  const headline = news?.headline || (btc.change != null
    ? `البيتكوين ${btc.change < 0 ? 'يتراجع' : 'يرتفع'} ${Math.abs(btc.change).toFixed(1)}% خلال 24 ساعة، والقيمة السوقية للعملات المشفرة ${g.mcapChange == null ? '' : (g.mcapChange < 0 ? 'تنخفض ' : 'ترتفع ') + Math.abs(g.mcapChange).toFixed(1) + '%'}`
    : 'موجز الأسواق الصباحي');

  const mcap = g.mcapUsd ? (g.mcapUsd / 1e12).toFixed(2) : null;
  const stats = news?.items?.length ? `
  <div class="statbar">
    <span>القيمة السوقية للكريبتو <b>${mcap ? mcap + ' تريليون $' : '—'}</b> <i class="${g.mcapChange < 0 ? 'dn' : 'up'}">${pct(g.mcapChange) || ''}</i></span>
    <span>هيمنة البيتكوين <b>${g.btcDominance ? g.btcDominance.toFixed(1) + '%' : '—'}</b></span>
    <span>الخوف والطمع <b>${fg ? fg.value : '—'}</b> <i class="${fg && fg.value < 45 ? 'dn' : 'up'}">${fg ? fgLabel(fg.value) : ''}</i></span>
  </div>` : `
  <div class="stats">
    <div class="st"><div class="l">القيمة السوقية للكريبتو (تريليون $)</div><div class="v">${mcap || '—'}</div><div class="d ${g.mcapChange < 0 ? 'dn' : 'up'}">${pct(g.mcapChange) || ''}</div></div>
    <div class="st"><div class="l">هيمنة البيتكوين</div><div class="v">${g.btcDominance ? g.btcDominance.toFixed(1) + '%' : '—'}</div><div class="d"></div></div>
    <div class="st"><div class="l">مؤشر الخوف والطمع</div><div class="v">${fg ? fg.value : '—'}</div><div class="d ${fg && fg.value < 45 ? 'dn' : 'up'}">${fg ? fgLabel(fg.value) : ''}</div></div>
  </div>`;

  const items = news?.items?.length ? `<div class="items">${news.items.map((it, i) => `
    <div class="it"><div class="num">0${i + 1}</div><div class="body"><div class="tag">${esc(it.tag)}</div><h3>${esc(it.title)}</h3><p>${esc(it.body)}</p></div></div>`).join('')}</div>` : '';

  const watch = news?.watch || (btc.price ? `حركة البيتكوين حول ${money(btc.price)} دولار، وبيانات الولايات المتحدة، وتحركات النفط والذهب.` : '');

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
:root{--ink:#f4f1ea;--mut:#8d98ab;--acc:#c9a24e;--panel:rgba(255,255,255,.03);--line:rgba(201,162,78,.3);--up:#38c788;--dn:#ff5a68}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1350px;--news:0;font-family:'Noto Sans Arabic','Noto Naskh Arabic','DejaVu Sans',sans-serif;color:var(--ink);position:relative;overflow:hidden;background:linear-gradient(160deg,#0f2140 0%,#0a1628 55%,#060d1a 100%);display:flex;flex-direction:column}
.corner{position:absolute;top:0;right:0;width:420px;height:420px;background:radial-gradient(circle at top right,rgba(201,162,78,.2),transparent 65%)}
.mono{font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace}
.top{display:flex;justify-content:space-between;align-items:flex-end;padding:56px 72px 0}
.brand{font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace;font-weight:700;font-size:30px;letter-spacing:5px;direction:ltr;color:var(--acc)}
.brand small{display:block;font-size:13px;letter-spacing:4px;color:var(--mut);margin-top:6px;font-weight:400}
.meta{text-align:right;color:var(--mut);font-size:22px;line-height:1.6}
.rule{height:1px;background:var(--line);margin:30px 72px 0}
.kick{font-size:22px;color:var(--acc);font-weight:700;letter-spacing:1px;padding:34px 72px 0}
h1{font-family:'Amiri','Noto Naskh Arabic',serif;font-size:92px;font-weight:700;line-height:1.1;padding:4px 72px 0}
.sub{font-size:29px;line-height:1.55;padding:16px 72px 0;opacity:.85;max-width:940px}
.tick{display:grid;grid-template-columns:repeat(5,1fr);margin:40px 72px 0;border:1px solid var(--line)}
.t{padding:20px 10px 16px;text-align:center;border-left:1px solid var(--line);background:var(--panel)}.t:last-child{border-left:none}
.t .s{font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace;font-size:19px;letter-spacing:2px;color:var(--acc)}
.t .s span{display:block;font-size:13px;letter-spacing:1px;color:var(--mut);margin-top:3px}
.t .p{font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace;font-size:30px;font-weight:700;margin-top:10px;direction:ltr}
.t .c{font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace;font-size:19px;margin-top:4px;direction:ltr}
.spark{width:150px;height:34px;margin-top:10px;opacity:.9}
.dn{color:var(--dn)}.up{color:var(--up)}.fl{color:var(--mut)}
.statbar{display:flex;justify-content:space-between;margin:22px 72px 0;padding:14px 22px;border:1px solid var(--line);background:var(--panel);border-radius:4px;font-size:19px;color:var(--mut)}
.statbar b{color:var(--ink);font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace;font-weight:700;font-size:21px}
.statbar i{font-style:normal;font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace;font-size:17px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:26px 72px 0}
.st{border:1px solid var(--line);background:var(--panel);padding:18px 22px;border-radius:4px}
.st .l{font-size:18px;color:var(--mut)}.st .v{font-size:34px;font-weight:700;margin-top:6px;font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace;direction:ltr;text-align:right}.st .d{font-size:19px;margin-top:4px}
.items{padding:22px 72px 0;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.it{display:flex;gap:24px;padding:15px 0;border-top:1px solid var(--line)}
.it:first-child{border-top:none;padding-top:0}
.num{font-family:'Amiri',serif;font-size:40px;color:var(--acc);line-height:1;min-width:60px;padding-top:6px}
.tag{font-size:18px;color:var(--mut);letter-spacing:1px}
.it h3{font-size:29px;margin-top:3px;line-height:1.3}
.it p{font-size:21px;color:var(--mut);margin-top:5px;line-height:1.55}
.spacer{flex:1}
.foot{margin-top:auto;padding:28px 72px 32px;font-size:24px;line-height:1.55;border-top:1px solid var(--line);background:rgba(0,0,0,.25)}
.foot b{color:var(--acc);margin-left:12px}
.foot .disc{font-size:14px;color:var(--mut);margin-top:10px;letter-spacing:1px}
body.news h1{font-size:78px}body.news .sub{font-size:26px;padding-top:12px}body.news .tick{margin-top:30px}body.news .kick{padding-top:26px}
</style></head><body class="${news?.items?.length ? 'news' : ''}">
<div class="corner"></div>
<div class="top"><div class="meta">${esc(arabicDate())}<br>الإصدار الصباحي · 7:00 بتوقيت عمّان</div><div class="brand">MR_AMWAL<small>MARKET INTELLIGENCE</small></div></div>
<div class="rule"></div>
<div class="kick">التقرير الاقتصادي اليومي</div>
<h1>موجز الأسواق</h1>
<div class="sub">${esc(headline)}</div>
<div class="tick">${assets.map(tick).join('')}</div>
${stats}
${items || '<div class="spacer"></div>'}
<div class="foot"><b>ما نراقبه اليوم</b>${esc(watch)}<div class="disc">MR_AMWAL · الأسعار لحظة الإصدار من CoinGecko وYahoo Finance · تقرير معلوماتي وليس توصية استثمارية</div></div>
</body></html>`;
}

async function renderPng(html, outPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: outPath });
  await browser.close();
  return outPath;
}

module.exports = { buildHtml, renderPng, arabicDate };
