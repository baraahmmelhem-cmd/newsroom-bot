// Telegram channel DRAFTS for review (owner, 23 Nov 2026 — 4-week trial, Telegram only; nothing is published).
// daily  (Sun-Fri 18:00 Amman): "الخبر في 3 أسطر" — the single most important story of the last 24 h.
// weekly (Sat 18:00 Amman):     "أسبوع الكريبتو بـ 5 أرقام" + "قراءة Mr_Amwal".
// The draft goes to the owner through the existing WhatsApp sender (send.js -> GREEN-API -> her group),
// followed by a notes message: source links, two alternative stories, and every number that needs checking.
// Usage: node src/telegram.js daily|weekly [--dry]   (--dry: print only, send nothing, save nothing)

const fs = require("fs");
const path = require("path");
const { verifiedPrices } = require("./verify");

const ROOT = path.join(__dirname, "..");
const STATE = path.join(ROOT, "telegram-state.json");
const UA = { "User-Agent": "Mozilla/5.0 mr-amwal-telegram", "Accept": "*/*" };
const DISCLAIMER = "للمعلومات فقط — ليست نصيحة استثمارية";
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const GN = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=";
const GN_AR = q => "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=ar&gl=EG&ceid=EG:ar";

const FEEDS = {
  "CoinDesk": "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "Cointelegraph": "https://cointelegraph.com/rss",
  "The Block": "https://www.theblock.co/rss.xml",
  "Decrypt": "https://decrypt.co/feed",
  "CNBC Economy": "https://www.cnbc.com/id/20910258/device/rss/rss.html",
  "CNBC Markets": "https://www.cnbc.com/id/10000664/device/rss/rss.html",
  "MarketWatch": "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  "Federal Reserve": "https://www.federalreserve.gov/feeds/press_monetary.xml",
  "Google News ETF": GN + encodeURIComponent("(\"bitcoin ETF\" OR \"spot ETF\" OR IBIT) (inflows OR outflows) when:1d"),
  "Google News Fed": GN + encodeURIComponent("(\"Federal Reserve\" OR FOMC OR \"rate cut\" OR Powell OR Warsh) when:1d"),
  "Google News Data": GN + encodeURIComponent("(CPI OR inflation OR \"jobs report\" OR payrolls OR PCE OR unemployment) US when:1d"),
  "Google News Dollar Bonds": GN + encodeURIComponent("(\"dollar index\" OR DXY OR \"10-year Treasury yield\") when:1d"),
  "Google News Crypto Policy": GN + encodeURIComponent("(SEC OR Congress OR \"White House\" OR Trump OR stablecoin) (crypto OR bitcoin) when:1d"),
  "Google News Bitcoin": GN + encodeURIComponent("bitcoin price when:1d"),
  "Reuters Bloomberg": GN + encodeURIComponent("(site:reuters.com OR site:bloomberg.com) (bitcoin OR crypto OR Fed OR Treasury OR dollar OR inflation) when:1d"),
  "Arabic Economy": GN_AR("(site:aljazeera.net/ebusiness OR site:asharqbusiness.com OR site:alarabiya.net/aswaq) when:1d")
};

// Owner rules: never Europe or Israel, no wars, no sports, non-halal coins dropped.
const BANNED = ["israel", "gaza", "netanyahu", "hamas", "hezbollah", "europe", "european", " eu ", "ecb", "lagarde", "eurozone",
  "germany", "france", "italy", "spain", "britain", " uk ", "إسرائيل", "اسرائيل", "غزة", "أوروب", "اوروب", "اليورو", "بريطانيا", "ألمانيا", "فرنسا",
  "dogecoin", "shiba", "memecoin", "meme coin", "pepe", "doge "];
const banned = t => { const s = " " + String(t || "").toLowerCase() + " "; return BANNED.some(w => s.includes(w)); };

