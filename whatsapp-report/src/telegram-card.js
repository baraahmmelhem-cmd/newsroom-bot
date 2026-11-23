// 1080x1350 image card for the Telegram draft "الخبر في 3 أسطر" (owner, 23 Nov 2026: send the draft as a picture).
// Dark navy + cyan, three numbered blocks: what happened / why it matters / what we watch.
// The text shrinks by itself until everything fits the card.

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
// numbers (with $ / % and مليار / مليون) are shown bold, like the owner's template
const rich = s => esc(s).replace(/(\$\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|\$)?(?:\s?(?:مليار|مليون|تريليون|ألف)(?:\s?\$)?)?/g, m => "<b>" + m + "</b>");

function cardHtml(c) {
  const watch = (c.watch || []).map(w => "<div class=\"w\"><span class=\"tag\">" + esc(w.label) + "</span><span class=\"wt\">" + rich(w.text) + "</span></div>").join("");
  return "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\"><style>" + [
    ":root{--k:1;--bg:#080c14;--panel:#0f1622;--line:#1e2a3b;--ink:#f3f6fa;--mut:#8c9bb0;--acc:#2fc6ee}",
    "*{margin:0;padding:0;box-sizing:border-box}",
    "html,body{width:1080px;height:1350px;overflow:hidden}",
    "body{background:radial-gradient(900px 500px at 85% -10%,#10263a 0%,var(--bg) 60%);color:var(--ink);font-family:'Noto Kufi Arabic','Noto Sans Arabic','DejaVu Sans',sans-serif;display:flex;flex-direction:column;padding:46px 56px 34px}",
    "b{font-weight:800;color:#fff}",
    ".top{display:flex;justify-content:space-between;align-items:center}",
    ".brand{direction:ltr;text-align:right;font-weight:800;font-size:34px;line-height:1.15}",
    ".brand small{display:block;direction:rtl;font-size:20px;font-weight:600;color:var(--acc)}",
    ".pills{display:flex;gap:12px}",
    ".pill{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:9px 20px;font-size:20px;font-weight:700;color:#c6d0dd;white-space:nowrap}",
    ".pill i{display:inline-block;width:12px;height:12px;border-radius:50%;background:#ff4d5e;margin-inline-end:8px}",
    ".kick{color:var(--acc);font-weight:800;font-size:26px;margin-top:26px}",
    "h1{font-size:calc(62px*var(--k));line-height:1.22;font-weight:900;margin-top:4px}",
    ".box{background:var(--panel);border:1px solid var(--line);border-radius:26px;padding:calc(26px*var(--k)) 32px;margin-top:calc(22px*var(--k))}",
    ".h{display:flex;align-items:center;gap:14px;color:var(--acc);font-weight:800;font-size:calc(30px*var(--k));margin-bottom:8px}",
    ".n{width:38px;height:38px;border-radius:50%;background:#12324a;color:var(--acc);font-size:20px;display:flex;align-items:center;justify-content:center;font-weight:800;flex:none}",
    "p{font-size:calc(28px*var(--k));line-height:1.6;color:#e6ebf2}",
    "p .lab{color:var(--acc);font-weight:800}",
    ".sep{border-top:1px dashed var(--line);margin:calc(14px*var(--k)) 0}",
    ".watch{background:linear-gradient(135deg,#31cdf0 0%,#16a5cf 100%);border:none;color:#06202c}",
    ".watch .h{color:#06202c}.watch .n{background:rgba(6,32,44,.16);color:#06202c}",
    ".w{display:flex;align-items:center;gap:20px;margin-top:calc(12px*var(--k))}",
    ".tag{flex:none;min-width:190px;text-align:center;background:#0b2a3a;color:#35d0f5;border-radius:14px;padding:8px 14px;font-weight:800;font-size:calc(25px*var(--k))}",
    ".wt{font-size:calc(26px*var(--k));font-weight:700;line-height:1.45;color:#06202c}.wt b{color:#06202c}",
    ".grow{flex:1}",
    ".foot{display:flex;justify-content:space-between;align-items:center;gap:16px;color:var(--mut);font-size:17px;margin-top:20px}",
    ".foot .src{max-width:430px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
    ".foot .site{direction:ltr;color:var(--acc);font-weight:800;font-size:19px}"
  ].join("\n") + "</style></head><body>" +
    "<div class=\"top\"><div class=\"brand\">Mr_Amwal<small>غرفة الأخبار</small></div><div class=\"pills\">" +
    (c.impact ? "<span class=\"pill\"><i></i>تأثير: " + esc(c.impact) + "</span>" : "") +
    "<span class=\"pill\">" + esc(c.date) + "</span></div></div>" +
    "<div class=\"kick\">الخبر في 3 أسطر</div><h1>" + esc(c.headline) + "</h1>" +
    "<div class=\"box\"><div class=\"h\"><span class=\"n\">1</span>ماذا حدث؟</div><p>" + rich(c.what) + "</p></div>" +
    "<div class=\"box\"><div class=\"h\"><span class=\"n\">2</span>لماذا يهم؟</div><p><span class=\"lab\">اقتصادياً:</span> " + rich(c.econ) + "</p>" +
    (c.politics ? "<div class=\"sep\"></div><p><span class=\"lab\">سياسياً:</span> " + rich(c.politics) + "</p>" : "") + "</div>" +
    "<div class=\"box watch\"><div class=\"h\"><span class=\"n\">3</span>ماذا نراقب؟</div>" + watch + "</div>" +
    "<div class=\"grow\"></div>" +
    "<div class=\"foot\"><span class=\"src\">المصادر: " + esc(c.sources || "") + "</span><span>للمعلومات فقط — ليست نصيحة استثمارية</span><span class=\"site\">mr-amwal.com/newsroom</span></div>" +
    "<script>(function(){var k=1;while(document.body.scrollHeight>1350&&k>0.6){k-=0.02;document.documentElement.style.setProperty(\"--k\",k);}})();</script>" +
    "</body></html>";
}

async function renderCard(c, outPath) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
    await page.setContent(cardHtml(c), { waitUntil: "load" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: outPath });
  } finally { await browser.close(); }
  return outPath;
}

module.exports = { cardHtml, renderCard };
