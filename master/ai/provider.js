// ai/provider.js — שכבת ההפשטה מעל ספק המודל.
//
// ============================================================
// כל הקוד שמעל הקובץ הזה לא יודע ש-Groq קיים.
// ============================================================
// Groq נבחר כי הוא חינמי ותומך ב-tool calling. הוא גם מוגבל: מכסות, ומודל
// פתוח שנוטה יותר להמציא מאשר Claude. סביר שנחליף אותו.
//
// ההפשטה מכוונת לכך שההחלפה תהיה קובץ אחד: providers/<שם>.js שמייצא
//     chat(messages, tools) -> { text, toolCalls: [{ id, name, args }] }
// ה-loop, הכלים וה-prompt לא ידעו על כך דבר.
//
// הפורמט המשותף הוא זה של OpenAI (messages/tools/tool_calls), כי הוא מה
// ש-Groq מדבר. ספק שאינו תואם (Anthropic) יתרגם בתוך הקובץ שלו — התרגום שייך
// לספק, לא לקורא.
// ============================================================

const groq = require("./providers/groq");

const PROVIDERS = { groq };

const active = PROVIDERS[process.env.AI_PROVIDER || "groq"];

if (!active) {
  throw new Error(
    `ai: ספק לא מוכר "${process.env.AI_PROVIDER}". קיימים: ${Object.keys(PROVIDERS).join(", ")}`
  );
}

module.exports = {
  // onToken אופציונלי — כשהוא מסופק, הטקסט מוזרם דרכו תוך כדי הייצור.
  // ספק שאינו תומך בהזרמה יכול פשוט להתעלם ממנו ולהחזיר את התשובה בסוף.
  chat: (messages, tools, onToken) => active.chat(messages, tools, onToken),
  isConfigured: () => active.isConfigured(),
  info: () => ({ provider: active.name, model: active.model }),
};
