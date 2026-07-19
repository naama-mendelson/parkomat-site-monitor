// ai/chat.js — לולאת ה-tool calling.
//
// המודל מקבל את השאלה ואת רשימת הכלים. הוא מחליט אם לקרוא לכלי; אם כן — אנחנו
// מריצים אותו, מחזירים לו את התוצאה, והוא ממשיך. עד שהוא עונה בטקסט.

const provider = require("./provider");
const { buildSystemPrompt } = require("./prompt");
const { TOOL_SCHEMAS, executeTool } = require("./tools");
const { getAllSites } = require("../db/queries");

// גבול קשיח על סיבובי הכלים. מודל יכול להיכנס ללולאה שבה הוא קורא לאותו כלי
// שוב ושוב — בלי הגבול הזה זו לולאה אינסופית שאוכלת מכסה ומחזיקה בקשת HTTP
// פתוחה. 5 מספיק בשפע: אפילו שאלה מורכבת דורשת 2-3.
const MAX_ITERATIONS = 5;

// ההיסטוריה שנשלחת חזרה. בלי גבול, שיחה ארוכה מנפחת כל בקשה עד שהיא חורגת
// מחלון ההקשר ונופלת — דווקא אחרי שהמשתמש השקיע בה הכי הרבה.
const MAX_HISTORY = 12;

const isChatConfigured = () => provider.isConfigured();

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} messages
 * @param {(chunk:string)=>void} [onToken] — אם סופק, התשובה הסופית מוזרמת דרכו.
 * @returns {{ text: string, toolsUsed: string[], iterations: number }}
 */
async function runChat(messages, onToken) {
  const history = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));

  if (history.length === 0) {
    throw Object.assign(new Error("אין הודעות"), { status: 400 });
  }

  // רשימת האתרים נכנסת ל-prompt כדי שהמודל יזהה שמות ולא יבקש קודים.
  // שאילתה אחת וזולה (טבלת sites קטנה). כישלון כאן אינו קריטי — נופלים חזרה
  // ל-prompt הבסיסי, והמאתר ב-tools.js עדיין יודע לפתור שמות.
  let sites = [];
  try {
    sites = await getAllSites();
  } catch (err) {
    console.warn("[ai] לא הצלחתי לטעון את רשימת האתרים ל-prompt:", err.message);
  }

  const convo = [{ role: "system", content: buildSystemPrompt(sites) }, ...history];
  const toolsUsed = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // ==========================================================
    // מזרימים רק את התשובה — לא את סיבובי בחירת הכלים
    // ==========================================================
    // הבעיה: לא יודעים מראש אם הסיבוב הזה יחזיר טקסט (תשובה) או בקשה לכלי.
    // אילו היינו מזרימים ישירות ל-HTTP, סיבוב שמסתיים בקריאה לכלי היה מדליף
    // למשתמש טקסט-ביניים ("אני בודק...") שאינו התשובה, ואז התשובה האמיתית
    // הייתה נדבקת אחריו.
    //
    // לכן צוברים את הטקסט לחיץ, ומשחררים אותו החוצה רק אחרי שהתברר שהסיבוב
    // הזה *אינו* קריאה לכלי. הזרימה נשארת אמיתית (התווים כבר הגיעו מהמודל),
    // אבל היא מגיעה למשתמש רק כשהיא באמת התשובה.
    const pending = [];
    const capture = onToken ? (chunk) => pending.push(chunk) : undefined;

    const { text, toolCalls, raw } = await provider.chat(convo, TOOL_SCHEMAS, capture);

    // אין קריאות לכלים → זו התשובה.
    if (!toolCalls.length) {
      if (onToken) for (const chunk of pending) onToken(chunk);
      return { text: text || "לא הצלחתי לנסח תשובה. נסי לשאול אחרת.", toolsUsed, iterations: i + 1 };
    }

    // ההודעה של המודל *עם* בקשות הכלים חייבת לחזור להיסטוריה כמות שהיא.
    // בלעדיה ה-API דוחה את הודעות ה-tool שאחריה ("tool_call_id ללא הקשר").
    convo.push(raw);

    // הכלים בסיבוב אחד אינם תלויים זה בזה — מריצים במקביל.
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        toolsUsed.push(call.name);
        const result = await executeTool(call.name, call.args);
        return {
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result),
        };
      })
    );

    convo.push(...results);

    // ==========================================================
    // עיגון מחדש של הכללים — אחרי תוצאות הכלים, לא לפניהן.
    // ==========================================================
    // זה לא קישוט. מדדתי: ברגע שתוצאות הכלים נכנסו להקשר, המודל "שכח" את
    // ה-system prompt והתחיל לדקלם את כל מה שהכלי החזיר — גם כששאלו אותו "למה",
    // וגם כשביקשו ממנו להפעיל תחזוקה (שהוא לא יכול). התוכן החדש והארוך גובר על
    // הוראה שנמצאת רחוק למעלה בהקשר.
    //
    // התזכורת יושבת בדיוק במקום שבו הוא עומד לנסח את התשובה, ולכן היא עובדת.
    // היא זולה (~60 טוקנים) ומופיעה פעם אחת לכל סיבוב כלים.
    convo.push({
      role: "system",
      content:
        "Now answer the user's ACTUAL question in Hebrew ONLY — every word in Hebrew script, " +
        "never an English or Arabic word. Be brief and warm. PLAIN TEXT ONLY — no markdown, no ** or #. " +
        "Use only numbers from the tool results above. Do not list metrics that were not asked for. " +
        "If the question was 'why', reason from the architecture and state that the system does not record causes. " +
        "If the user asked you to perform an action, refuse — you are read-only. " +
        // שני הכללים שהמודל הפר בפועל, ולכן הם חוזרים כאן ולא רק למעלה:
        "NEVER suggest a site may be disconnected because its lastSeen is old — the agent only publishes on " +
        "change, so an old lastSeen on a healthy site is normal. Trust the 'status' field only.",
    });
  }

  // ==========================================================
  // נגמרו הסיבובים והמודל עדיין מבקש כלים.
  // ==========================================================
  // סיבוב אחרון *בלי* כלים — כדי לאלץ אותו לנסח תשובה מהנתונים שכבר אסף,
  // במקום להחזיר למשתמש שגיאה אחרי שהמידע כבר בידינו.
  const { text } = await provider.chat(
    [...convo, { role: "user", content: "ענה עכשיו מהנתונים שכבר אספת, בלי לקרוא לכלים נוספים." }],
    [],
    onToken   // כאן אין כלים כלל, ולכן אפשר להזרים ישירות — זו בוודאות התשובה
  );

  return {
    text: text || "לא הצלחתי להשלים את התשובה. נסי לשאול בצורה ממוקדת יותר.",
    toolsUsed,
    iterations: MAX_ITERATIONS,
    truncated: true,
  };
}

module.exports = { runChat, isChatConfigured, providerInfo: provider.info };
