// US economic calendar to the owner's own WhatsApp chat (runs on GitHub Actions).
// Source: the public Forex Factory weekly calendar feed (nfs.faireconomy.media), US events only.
// Every morning: today's and tomorrow's important US releases/decisions with forecast and previous.
// Mondays: also the most important US events of the whole week.
// Usage: node src/calendar.js pick   -> writes out/calendar.json (messages) and sets found=true/false
//        node src/calendar.js send   -> sends each message to the WhatsApp self chat

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'calendar.json');
const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];
const AMMAN_OFFSET_H = 4; // times are shown in Dubai time (UTC+4 all year)

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

// Arabic names for the usual US releases (checked in order; first match wins).
const NAMES = [
  [/federal funds rate/i, 'قرار الفائدة الأمريكية من الفيدرالي'],
  [/fomc statement/i, 'بيان الفيدرالي بعد قرار الفائدة'],
  [/fomc press conference/i, 'المؤتمر الصحفي لرئيس الفيدرالي'],
  [/fomc meeting minutes/i, 'محضر اجتماع الفيدرالي'],
  [/fomc economic projections/i, 'توقعات الفيدرالي الاقتصادية'],
  [/powell speaks|fed chair/i, 'كلمة رئيس الفيدرالي'],
  [/core cpi/i, 'التضخم الأساسي (مؤشر أسعار المستهلك الأساسي)'],
  [/\bcpi\b/i, 'التضخم (مؤشر أسعار المستهلك)'],
  [/core ppi/i, 'مؤشر أسعار المنتجين الأساسي'],
  [/\bppi\b/i, 'مؤشر أسعار المنتجين'],
  [/core pce/i, 'مؤشر نفقات الاستهلاك الأساسي (مقياس التضخم المفضل للفيدرالي)'],
  [/\bpce\b/i, 'مؤشر نفقات الاستهلاك الشخصي'],
  [/non-farm employment change|nonfarm payrolls/i, 'الوظائف غير الزراعية'],
  [/adp non-farm/i, 'توظيف القطاع الخاص من ADP'],
  [/unemployment rate/i, 'معدل البطالة'],
  [/unemployment claims/i, 'طلبات إعانة البطالة الأسبوعية'],
  [/average hourly earnings/i, 'متوسط الأجور بالساعة'],
  [/jolts/i, 'الوظائف الشاغرة (JOLTS)'],
  [/gdp/i, 'الناتج المحلي الإجمالي'],
  [/retail sales/i, 'مبيعات التجزئة'],
  [/ism manufacturing/i, 'مؤشر التصنيع ISM'],
  [/ism services|ism non-manufacturing/i, 'مؤشر الخدمات ISM'],
  [/consumer sentiment|uom/i, 'ثقة المستهلك (جامعة ميشيغان)'],
  [/cb consumer confidence/i, 'ثقة المستهلك (كونفرنس بورد)'],
  [/durable goods/i, 'طلبيات السلع المعمرة'],
  [/building permits/i, 'تصاريح البناء'],
  [/housing starts/i, 'بدايات الإسكان'],
  [/new home sales/i, 'مبيعات المنازل الجديدة'],
  [/existing home sales/i, 'مبيعات المنازل القائمة'],
  [/crude oil inventories/i, 'مخزونات النفط الأمريكية'],
];

function arabicName(title) {
  for (const [re, name] of NAMES) if (re.test(title)) return name;
  return 'حدث اقتصادي أمريكي: ' + title; // starts with Arabic so the line direction stays right
}

function amman(d) {
  // Returns a Date whose UTC fields equal Amman wall-clock time.
  return new Date(d.getTime() + AMMAN_OFFSET_H * 3600 * 1000);
}

function dayKey(d) {
  const a = amman(d);
  return a.getUTCFullYear() + '-' + a.getUTCMonth() + '-' + a.getUTCDate();
}

function timeAr(d) {
  const a = amman(d);
  let h = a.getUTCHours();
  const m = String(a.getUTCMinutes()).padStart(2, '0');
  const pm = h >= 12;
  h = h % 12 || 12;
  return h + ':' + m + (pm ? ' مساءً' : ' صباحًا');
}

function dateAr(d) {
  const a = amman(d);
  return DAYS[a.getUTCDay()] + ' ' + a.getUTCDate() + ' ' + MONTHS[a.getUTCMonth()];
}

function important(e) {
  if (e.country !== 'USD') return false;
  if (e.impact === 'High') return true;
  // Owner 20 Nov: every Medium US event too (consumer sentiment, Fed speakers, PMIs...).
  return e.impact === 'Medium';
}

