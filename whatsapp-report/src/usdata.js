// US economic data watcher (Mon-Fri), runs on GitHub Actions after every "Hourly news" run
// and whenever it is dispatched (e.g. by a timer at release time).
// 1) Reminder to WhatsApp before each important US release (with forecast and previous).
// 2) As soon as the result is out: the actual numbers to WhatsApp, and the top-tier
//    releases (Fed decision, CPI, jobs, PCE, GDP) straight to the Mr_Amwal newsroom.
// Usage: node src/usdata.js pick  -> decides what to send, posts to the newsroom, writes out/usdata.json
//        node src/usdata.js send  -> sends the WhatsApp messages from out/usdata.json

const fs = require('fs');
const path = require('path');
const { important, arabicName } = require('./calendar');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'usdata.json');
const STATE = path.join(ROOT, 'usdata-state.json');
const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const SHOW_OFFSET_H = 4;            // times shown in Dubai time
const REMIND_BEFORE_MIN = 65;       // remind when a release is at most this far away
const RESULT_WINDOW_MIN = 6 * 60;   // look for the result up to 6 hours after release
const SITE = 'https://www.mr-amwal.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

// Releases that also go to the newsroom immediately (the strongest of the week).
const TOP_TIER = /federal funds rate|fomc statement|\bcpi\b|non-farm employment|nonfarm|unemployment rate|core pce|\bgdp\b/i;

// English search words per release, to find the published result in the news.
const QUERIES = [
  [/federal funds rate|fomc statement/i, 'Federal Reserve interest rate decision'],
  [/fomc press conference|powell/i, 'Powell press conference'],
  [/fomc meeting minutes/i, 'Fed minutes'],
  [/cpi/i, 'US CPI inflation'],
  [/ppi/i, 'US producer prices PPI'],
  [/pce/i, 'US PCE inflation'],
  [/non-farm|nonfarm|unemployment rate|average hourly/i, 'US nonfarm payrolls jobs report'],
  [/unemployment claims/i, 'US jobless claims'],
  [/adp/i, 'ADP private payrolls'],
  [/jolts/i, 'JOLTS job openings'],
  [/gdp/i, 'US GDP'],
  [/retail sales/i, 'US retail sales'],
  [/ism manufacturing/i, 'ISM manufacturing'],
  [/ism services|non-manufacturing/i, 'ISM services'],
  [/consumer sentiment|uom/i, 'University of Michigan consumer sentiment'],
  [/consumer confidence/i, 'Conference Board consumer confidence'],
  [/durable goods/i, 'US durable goods orders'],
];

function shown(d) { return new Date(d.getTime() + SHOW_OFFSET_H * 3600 * 1000); }
function timeAr(d) {
  const a = shown(d);
  let h = a.getUTCHours();
  const m = String(a.getUTCMinutes()).padStart(2, '0');
  const pm = h >= 12;
  h = h % 12 || 12;
  return h + ':' + m + (pm ? ' مساءً' : ' صباحًا');
}
function num(v) {
  return String(v).replace(/^(-?[\d.,]+)K$/i, '$1 ألف').replace(/^(-?[\d.,]+)M$/i, '$1 مليون').replace(/^(-?[\d.,]+)B$/i, '$1 مليار');
}
function usWeekday(d) {
  const ny = new Date(d.getTime() - 5 * 3600 * 1000); // close enough for Mon-Fri
  const w = ny.getUTCDay();
  return w >= 1 && w <= 5;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { reminded: {}, done: {} }; }
}
function saveState(s) {
  const cut = Date.now() - 8 * 24 * 3600 * 1000;
  for (const k of ['reminded', 'done']) for (const [key, ts] of Object.entries(s[k] || {})) if (ts < cut) delete s[k][key];
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

async function loadEvents() {
  const r = await fetch(FEED, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('calendar feed HTTP ' + r.status);
  const list = await r.json();
  const ev = list.map(e => ({ ...e, d: new Date(e.date) }))
    .filter(e => !isNaN(e.d) && important(e) && usWeekday(e.d));
  // group the releases that come out at the same minute (e.g. CPI m/m, core CPI, CPI y/y)
  const groups = new Map();
  for (const e of ev) {
    const key = e.d.toISOString();
    if (!groups.has(key)) groups.set(key, { key, d: e.d, events: [] });
    groups.get(key).events.push(e);
  }
  return [...groups.values()].sort((a, b) => a.d - b.d);
}

function block(e, actual) {
  const out = ['▪️ *' + arabicName(e.title) + '*'];
  if (actual) out.push('   الفعلي: *' + num(actual) + '*');
  if (e.forecast) out.push('   التوقع: ' + num(e.forecast));
  if (e.previous) out.push('   القراءة السابقة: ' + num(e.previous));
  return out.join('\n');
}

function reminderText(g, now) {
  const mins = Math.max(1, Math.round((g.d - now) / 60000));
  return '⏰ *تذكير: بيانات أمريكية بعد ' + mins + ' دقيقة*\n' +
    'الموعد: الساعة ' + timeAr(g.d) + ' بتوقيت دبي\n\n' +
    g.events.map(e => block(e)).join('\n\n');
}

async function headlinesSince(query, since) {
  const u = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query + ' when:1d') + '&hl=en-US&gl=US&ceid=US:en';
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('news HTTP ' + r.status);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const t = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const p = new Date((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    if (!isNaN(p) && p >= since) out.push(t.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim());
  }
  return out.slice(0, 25);
}

async function gemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');
  let models = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  try {
    const lm = await (await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + key, { signal: AbortSignal.timeout(20000) })).json();
    const names = (lm.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.split('/').pop()).filter(n => /flash/.test(n) && !/image|tts|live|audio|embedding|exp/.test(n));
    models = [...new Set([...models, ...names])].slice(0, 6);
  } catch (e) { console.log('[usdata] model list failed', e.message); }
  models = [...models, ...models.slice(0, 2)];
  let last;
  for (const model of models) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      return JSON.parse(txt.replace(/^```json|```$/g, '').trim());
    } catch (e) {
      last = model + ': ' + e.message;
      console.log('[usdata] model failed', last);
      await new Promise(r => setTimeout(r, 6000));
    }
  }
  throw new Error('No Gemini model worked (' + last + ')');
}