// ---------- helpers ----------
async function get(url, asJson) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return asJson ? r.json() : r.text();
}
const decode = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;|&#8217;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n, d = 0) => fmt(n, d) + "$";
const pct = (n, d = 1) => (n > 0 ? "+" : "") + fmt(n, d) + "%";
const ammanNow = () => new Date(Date.now() + 3 * 3600 * 1000);   // UTC fields = Amman wall clock (UTC+3)
const dayAr = d => d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
const isoDay = d => d.toISOString().slice(0, 10);
const outlet = h => /^(Google News|Reuters Bloomberg|Arabic Economy)/.test(h.source) && h.title.includes(" - ") ? h.title.split(" - ").pop().trim() : h.source;

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"); }

// ---------- market data (each value carries its source; missing values are reported, never guessed) ----------
async function dxySeries() {   // Yahoo Finance (ICE US Dollar Index, DX-Y.NYB) daily closes
  const j = await get("https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=1mo&interval=1d", true);
  const r = j.chart.result[0];
  return r.timestamp.map((t, i) => ({ day: isoDay(new Date(t * 1000)), close: r.indicators.quote[0].close[i] })).filter(x => x.close);
}

async function tenYearSeries() {   // US Treasury official daily par yield curve (10-year)
  const out = [];
  const now = new Date();
  for (const back of [1, 0]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const ym = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0");
    try {
      const xml = await get("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=" + ym);
      for (const m of xml.matchAll(/<m:properties>([\s\S]*?)<\/m:properties>/g)) {
        const day = (m[1].match(/<d:NEW_DATE[^>]*>(\d{4}-\d{2}-\d{2})/) || [])[1];
        const y = Number((m[1].match(/<d:BC_10YEAR[^>]*>([\d.]+)</) || [])[1]);
        if (day && y) out.push({ day, close: y });
      }
    } catch (e) { console.log("[telegram] treasury", ym, "failed:", e.message); }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

async function tnxSeries() {   // Yahoo ^TNX as a cross-check for the Treasury figure
  const j = await get("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1mo&interval=1d", true);
  const r = j.chart.result[0];
  return r.timestamp.map((t, i) => ({ day: isoDay(new Date(t * 1000)), close: r.indicators.quote[0].close[i] })).filter(x => x.close);
}

async function fearGreed() {
  const j = await get("https://api.alternative.me/fng/?limit=8", true);
  return j.data.map(x => ({ value: Number(x.value), label: x.value_classification, day: isoDay(new Date(Number(x.timestamp) * 1000)) }));
}

const FG_AR = { "Extreme Fear": "خوف شديد", "Fear": "خوف", "Neutral": "محايد", "Greed": "طمع", "Extreme Greed": "طمع شديد" };

async function etfFlows() {   // Farside: daily total net flow of US spot bitcoin ETFs, in $ million
  let html, src;
  for (const u of ["https://farside.co.uk/bitcoin-etf-flow-all-data/", "https://farside.co.uk/btc/"]) {
    try { html = await get(u); src = u; break; } catch (e) { console.log("[telegram] farside", u, "failed:", e.message); }
  }
  if (!html) throw new Error("Farside not reachable");
  const rows = [];
  for (const tr of html.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const cells = [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => decode(c[1]));
    if (cells.length < 3) continue;
    const dm = cells[0].match(/^(\d{1,2}) (\w{3}) (\d{4})$/);
    if (!dm) continue;
    const day = new Date(dm[1] + " " + dm[2] + " " + dm[3] + " UTC");
    const raw = cells[cells.length - 1].replace(/,/g, "");
    if (isNaN(day) || !raw || raw === "-") continue;
    const neg = /^\(.*\)$/.test(raw);
    const v = Number(raw.replace(/[()]/g, ""));
    if (isFinite(v)) rows.push({ day: isoDay(day), total: neg ? -v : v });
  }
  if (!rows.length) throw new Error("Farside table not parsed");
  return { rows: rows.sort((a, b) => a.day.localeCompare(b.day)), src };
}

async function btcWeekRange() {   // 7-day high/low from CoinGecko and Kraken; both must agree within 1%
  const res = {};
  try {
    const j = await get("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7", true);
    const p = j.prices.map(x => x[1]);
    res.CoinGecko = { low: Math.min(...p), high: Math.max(...p), first: p[0], last: p[p.length - 1] };
  } catch (e) { console.log("[telegram] coingecko range failed:", e.message); }
  try {
    const j = await get("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440", true);
    const k = Object.values(j.result).find(Array.isArray).slice(-7);
    res.Kraken = { low: Math.min(...k.map(x => Number(x[3]))), high: Math.max(...k.map(x => Number(x[2]))), first: Number(k[0][1]), last: Number(k[k.length - 1][4]) };
  } catch (e) { console.log("[telegram] kraken range failed:", e.message); }
  return res;
}

async function usCalendar() {   // upcoming high-impact US events (Forex Factory feed, same as calendar.js)
  const out = [];
  for (const u of ["https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"]) {
    try {
      for (const e of await get(u, true)) {
        const d = new Date(e.date);
        if (e.country === "USD" && e.impact === "High" && d > new Date()) out.push({ day: isoDay(new Date(d.getTime() + 3 * 3600 * 1000)), title: e.title, forecast: e.forecast || "", previous: e.previous || "" });
      }
    } catch (e) { console.log("[telegram] calendar", u, "failed:", e.message); }
  }
  return out.slice(0, 12);
}

async function headlines(hours) {
  const since = Date.now() - hours * 3600 * 1000;
  const all = [];
  for (const [name, url] of Object.entries(FEEDS)) {
    try {
      const xml = await get(url);
      for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
        const it = m[0];
        const title = decode((it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
        const link = decode((it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]);
        const ts = new Date(decode((it.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1])).getTime();
        if (title && link && ts >= since && !banned(title)) all.push({ title, link, source: name, ts });
      }
    } catch (e) { console.log("[telegram] feed", name, "failed:", e.message); }
    if (url.startsWith("https://news.google.com")) await new Promise(r => setTimeout(r, 1500));
  }
  const seen = new Set();
  return all.sort((a, b) => b.ts - a.ts).filter(h => { const k = h.title.toLowerCase().slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 140);
}

// ---------- Gemini (same model discovery as alerts.js) ----------
async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY secret is missing");
  let models = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
  try {
    const lm = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + key, true);
    const names = (lm.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.split("/").pop()).filter(n => /flash/.test(n) && !/image|tts|live|audio|embedding|exp/.test(n));
    models = [...new Set([...models, ...names])].slice(0, 6);
  } catch (e) { console.log("[telegram] model list failed", e.message); }
  let last;
  for (const model of [...models, ...models.slice(0, 2)]) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json" } }),
        signal: AbortSignal.timeout(90000)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      console.log("[telegram] model used:", model);
      return parsed;
    } catch (e) { last = model + ": " + e.message; console.log("[telegram] model failed", last); await new Promise(r => setTimeout(r, 6000)); }
  }
  throw new Error("No Gemini model worked (" + last + ")");
}

