// Optional: turns today's English headlines into 3 short Arabic items
// using Google Gemini's free tier. Runs only when GEMINI_API_KEY is set.
// It may only use facts present in the headlines; it must not invent numbers.

const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

function fmt(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 }); }

async function arabicNews(data) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !data.headlines.length) return null;

  const prices = data.crypto.map(c => `${c.sym} ${fmt(c.price)} (${c.change == null ? '—' : c.change.toFixed(1) + '%'})`).join(', ');
  const prompt = `أنت محرر اقتصادي في قناة إخبارية عربية كبرى. اكتب بالفصحى، بأسلوب مكثّف ومهني، بلا مبالغة وبلا رموز تعبيرية.
المعطيات الحقيقية الوحيدة المسموح استخدامها:
- أسعار الآن: ${prices}
- عناوين آخر 24 ساعة (إنجليزية):
${data.headlines.map(h => `• ${h.title} (${h.source})`).join('\n')}

المطلوب JSON فقط بهذا الشكل بدون أي نص آخر:
{"headline":"جملة واحدة تلخص حالة السوق اليوم (أقل من 16 كلمة)",
 "items":[{"tag":"تصنيف قصير (كريبتو / واشنطن / الأسواق / الخليج / الطاقة)","title":"عنوان قوي أقل من 9 كلمات","body":"جملتان قصيرتان بأقل من 30 كلمة"}, ... 3 عناصر],
 "watch":"جملة واحدة: ما الذي يراقبه المستثمر اليوم (أقل من 20 كلمة)"}
قواعد صارمة: لا تذكر أي رقم غير موجود في المعطيات أعلاه. لا تذكر أوروبا ولا إسرائيل. اختر أهم 3 أخبار تأثيراً على السوق (أولوية: بيتكوين والعملات الكبرى، قرارات أمريكية، الصين، النفط والذهب، الخليج). لا تكتب أسماء المصادر.`;

  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } })
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(text.replace(/^```json|```$/g, '').trim());
      if (parsed.items?.length) return { headline: parsed.headline, items: parsed.items.slice(0, 3), watch: parsed.watch };
    } catch (e) { console.warn(`[news] ${model} failed: ${e.message}`); }
  }
  return null;
}

module.exports = { arabicNews };