async function loadEvents() {
  const all = [];
  for (const url of FEEDS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 whatsapp-calendar' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const list = await r.json();
      for (const e of list) {
        const d = new Date(e.date);
        if (!isNaN(d) && important(e)) all.push({ ...e, d });
      }
    } catch (err) {
      console.log('[calendar] feed failed:', url, err.message);
    }
  }
  // Owner 21 Nov: Forex Factory has no next-week feed (404), so the Saturday week-ahead was empty.
  // Fill every day Forex Factory does not cover from TradingView's economic calendar.
  try {
    const have = new Set(all.map(e => e.d.toISOString().slice(0, 10)));
    const from = new Date(Date.now() - 12 * 3600000);
    const to = new Date(Date.now() + 9 * 86400000);
    const tv = 'https://economic-calendar.tradingview.com/events?from=' + from.toISOString() + '&to=' + to.toISOString() + '&countries=US';
    const r = await fetch(tv, { headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = (await r.json()).result || [];
    let added = 0;
    for (const x of list) {
      const d = new Date(x.date);
      if (isNaN(d) || have.has(d.toISOString().slice(0, 10))) continue;
      if (x.importance < 0 || /auction|bill|bid-to-cover|allotted/i.test(x.title)) continue;
      all.push({ title: x.title, country: 'USD', date: x.date, impact: x.importance >= 1 ? 'High' : 'Medium',
        forecast: x.forecast == null ? '' : String(x.forecast), previous: x.previous == null ? '' : String(x.previous), d });
      added++;
    }
    console.log('[calendar] TradingView added', added, 'events');
  } catch (err) {
    console.log('[calendar] TradingView failed:', err.message);
  }
  const seen = new Set();
  return all
    .sort((a, b) => a.d - b.d)
    .filter(e => { const k = e.title + e.date; if (seen.has(k)) return false; seen.add(k); return true; });
}

function num(v) {
  // 225K -> 225 ألف, 1.2M -> 1.2 مليون, 3B -> 3 مليار
  return String(v).replace(/^(-?[\d.,]+)K$/i, '$1 ألف').replace(/^(-?[\d.,]+)M$/i, '$1 مليون').replace(/^(-?[\d.,]+)B$/i, '$1 مليار');
}

function block(e) {
  // One event as a tidy block; every line starts with an Arabic word so WhatsApp keeps it right-to-left.
  const out = ['▪️ *' + arabicName(e.title) + '*', '   الموعد: الساعة ' + timeAr(e.d)];
  if (e.forecast) out.push('   التوقع: ' + num(e.forecast));
  if (e.previous) out.push('   القراءة السابقة: ' + num(e.previous));
  return out.join('\n');
}

function dayList(list, emptyText) {
  return list.length ? list.map(block).join('\n\n') : 'لا توجد بيانات أمريكية مؤثرة ' + emptyText + '.';
}

const FOOTER = '\n\n_جميع المواعيد بتوقيت دبي._';

function buildMessages(events, now) {
  const msgs = [];
  const todayKey = dayKey(now);
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const tomorrowKey = dayKey(tomorrow);
  const today = events.filter(e => dayKey(e.d) === todayKey);
  const tmr = events.filter(e => dayKey(e.d) === tomorrowKey);

  // Monday (Amman): the whole week, grouped by day
  // Owner 18 Nov: the whole coming week every Saturday (14:00 Amman) instead of Mondays; weekdays get today + tomorrow.
  if (amman(now).getUTCDay() === 6) {
    const endDay = new Date(now.getTime() + 6 * 24 * 3600 * 1000);
    const end = now.getTime() + 7 * 24 * 3600 * 1000;
    const week = events.filter(e => e.d.getTime() >= now.getTime() - 12 * 3600 * 1000 && e.d.getTime() <= end);
    const days = [];
    for (const e of week) {
      const k = dayKey(e.d);
      let g = days.find(x => x.k === k);
      if (!g) { g = { k, d: e.d, list: [] }; days.push(g); }
      g.list.push(e);
    }
    const body = days.length
      ? days.map(g => '📌 *' + dateAr(g.d) + '*\n' + g.list.map(block).join('\n\n')).join('\n\n────────\n\n')
      : 'لا توجد بيانات أمريكية مؤثرة هذا الأسبوع.';
    msgs.push(
      '🗓️ *أجندة الأسبوع الاقتصادية الأمريكية*\n' +
      'من ' + dateAr(now) + ' إلى ' + dateAr(endDay) + '\n\n' +
      body + FOOTER
    );
    return msgs; // Saturday: only the week ahead
  }

  msgs.push(
    '📅 *الأجندة الاقتصادية الأمريكية*\n\n' +
    '🔹 *اليوم – ' + dateAr(now) + '*\n' + dayList(today, 'اليوم') +
    '\n\n────────\n\n' +
    '🔸 *غدًا – ' + dateAr(tomorrow) + '*\n' + dayList(tmr, 'غدًا') +
    FOOTER
  );
  return msgs;
}

function setOutput(found) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'found=' + (found ? 'true' : 'false') + '\n');
}

async function pick() {
  const events = await loadEvents();
  console.log('[calendar] important US events loaded:', events.length);
  const msgs = buildMessages(events, new Date());
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(msgs, null, 2));
  msgs.forEach(m => console.log('----\n' + m));
  setOutput(msgs.length > 0);
}

async function send() {
  const msgs = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (!msgs.length) return;
  const wa = require('./send');
  for (const text of msgs) await wa.sendToSelf({ text });
  console.log('[calendar] sent', msgs.length, 'message(s)');
}

if (require.main === module) {
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
}

module.exports = { buildMessages, important, arabicName };