const STYLE = [
  "LANGUAGE: simple Modern Standard Arabic (فصحى بسيطة), short sentences, Western digits 0-9 only, write money as 78,824$ and percent as 2.1%.",
  "MONEY: always use the $ sign and never the word دولار: 78,824$ or 1.79 مليار$ or 669.2 مليون$. Spell names correctly: البيتكوين, الفيدرالي.",
  "Every line must start with an Arabic word (names of people and companies in Arabic letters).",
  "FACTS: use ONLY numbers and dates that appear in DATA or HEADLINES below. Never invent a number, a date, a name or a quote.",
  "If two sources give different numbers, write نحو before the number and explain the difference in notes.",
  "NO buy/sell advice, NO price predictions. Say نراقب, never نتوقع. No hashtags, no emoji.",
  "politics: only when a real political or regulatory factor is directly linked to the story; otherwise null (never invent one)."
].join("\n");

// ---------- number check: every number the model wrote must exist in the source material ----------
function numbersIn(s) {
  return (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(x => Number(x.replace(/,/g, ""))).filter(isFinite);
}
function unverifiedNumbers(texts, sourceBlob) {
  const src = numbersIn(sourceBlob);
  const bad = new Set();
  for (const t of texts) for (const n of numbersIn(t)) {
    if (n <= 31 || (n >= 2020 && n <= 2035)) continue;   // day numbers and years: dates are checked by the reviewer
    if (!src.some(s => Math.abs(n - s) <= Math.max(Math.abs(s) * 0.001, 0.011))) bad.add(fmt(n, n % 1 ? 2 : 0));
  }
  return [...bad];
}

// ---------- DAILY: الخبر في 3 أسطر ----------
async function buildDaily() {
  const [heads, prices, dxy, ten, tnx, fg, cal] = await Promise.all([
    headlines(26),
    verifiedPrices(["BTC"]).catch(() => ({})),
    dxySeries().catch(e => (console.log("[telegram] dxy failed", e.message), [])),
    tenYearSeries().catch(() => []),
    tnxSeries().catch(() => []),
    fearGreed().catch(() => []),
    usCalendar()
  ]);
  const etf = await etfFlows().catch(e => (console.log("[telegram] etf failed", e.message), null));
  if (heads.length < 5) throw new Error("too few headlines (" + heads.length + ")");

  const data = [];
  const check = [];
  if (prices.BTC) data.push("BTC price now: " + money(prices.BTC.price) + (prices.BTC.change != null ? " (24h " + pct(prices.BTC.change) + ")" : "") + " — verified by " + prices.BTC.sources.join("+"));
  else check.push("سعر البيتكوين الحالي غير مؤكد من مصدرين");
  const d = dxy[dxy.length - 1];
  if (d) data.push("DXY dollar index close " + d.day + ": " + fmt(d.close, 2) + (dxy.length > 1 ? " (previous close " + fmt(dxy[dxy.length - 2].close, 2) + ")" : "") + " — Yahoo Finance");
  else check.push("مؤشر الدولار DXY غير متاح من المصدر");
  const t = ten[ten.length - 1];
  if (t) data.push("US 10-year yield " + t.day + ": " + fmt(t.close, 2) + "% (previous " + (ten.length > 1 ? fmt(ten[ten.length - 2].close, 2) + "%" : "n/a") + ") — US Treasury");
  else check.push("عائد السندات 10 سنوات غير متاح من وزارة الخزانة");
  const x = tnx[tnx.length - 1];
  if (t && x && Math.abs(t.close - x.close) > 0.05) check.push("عائد 10 سنوات: الخزانة " + fmt(t.close, 2) + "% مقابل ياهو " + fmt(x.close, 2) + "%");
  if (fg[0]) data.push("Fear & Greed index today: " + fg[0].value + " (" + fg[0].label + ") — alternative.me");
  if (etf) { const e = etf.rows[etf.rows.length - 1]; data.push("Spot bitcoin ETF net flow " + e.day + ": " + fmt(e.total, 1) + " million $ — Farside"); }
  else check.push("تدفقات صناديق ETF: موقع Farside لم يفتح، أي رقم ETF في المسودة يحتاج تأكيداً");
  const calLines = cal.map(c => c.day + ": " + c.title + (c.forecast ? " (forecast " + c.forecast + ", previous " + c.previous + ")" : ""));

  const list = heads.map((h, i) => (i + 1) + ". [" + h.source + ", " + new Date(h.ts).toISOString().slice(0, 16).replace("T", " ") + " UTC] " + h.title);
  const today = ammanNow();
  const prompt = [
    "You are the news editor of Mr_Amwal, an Arabic crypto/economy Telegram channel. Today is " + isoDay(today) + " (" + dayAr(today) + ").",
    "TASK: from the HEADLINES of the last 24 hours choose the ONE most important story for crypto investors",
    "(bitcoin and the crypto market, bitcoin ETF flows, the Fed and interest rates, inflation and jobs, the dollar index DXY,",
    "the US 10-year yield, politics and regulation that move crypto). Prefer hard news with a clear number. No opinion pieces, no questions.",
    "Then pick two DIFFERENT alternative stories (title only).",
    STYLE,
    "FIELDS:",
    "- headline: one line, max 12 words, containing the most important number.",
    "- what: one or two sentences: the event, the number, the date.",
    "- econ: the economic reason it matters and who is affected (one sentence).",
    "- politics: one sentence or null.",
    "- impact: عالي or متوسط (how strongly this story moves the crypto market).",
    "- dollar: one short phrase with the DXY level from DATA and what we watch, or null if the dollar is not relevant to this story.",
    "- bonds: one short phrase with the 10-year yield from DATA and what we watch, or null if not relevant.",
    "- next_date: a specific date of the next related event, written like 26 نوفمبر, taken from CALENDAR or HEADLINES; next_event: what happens then.",
    "- refs: numbers of the headlines used. alternatives: two Arabic titles. alt_refs: their headline numbers.",
    "- notes: list of short Arabic notes about any number that differs between sources or needs confirmation (may be empty).",
    "Reply with JSON only: {\"headline\":\"\",\"what\":\"\",\"econ\":\"\",\"politics\":null,\"impact\":\"عالي\",\"dollar\":null,\"bonds\":null,\"next_date\":\"\",\"next_event\":\"\",\"refs\":[1],\"alternatives\":[\"\",\"\"],\"alt_refs\":[2,3],\"notes\":[]}",
    "", "DATA:", ...data, "", "CALENDAR (upcoming high-impact US events, Amman dates):", ...(calLines.length ? calLines : ["none found"]), "", "HEADLINES:", ...list
  ].join("\n");

  const j = await askGemini(prompt);
  for (const k of ["headline", "what", "econ", "next_date", "next_event"]) if (!j[k] || !String(j[k]).trim()) throw new Error("model left " + k + " empty");
  const clean = v => (v == null || /^(null|none|لا يوجد|-)$/i.test(String(v).trim())) ? null : String(v).trim();

  const lines = ["📰 الخبر في 3 أسطر", "🔴 " + j.headline.trim(), "", "❓ 1) ماذا حدث؟", j.what.trim(), "", "🧠 2) لماذا يهم؟", "💰 اقتصادياً: " + j.econ.trim()];
  if (clean(j.politics)) lines.push("🏛 سياسياً: " + clean(j.politics));
  lines.push("", "👀 3) ماذا نراقب؟");
  if (clean(j.dollar)) lines.push("💵 الدولار: " + clean(j.dollar));
  if (clean(j.bonds)) lines.push("📉 السندات: " + clean(j.bonds));
  lines.push("🗓 " + j.next_date.trim() + ": " + j.next_event.trim(), "", "ℹ️ " + DISCLAIMER);
  const draft = lines.join("\n");

  const pickRefs = r => (Array.isArray(r) ? r : []).map(n => heads[Number(n) - 1]).filter(Boolean);
  const srcs = pickRefs(j.refs);
  const blob = data.join("\n") + "\n" + calLines.join("\n") + "\n" + heads.map(h => h.title).join("\n");
  const unv = unverifiedNumbers([j.headline, j.what, j.econ, j.politics, j.dollar, j.bonds, j.next_event].filter(Boolean), blob);
  const alts = (j.alternatives || []).slice(0, 2);
  const altSrc = pickRefs(j.alt_refs);
  const notes = [
    "ملاحظات مسودة «الخبر في 3 أسطر» — " + dayAr(today),
    "مسودة للمراجعة فقط، لا تُنشر قبل الموافقة.",
    "",
    "المصادر:",
    ...(srcs.length ? srcs.map(h => "• " + outlet(h) + ": " + h.link) : ["• لم يحدد النموذج مصدراً — يحتاج تأكيداً"]),
    "• أرقام السوق: " + ["CoinGecko/Coinbase/Kraken", d && "Yahoo Finance (DXY)", t && "وزارة الخزانة الأميركية (10 سنوات)", etf && "Farside", fg[0] && "alternative.me"].filter(Boolean).join("، "),
    "",
    "خبران بديلان:",
    ...alts.map((a, i) => (i + 1) + ") " + a + (altSrc[i] ? " — " + altSrc[i].link : "")),
    "",
    "يحتاج تأكيداً:",
    ...([...unv.map(n => "الرقم " + n + " غير موجود في المصادر المجمعة"), ...check, ...(j.notes || [])].map(s => "• " + s)),
  ];
  if (notes[notes.length - 1] === "يحتاج تأكيداً:") notes.push("• لا شيء ظاهر — راجعي التاريخ والأرقام قبل النشر");
  const watch = [];
  if (clean(j.dollar)) watch.push({ label: "الدولار", text: clean(j.dollar) });
  if (clean(j.bonds)) watch.push({ label: "السندات", text: clean(j.bonds) });
  watch.push({ label: j.next_date.trim(), text: j.next_event.trim() });
  const imp = String(j.impact || "").trim();
  const card = { headline: j.headline.trim(), what: j.what.trim(), econ: j.econ.trim(), politics: clean(j.politics), impact: /^(عالي|متوسط)$/.test(imp) ? imp : null,
    watch, date: dayAr(today) + " " + today.getUTCFullYear(), sources: [...new Set(srcs.map(outlet))].slice(0, 3).join(" · ") };
  return { draft, notes: notes.join("\n"), card };
}

// ---------- WEEKLY: أسبوع الكريبتو بـ 5 أرقام ----------
function weekBounds() {   // Monday..Friday of the week that ends with the Friday before this Saturday (Amman date)
  const now = ammanNow();
  const dow = now.getUTCDay();                      // 6 = Saturday
  const fri = new Date(now); fri.setUTCDate(now.getUTCDate() - ((dow + 2) % 7));
  const mon = new Date(fri); mon.setUTCDate(fri.getUTCDate() - 4);
  const prevFri = new Date(fri); prevFri.setUTCDate(fri.getUTCDate() - 7);
  return { mon: isoDay(mon), fri: isoDay(fri), prevFri: isoDay(prevFri), monAr: dayAr(mon), friAr: dayAr(fri) };
}
const closeOn = (series, day) => [...series].reverse().find(x => x.day <= day);
const trendAr = (now, before, d, unit) => {
  const diff = now - before;
  if (Math.abs(diff) < Math.pow(10, -d) / 2) return "دون تغيير عن الأسبوع السابق";
  return (diff > 0 ? "صعوداً " : "هبوطاً ") + "من " + fmt(before, d) + unit + " قبل أسبوع";
};

async function buildWeekly() {
  const w = weekBounds();
  const [range, dxy, ten, tnx, fg, cal, heads] = await Promise.all([
    btcWeekRange(),
    dxySeries().catch(() => []),
    tenYearSeries().catch(() => []),
    tnxSeries().catch(() => []),
    fearGreed().catch(() => []),
    usCalendar(),
    headlines(7 * 24)
  ]);
  const etf = await etfFlows().catch(e => (console.log("[telegram] etf failed", e.message), null));
  const check = [];
  const facts = {};

  // 1) number of the week: BTC 7-day low / high / change
  const cg = range.CoinGecko, kr = range.Kraken;
  if (cg || kr) {
    const a = cg || kr, b = kr || cg;
    const agree = (x, y) => Math.abs(x - y) / y <= 0.01;
    const n = (x, y) => (agree(x, y) ? "" : "نحو ") + money((x + y) / 2);
    facts.low = n(a.low, b.low); facts.high = n(a.high, b.high);
    facts.change = pct((a.last - a.first) / a.first * 100);
    if (!(cg && kr)) check.push("مدى سعر البيتكوين من مصدر واحد فقط (" + (cg ? "CoinGecko" : "Kraken") + ")");
    else if (!agree(cg.low, kr.low) || !agree(cg.high, kr.high)) check.push("مدى البيتكوين: CoinGecko " + money(cg.low) + "–" + money(cg.high) + " مقابل Kraken " + money(kr.low) + "–" + money(kr.high));
  } else check.push("سعر البيتكوين الأسبوعي غير متاح");

  // 2) ETF weekly net flow (Mon..Fri)
  let n2 = "غير متاح — يحتاج تأكيداً من Farside";
  if (etf) {
    const days = etf.rows.filter(r => r.day >= w.mon && r.day <= w.fri);
    if (days.length) {
      const sum = days.reduce((s, r) => s + r.total, 0);
      n2 = (sum >= 0 ? "صافي دخول " : "صافي خروج ") + fmt(Math.abs(sum), 1) + " مليون$" + (days.length < 5 ? " (" + days.length + " من 5 أيام تداول)" : "");
      if (days.length < 5) check.push("تدفقات ETF: البيانات تغطي " + days.length + " أيام فقط");
    } else check.push("تدفقات ETF: لا توجد بيانات للأسبوع في Farside بعد");
  } else check.push("تدفقات ETF: موقع Farside لم يفتح من GitHub");

  // 3) DXY Friday close and trend
  let n3 = "غير متاح — يحتاج تأكيداً من Trading Economics";
  const dF = closeOn(dxy, w.fri), dP = closeOn(dxy, w.prevFri);
  if (dF && dF.day >= w.mon) { n3 = fmt(dF.close, 2) + " عند إغلاق الجمعة" + (dP ? "، " + trendAr(dF.close, dP.close, 2, "") : ""); check.push("مؤشر الدولار من Yahoo Finance — قارنيه مع Trading Economics قبل النشر"); }
  else check.push("إغلاق الجمعة لمؤشر الدولار غير متاح");

  // 4) US 10Y Friday close and trend
  let n4 = "غير متاح — يحتاج تأكيداً";
  const tF = closeOn(ten, w.fri), tP = closeOn(ten, w.prevFri), xF = closeOn(tnx, w.fri);
  if (tF && tF.day >= w.mon) {
    const differ = xF && Math.abs(tF.close - xF.close) > 0.05;
    n4 = (differ ? "نحو " : "") + fmt(tF.close, 2) + "% عند إغلاق الجمعة" + (tP ? "، " + trendAr(tF.close, tP.close, 2, "%") : "");
    if (differ) check.push("عائد 10 سنوات: الخزانة " + fmt(tF.close, 2) + "% مقابل ياهو " + fmt(xF.close, 2) + "%");
  } else check.push("إغلاق الجمعة لعائد 10 سنوات غير متاح");

  // 5) Fear & Greed today vs a week ago
  let n5 = "غير متاح — يحتاج تأكيداً من alternative.me";
  if (fg[0]) n5 = fg[0].value + " (" + (FG_AR[fg[0].label] || fg[0].label) + ")" + (fg[7] ? "، مقابل " + fg[7].value + " قبل أسبوع" : "");

  const data = [
    "Week: " + w.mon + " to " + w.fri,
    facts.low ? "BTC 7-day low " + facts.low + ", high " + facts.high + ", 7-day change " + facts.change : "BTC range: n/a",
    "BTC spot ETF weekly net flow: " + n2,
    "DXY: " + n3, "US 10Y: " + n4, "Fear & Greed: " + n5
  ];
  const calLines = cal.map(c => c.day + ": " + c.title);
  const list = heads.slice(0, 100).map((h, i) => (i + 1) + ". [" + h.source + "] " + h.title);
  const prompt = [
    "You are the editor of Mr_Amwal, an Arabic crypto/economy Telegram channel, writing the weekly post «أسبوع الكريبتو بـ 5 أرقام» for " + w.monAr + " – " + w.friAr + ".",
    STYLE,
    "FIELDS:",
    "- n1_label: the most striking BTC number of the week, as one short Arabic phrase built ONLY from the BTC low/high/change in DATA (e.g. أدنى سعر للبيتكوين هذا الأسبوع ...).",
    "- read1, read2: two short sentences on what the week meant (Mr_Amwal reading), based on DATA and HEADLINES.",
    "- politics: one sentence about a real political/regulatory factor of the week, or null.",
    "- watch: one sentence starting with الدولار that names what we watch in the dollar and bonds and the nearest important date from CALENDAR (written like 26 نوفمبر).",
    "- refs: numbers of the headlines used. notes: Arabic notes about anything that needs confirmation.",
    "Reply with JSON only: {\"n1_label\":\"\",\"read1\":\"\",\"read2\":\"\",\"politics\":null,\"watch\":\"\",\"refs\":[],\"notes\":[]}",
    "", "DATA:", ...data, "", "CALENDAR:", ...(calLines.length ? calLines : ["none found"]), "", "HEADLINES (last 7 days):", ...list
  ].join("\n");
  const j = await askGemini(prompt);
  for (const k of ["n1_label", "read1", "read2", "watch"]) if (!j[k] || !String(j[k]).trim()) throw new Error("model left " + k + " empty");
  const pol = j.politics && !/^(null|none)$/i.test(String(j.politics).trim()) ? String(j.politics).trim() : null;

  const lines = [
    "📊 أسبوع الكريبتو بـ 5 أرقام", "🗓 من " + w.monAr + " إلى " + w.friAr, "",
    "1️⃣ رقم الأسبوع: " + j.n1_label.trim(),
    "2️⃣ تدفقات صناديق ETF للبيتكوين: " + n2,
    "3️⃣ مؤشر الدولار DXY: " + n3,
    "4️⃣ عائد السندات الأميركية 10 سنوات: " + n4,
    "5️⃣ مؤشر الخوف والطمع: " + n5,
    "", "🧠 قراءة Mr_Amwal", j.read1.trim(), j.read2.trim()
  ];
  if (pol) lines.push("🏛 سياسياً: " + pol);
  lines.push("👀 نراقب: " + j.watch.trim().replace(/^نراقب:?\s*/, ""), "", "ℹ️ " + DISCLAIMER);

  const srcs = (j.refs || []).map(n => heads[Number(n) - 1]).filter(Boolean);
  const blob = data.join("\n") + "\n" + calLines.join("\n") + "\n" + heads.map(h => h.title).join("\n");
  const unv = unverifiedNumbers([j.n1_label, j.read1, j.read2, pol, j.watch].filter(Boolean), blob);
  const notes = [
    "ملاحظات مسودة «أسبوع الكريبتو بـ 5 أرقام» — " + w.monAr + " – " + w.friAr,
    "مسودة للمراجعة فقط، النشر 20:30 بعد الموافقة. الصورة تُضاف لاحقاً.",
    "",
    "مصادر الأرقام:",
    "• رقم الأسبوع: CoinGecko + Kraken",
    "• تدفقات ETF: " + (etf ? etf.src : "Farside (لم يفتح)"),
    "• الدولار DXY: Yahoo Finance (قارني مع Trading Economics)",
    "• عائد 10 سنوات: وزارة الخزانة الأميركية + Yahoo",
    "• الخوف والطمع: alternative.me",
    ...(srcs.length ? ["", "أخبار القراءة:", ...srcs.slice(0, 5).map(h => "• " + h.source + ": " + h.link)] : []),
    "",
    "يحتاج تأكيداً:",
    ...[...unv.map(n => "الرقم " + n + " غير موجود في المصادر المجمعة"), ...check, ...(j.notes || [])].map(s => "• " + s)
  ];
  return { draft: lines.join("\n"), notes: notes.join("\n") };
}

// ---------- main ----------
(async () => {
  const mode = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!["daily", "weekly"].includes(mode)) { console.error("usage: node src/telegram.js daily|weekly [--dry]"); process.exit(2); }
  const state = loadState();
  const today = isoDay(ammanNow());
  if (!dry && !process.argv.includes("--force") && state[mode] === today) { console.log("[telegram] " + mode + " draft already sent today"); process.exit(0); }
  try {
    const { draft, notes, card } = mode === "daily" ? await buildDaily() : await buildWeekly();
    console.log("\n===== DRAFT =====\n" + draft + "\n\n===== NOTES =====\n" + notes + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + draft + "\n\n" + notes + "\n```\n");
    let imagePath = null;
    if (card) {
      try {
        fs.mkdirSync(path.join(ROOT, "out"), { recursive: true });
        imagePath = await require("./telegram-card").renderCard(card, path.join(ROOT, "out", "telegram-" + mode + ".png"));
        console.log("[telegram] card rendered");
      } catch (e) { imagePath = null; console.log("[telegram] card failed, text only:", e.message); }
    }
    if (dry) return;
    const wa = require("./send");
    let sentImage = false;
    if (imagePath) {
      try { await wa.sendToSelf({ imagePath, caption: draft.length <= 950 ? draft : "" }); sentImage = true; }
      catch (e) { console.log("[telegram] image send failed, text only:", e.message); }
    }
    if (!sentImage || draft.length > 950) await wa.sendToSelf({ text: draft });
    await new Promise(r => setTimeout(r, 3000));
    await wa.sendToSelf({ text: notes });
    state[mode] = today;
    saveState(state);
    console.log("[telegram] sent");
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exit(1);
  }
})();
