// ai/providers/groq.js — מימוש הספק מול Groq (API תואם-OpenAI).
//
// אין SDK ואין תלות חדשה: Node 20+ כולל fetch גלובלי, וה-API הוא REST פשוט.
// תלות פחות = משטח תקיפה קטן יותר ופחות לתחזק.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ==========================================================
// למה gpt-oss-120b ולא llama-3.3-70b
// ==========================================================
// השוויתי את שניהם על אותן שאלות, אותו prompt ואותם כלים. ההבדל המכריע היה
// בשאלת ה"למה" — הלב של הפיצ'ר:
//
//   llama-3.3-70b  נימק מהארכיטקטורה, אבל **הוסיף סיבות שאינן שם** ("תקלה
//                  בשרת", "בעיה עם היישום") וגרר סטטיסטיקות שלא נשאל עליהן.
//   gpt-oss-120b   נימק מדויק לפי הארכיטקטורה, **ובדק את המצב בפועל** — וציין
//                  מיוזמתו שהאתר כרגע דווקא *אינו* מנותק.
//
// בעוזר שכל הערך שלו הוא לא-להמציא, היצמדות להוראות חשובה יותר מגודל המודל.
// שניהם חינמיים באותה מכסה.
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// timeout מפורש: בלי זה בקשה תקועה מחזיקה חיבור פתוח עד אינסוף, והמשתמש רואה
// ספינר נצחי. AbortController הוא הדרך היחידה — ל-fetch אין timeout מובנה.
const TIMEOUT_MS = 45_000;

const isConfigured = () => Boolean(process.env.GROQ_API_KEY);

async function post(body, signal) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 429 מ-Groq החינמי הוא צפוי לגמרי — מבדילים אותו כדי שהמשתמש יקבל
    // "נסה שוב עוד רגע" ולא "שגיאת שרת".
    if (res.status === 429) {
      const e = new Error("המודל עמוס כרגע (מכסה חינמית). נסי שוב בעוד רגע.");
      e.status = 429;
      throw e;
    }
    throw new Error(`Groq החזיר ${res.status}: ${text.slice(0, 200)}`);
  }

  return res;
}

/**
 * @param messages  היסטוריית השיחה
 * @param tools     סכמות הכלים (או [] כדי לאסור קריאה לכלים)
 * @param onToken   אם סופק — הטקסט מוזרם דרכו תוך כדי, והתשובה נבנית במקביל.
 * @returns {{ text: string|null, toolCalls: Array<{id,name,args}>, raw: object }}
 */
async function chat(messages, tools, onToken) {
  if (!isConfigured()) {
    throw new Error("חסר GROQ_API_KEY בסביבה");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const body = {
    model: MODEL,
    messages,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    // נמוך בכוונה: זהו עוזר שמדווח מספרים, לא כותב שיווקי. יצירתיות כאן
    // מתבטאת בעיקר בהמצאת נתונים.
    temperature: 0.25,
    max_tokens: 700,
    ...(onToken ? { stream: true } : {}),
  };

  try {
    const res = await post(body, controller.signal);
    return onToken ? await readStream(res, onToken) : await readWhole(res);
  } catch (err) {
    if (err.name === "AbortError") throw new Error("הבקשה למודל חרגה מהזמן המוקצב");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ===== תשובה שלמה (בלי הזרמה) =====
async function readWhole(res) {
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("תשובה ריקה מהמודל");
  return { text: msg.content || null, toolCalls: parseToolCalls(msg.tool_calls), raw: msg };
}

// ============================================================
// ===== הזרמה (SSE) =====
// ============================================================
// ה-API מחזיר שורות "data: {...}" עם delta לכל נתח. שני דברים חשובים:
//
// 1. **גם קריאות לכלים מגיעות כ-delta**, ובחלקים: השם מגיע פעם אחת, וה-arguments
//    מצטברים תו-תו על פני הודעות רבות. חייבים לצבור אותם לפי index, אחרת
//    מקבלים JSON חתוך. זו הסיבה שאי אפשר פשוט "להזרים טקסט".
//
// 2. נתח אחד ברשת יכול להכיל כמה שורות data, או **חצי שורה**. לכן מחזיקים
//    buffer וחותכים רק על \n שלם — אחרת JSON.parse נופל על שורה קטועה.
async function readStream(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let text = "";
  const toolAcc = new Map();   // index → { id, name, args }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";      // השורה האחרונה עשויה להיות חלקית

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;   // נתח פגום — מדלגים, לא מפילים את השיחה
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        onToken(delta.content);
      }

      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        const cur = toolAcc.get(i) || { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolAcc.set(i, cur);
      }
    }
  }

  const rawToolCalls = [...toolAcc.values()].map((t) => ({
    id: t.id,
    type: "function",
    function: { name: t.name, arguments: t.args },
  }));

  // ה-raw חייב להיראות בדיוק כמו הודעת assistant רגילה — הוא נדחף חזרה
  // להיסטוריה, וה-API דוחה הודעות tool שאין להן הודעת assistant תואמת.
  const raw = {
    role: "assistant",
    content: text || null,
    ...(rawToolCalls.length ? { tool_calls: rawToolCalls } : {}),
  };

  return { text: text || null, toolCalls: parseToolCalls(rawToolCalls), raw };
}

// ה-arguments מגיעים כמחרוזת JSON. מודל יכול להחזיר JSON פגום — ואז אנחנו
// מדלגים על הכלי במקום להפיל את הבקשה. עדיף כלי אחד חסר מאשר שיחה שנפלה.
function parseToolCalls(list) {
  return (list || [])
    .map((tc) => {
      let args = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        console.warn(`[ai] ארגומנטים פגומים ל-${tc.function?.name}:`, tc.function?.arguments);
        return null;
      }
      return { id: tc.id, name: tc.function.name, args: args || {} };
    })
    .filter(Boolean);
}

module.exports = { chat, isConfigured, name: "groq", model: MODEL };