function resultPrompt(g, heads, top) {
  const evs = g.events.map(e => '- ' + e.title + ' | forecast: ' + (e.forecast || 'n/a') + ' | previous: ' + (e.previous || 'n/a')).join('\n');
  return [
    'You are the economic desk of Mr_Amwal, an Arabic crypto/economy app.',
    'These US releases came out at ' + g.d.toISOString() + ':',
    evs,
    'News headlines published after the release (newest first):',
    heads.map(h => '- ' + h).join('\n') || '(none)',
    '',
    'TASK: find the ACTUAL released value of each release, using ONLY these headlines.',
    'If the headlines do not clearly state the actual numbers yet, reply {"found": false}.',
    'Use a value ONLY if at least TWO different headlines (different outlets) state the same number; otherwise reply {"found": false}.',
    'Never guess or invent a number. For a Fed decision the actual is the new rate range or "unchanged".',
    'Reply JSON only:',
    '{"found": true, "actuals": {"<exact release title>": "<value as in the headline, e.g. 0.3% or 175K>"},',
    ' "meaning": "<one Arabic sentence (max 30 words): higher/lower than expected and what it means for the dollar, rates and bitcoin>"' +
      (top ? ',\n "news": {"title": "<Arabic headline max 12 words with the key number>", "body": "<see rules>"}' : '') + '}',
    top ? [
      'Rules for news.body (Modern Standard Arabic, real line breaks):',
      '1) One lead sentence with the actual vs forecast numbers. 2) Empty line, then two bullets starting with "• ",',
      'each adding a NEW fact (previous reading, core figure, market reaction from the headlines). 3) Empty line, then one',
      'context sentence on what it means for the Fed and bitcoin. 4) Empty line, a short English headline, then one English',
      'sentence. 5) Empty line, then "المصدر: " and the outlet names from the headlines separated by " · ".',
      'Every Arabic line must START with an Arabic word (never a number or English word). Write names in Arabic.'
    ].join('\n') : ''
  ].join('\n');
}

async function postNews(item) {
  const session = process.env.NEWSROOM_SESSION;
  if (!session) { console.log('[usdata] NEWSROOM_SESSION missing; newsroom skipped'); return false; }
  for (const tag of ['اقتصاد', 'economy']) {
    const r = await fetch(SITE + '/api/newsroom/news', {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/json', Origin: SITE, Referer: SITE + '/newsroom', Cookie: 'mra_newsroom=' + session },
      body: JSON.stringify({ title: item.title, body: item.body, tag, hours: 24, hot: true, push: true }),
      signal: AbortSignal.timeout(30000)
    });
    if (r.ok) { console.log('[usdata] posted to newsroom:', item.title); return true; }
    console.log('[usdata] newsroom HTTP', r.status, 'with tag', tag);
  }
  return false;
}

