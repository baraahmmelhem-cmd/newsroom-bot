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
const AMMAN_OFFSET_H = 3; // Asia/Amman is UTC+3 all year

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
  // a few Medium items that traders still watch closely
  return e.impact === 'Medium' && /fomc|powell|fed chair|core pce|jolts|unemployment claims/i.test(e.title);
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
  const seen = new Set();
  return all
    .sort((a, b) => a.d - b.d)
    .filter(e => { const k = e.title + e.date; if (seen.has(k)) return false; seen.add(k); return true; });
}

function line(e, withDay) {
  const nums = [];
  if (e.forecast) nums.push('التوقع ' + e.forecast);
  if (e.previous) nums.push('السابق ' + e.previous);
  const when = (withDay ? dateAr(e.d) + '، ' : '') + 'الساعة ' + timeAr(e.d);
  return '• ' + arabicName(e.title) + ' — ' + when + (nums.length ? ' (' + nums.join('، ') + ')' : '');
}

function buildMessages(events, now) {
  const msgs = [];
  const todayKey = dayKey(now);
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const tomorrowKey = dayKey(tomorrow);
  const today = events.filter(e => dayKey(e.d) === todayKey);
  const tmr = events.filter(e => dayKey(e.d) === tomorrowKey);

  // Monday (Amman): the whole week, Monday to Friday
  if (amman(now).getUTCDay() === 1) {
    const end = now.getTime() + 6 * 24 * 3600 * 1000;
    const week = events.filter(e => e.d.getTime() >= now.getTime() - 12 * 3600 * 1000 && e.d.getTime() <= end);
    msgs.push(
      '*أهم القرارات والبيانات الأمريكية هذا الأسبوع*\n' +
      (week.length ? week.map(e => line(e, true)).join('\n') : 'لا توجد بيانات أمريكية عالية التأثير هذا الأسبوع.') +
      '\n\nالأوقات بتوقيت عمّان.'
    );
  }

  msgs.push(
    '*قرارات اليوم – ' + dateAr(now) + '*\n' +
    (today.length ? today.map(e => line(e, false)).join('\n') : 'لا توجد بيانات أمريكية مهمة اليوم.') +
    '\n\n*قرارات بكرا – ' + dateAr(tomorrow) + '*\n' +
    (tmr.length ? tmr.map(e => line(e, false)).join('\n') : 'لا توجد بيانات أمريكية مهمة بكرا.') +
    '\n\nالأوقات بتوقيت عمّان.'
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