function setOutput(found) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'found=' + (found ? 'true' : 'false') + '\n');
}

// Looks for the published result of one release group. Returns the WhatsApp text, or null if not out yet.
// Top-tier releases are also posted to the newsroom here.
async function resultFor(g) {
  const q = (QUERIES.find(([re]) => g.events.some(e => re.test(e.title))) || [null, g.events[0].title + ' US'])[1];
  let heads = [];
  try { heads = await headlinesSince(q, new Date(g.d.getTime() - 60000)); } catch (e) { console.log('[usdata] headlines failed', e.message); }
  console.log('[usdata]', q, '- headlines after release:', heads.length);
  if (!heads.length) return null;
  const top = g.events.some(e => TOP_TIER.test(e.title));
  let res;
  try { res = await gemini(resultPrompt(g, heads, top)); } catch (e) { console.log('[usdata]', e.message); return null; }
  if (!res || !res.found || !res.actuals || !Object.keys(res.actuals).length) { console.log('[usdata] result not in the news yet:', q); return null; }
  const lines = g.events.map(e => block(e, res.actuals[e.title]));
  if (top && res.news && res.news.title && res.news.body) {
    try { await postNews(res.news); } catch (e) { console.log('[usdata] newsroom failed', e.message); }
  }
  return '🇺🇸 *صدرت الآن: بيانات أمريكية*\n' + 'الساعة ' + timeAr(g.d) + ' بتوقيت دبي\n\n' + lines.join('\n\n') + (res.meaning ? '\n\n' + res.meaning : '');
}

async function pick() {
  const now = new Date();
  const state = loadState();
  state.reminded = state.reminded || {}; state.done = state.done || {};
  const groups = await loadEvents();
  const msgs = [];

  // 1) reminders
  const soon = groups.filter(g => g.d > now && (g.d - now) <= REMIND_BEFORE_MIN * 60000 && !state.reminded[g.key]);
  for (const g of soon) { msgs.push(reminderText(g, now)); state.reminded[g.key] = Date.now(); }

  // 2) results
  const due = groups.filter(g => g.d <= now && (now - g.d) <= RESULT_WINDOW_MIN * 60000 && !state.done[g.key]);
  for (const g of due) {
    const msg = await resultFor(g);
    if (msg) { msgs.push(msg); state.done[g.key] = Date.now(); }
  }

  saveState(state);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(msgs, null, 2));
  msgs.forEach(m => console.log('----\n' + m));
  setOutput(msgs.length > 0);
}

// Live mode: if a release is due within the next 45 minutes (or came out in the last 10),
// stay running, wait for it, and send the result the moment the news has it (checks every 2 minutes
// for up to 25 minutes after the release). This removes the wait for the next hourly run.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function live() {
  const state = loadState();
  state.reminded = state.reminded || {}; state.done = state.done || {};
  const now = Date.now();
  const groups = (await loadEvents()).filter(g => g.d.getTime() > now - 10 * 60000 && g.d.getTime() - now <= 45 * 60000 && !state.done[g.key]);
  if (!groups.length) { console.log('[usdata] live: no release within the next 45 minutes'); return; }
  const wa = require('./send');
  for (const g of groups) {
    const wait = g.d.getTime() + 90000 - Date.now();
    console.log('[usdata] live: waiting', Math.max(0, Math.round(wait / 1000)), 's for the release at', g.key);
    if (wait > 0) await sleep(wait);
    const end = g.d.getTime() + 25 * 60000;
    while (Date.now() < end) {
      const msg = await resultFor(g);
      if (msg) {
        await wa.sendToSelf({ text: msg });
        state.done[g.key] = Date.now();
        saveState(state);
        console.log('[usdata] live: result sent for', g.key);
        break;
      }
      await sleep(120000);
    }
  }
  saveState(state);
}

async function send() {
  const msgs = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (!msgs.length) return;
  const wa = require('./send');
  for (const text of msgs) await wa.sendToSelf({ text });
  console.log('[usdata] sent', msgs.length, 'message(s)');
}

if (require.main === module) {
  (async () => {
    const mode = process.argv[2] || 'pick';
    try {
      if (mode === 'send') await send(); else if (mode === 'live') await live(); else await pick();
      process.exit(0);
    } catch (e) {
      console.error('FAILED:', e.message);
      if (mode === 'pick') setOutput(false);
      process.exit(mode === 'send' ? 1 : 0);
    }
  })();
}

module.exports = { pick, send, live, reminderText, resultPrompt, block };
