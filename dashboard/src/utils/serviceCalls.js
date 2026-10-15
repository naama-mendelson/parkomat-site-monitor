// utils/serviceCalls.js — קריאות השירות של ויזנט: פונקציות טהורות (נבדקות ב-master/tests/service-calls-ui.test.js).

// ============================================================
// ⚠️ דולק מ-14/10/2026 — הרשימות נטענו והקריאות מגיעות
// ============================================================
// היה כבוי עד שרשימות ויזנט נטענו: בלי רשימת הסטטוסים אין דרך לדעת איזו קריאה סגורה, והסימון היה
// סופר גם סגורות. ב-13/10 נטענו 20 סטטוסים ו-11 סוגים, ב-14/10 סומנו עשרה כסגורים (בחירת בעלת
// המוצר) וויזנט הדליקו את השליחה אלינו — ולכן ברירת המחדל הפוכה. `VITE_SERVICE_CALLS=false` מכבה.
export const SERVICE_CALLS_ENABLED = String(import.meta.env?.VITE_SERVICE_CALLS ?? "true") !== "false";

// ============================================================
// ⚠️ שינוי סטטוס/סוג — דולק מ-15/10/2026, דרך הממסר
// ============================================================
// העדכון חזרה עובר ל-WIZEAPI, וויזנט חוסמים גישה מחוץ לישראל (תשובתם, 14/10/2026). עד 15/10 הדגל היה כבוי,
// כי ל-Edge Functions של Supabase אין כתובת יוצאת קבועה, והבורר נראה עובד ונתקע 15 שניות.
// מ-15/10 הפנייה יוצאת ממחשבי אתרים בישראל (db/wizenet-relay.postgres.sql). שלושה ממסרים מותקנים; הבדיקה החיה
// עברה (רענון רשימות דרך ממסר אמיתי, 0.5 שנ׳), ובעלת המוצר ביקשה להדליק: "אי אפשר מה-DASHBOARD לשנות סוג וסטטוס
// — תן את האופציה". ⚠️ גם דולק, הבורר אפור כשאין ממסר חי — זה נקבע בזמן ריצה (wizenet_relays_status), לא בבנייה.
// `VITE_SERVICE_CALLS_WRITE=false` מכבה.
export const SERVICE_CALLS_WRITE = String(import.meta.env?.VITE_SERVICE_CALLS_WRITE ?? "true") !== "false";

/**
 * שורות service_call_counts → { [siteId]: { open, recent } }
 * open — פתוחות עכשיו (בכל גיל); recent — כל מה שהגיע ב-24 השעות, כולל סגורות.
 * ⚠️ מסד ישן אינו מחזיר recent — אז הוא 0, והכרטיס מתנהג כמו קודם (רק פתוחות).
 */
export function countsBySite(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (r?.site_id == null) continue;
    const cur = out[r.site_id] ?? { open: 0, recent: 0, oldestOpen: null };
    // ⚠️ הוותיק מכל השורות של אותו אתר — זמן אמיתי (UTC) שה-SQL כבר המיר משעון ויזנט
    const o = r.oldest_open || null;
    out[r.site_id] = {
      open: cur.open + (Number(r.open) || 0),
      recent: cur.recent + (Number(r.recent) || 0),
      oldestOpen: !o ? cur.oldestOpen : (!cur.oldestOpen || o < cur.oldestOpen ? o : cur.oldestOpen),
    };
  }
  return out;
}

// ============================================================
// ⚠️ מה שוויזנט שולחים אינו טקסט נקי
// ============================================================
// נמדד על הקריאות האמיתיות: `notes` מגיע כ-HTML — `<br />`, `<br>`, `&nbsp;`, `\r\n`, ולפעמים
// `~~~` כמפריד — והוא **פותח כמעט תמיד במספר הטלפון**, שכבר מוצג שורה מעליו. `customer_complaint`
// לפעמים אינו תוכן בכלל: קוד האתר ("3461"), "ללא נושא", או מחרוזת ריקה.
// בלי הניקוי הזה המסך הראה "0547721538<br /> &nbsp;" מתחת לטלפון עצמו.

/** טקסט מוויזנט → טקסט רגיל: בלי תגיות, בלי ישויות, שורות מופרדות ב-" · " */
export function cleanText(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/~~~+/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((x) => x.trim()).filter(Boolean)
    .join(" · ");
}

const onlyDigits = (s) => String(s ?? "").replace(/\D/g, "");

/**
 * מה באמת כתוב בקריאה — שורה אחת או שתיים, בלי כפילות הטלפון ובלי "ללא נושא".
 * ⚠️ מחזיר מערך ולא מחרוזת: התלונה והפירוט הם שתי רמות, והמסך מדגיש את הראשונה.
 */
export function callText(c) {
  const ph = onlyDigits(c?.phone);
  const useful = (t) => {
    const x = cleanText(t);
    if (!x) return "";
    // ⚠️ "רק מספר" נבדק על הטקסט כולו ולא על הספרות שבו: הערה שמתחילה בטלפון וממשיכה במילים
    // היא תוכן, ובדיקה על הספרות בלבד הייתה מוחקת אותה (נמצא בבדיקות, 14/10/2026).
    if (!/[A-Za-zא-ת]/.test(x)) return "";                      // אין בכלל מילים — קוד או טלפון
    if (/^ללא נושא$/i.test(x)) return "";
    return x;
  };
  let head = useful(c?.complaint);
  let rest = useful(c?.notes);
  if (ph && rest) {
    // ההערות פותחות (או נגמרות) במספר הטלפון שכבר מוצג
    const re = new RegExp(`(^|·\\s*)${ph.replace(/(\d)/g, "$1[\\s-]?")}(\\s*·|$)`, "g");
    rest = cleanText(rest.replace(re, " · ").replace(/^\s*·\s*|\s*·\s*$/g, ""));
  }
  if (rest && head && (rest.includes(head) || head.includes(rest))) rest = rest.length > head.length ? rest : "";
  if (!head && rest) { head = rest; rest = ""; }
  return [head, rest].filter(Boolean);
}

/**
 * "חניה" מוצגת רק כשהיא מוסיפה מידע: קוד מלא כולל מתקן/כרטיס ("1226-1-02").
 * ⚠️ מאז 08/10 ויזנט שולחים את קוד הפרויקט לבדו ("3452") — והוא כבר כתוב כקוד האתר.
 */
export function parkingDetail(c) {
  const pk = String(c?.parking_code ?? "").trim();
  return pk && /[-/]/.test(pk) ? pk : "";
}

// ============================================================
// ⚠️ שורה מאוחדת — אותו אדם, אותו טקסט, אותו רגע
// ============================================================
// בעלת המוצר (14/10/2026): "אם יש קריאה מאותו בן אדם באותו זמן עם אותו טקסט אז אל תכתבי אותה
// פעמיים חבל". האיחוד עצמו נעשה ב-SQL (`app.service_calls_current`), שמחזיר `dup_n` — כמה קריאות
// נפרדות אוחדו לשורה הזו. באתר 1312 היו שמונה ב-16 שניות.
//
// ⚠️ ולמה מציגים "×8" ולא מעלימים בשקט: שמונה לחיצות של אותו אדם הן **מידע** — הן אומרות שמשהו
// שם לא הגיב לו. העלמה חסרת סימן הייתה גם מסתירה את העובדה שקיימים שבעה מספרי קריאה נוספים
// שוויזנט עוד ישלחו עליהם עדכונים.

/** שורה שאוחדה → { n, mark, title }; קריאה בודדת → null */
export function dupInfo(c) {
  const n = Number(c?.dup_n) || 1;
  if (n < 2) return null;
  return { n, mark: `×${n}`, title: `${n} קריאות זהות מאותו אדם באותו רגע — מוצגות כאחת` };
}

/**
 * השורה מתחת לכותרת ב"קריאות היום" — אותם שני מספרים כמו האריח: כמה קרו בחלון, וכמה פתוחות עכשיו.
 * ⚠️ מ-15/10/2026 הרשימה כוללת גם פתוחות ישנות (in_window = false). הן נספרות ב"פתוחות" ולא ב"קריאות": בבוקר שקט
 * "2 קריאות" על שתי פתוחות מלפני שבוע היה שקר. מסד ישן בלי in_window — כל השורות "של היום", כמו שהיה.
 * "5 קריאות · 3 פתוחות" / "קריאה אחת · פתוחה אחת" / "אין קריאות · 2 פתוחות" / "4 קריאות · אין פתוחות"
 */
export function callsSummary(calls) {
  const list = calls ?? [];
  const n = list.filter((c) => c.in_window !== false).length;
  const open = list.filter((c) => c.open !== false).length;
  const head = n === 0 ? "אין קריאות" : n === 1 ? "קריאה אחת" : `${n} קריאות`;
  return `${head} · ${open === 0 ? "אין פתוחות" : open === 1 ? "פתוחה אחת" : `${open} פתוחות`}`;
}

/**
 * השורה מתחת לכותרת בחלון של אתר (15/10/2026). פתוחות — כמה פתוחות; היסטוריה — כמה נסגרו **בכלל** (total):
 * הרשימה עצמה עד 100, ו"100 קריאות שנסגרו" על אתר עם 240 היה שקר.
 */
export function siteCallsSummary(view, calls, total) {
  if (view === "history") {
    const n = Number(total ?? calls?.length) || 0;
    return n === 0 ? "אין קריאות שנסגרו" : n === 1 ? "קריאה אחת שנסגרה" : `${n} קריאות שנסגרו`;
  }
  const n = calls?.length ?? 0;
  return n === 0 ? "אין קריאות פתוחות" : n === 1 ? "קריאה פתוחה אחת" : `${n} קריאות פתוחות`;
}

/**
 * שורה אחת אחרי שינוי שהוציא קריאה מהרשימה, כדי שלא תיעלם בשקט (15/10/2026). view: "open" | "history" | "recent".
 * ⚠️ שורה מאוחדת (dup_n > 1): השינוי נשלח לוויזנט על מספר קריאה **אחד**. אם שאר הזהות עדיין פתוחות, השורה
 * נשארת תחת מספר אחר ואינה בהיסטוריה — ולכן רק "נסגרה", בלי לאן.
 */
export function movedNote(c, view) {
  const t = c?.ticket;
  if (view === "history") return `קריאה ${t} נפתחה מחדש ועברה לקריאות הפתוחות`;
  if (Number(c?.dup_n) > 1) return `קריאה ${t} נסגרה`;
  // "קריאות היום": שינוי שלנו הוא "היום", ולכן קריאה כמעט לא יוצאת משם — ואם יצאה, נאמר רק מה שבטוח
  return view === "recent" ? `קריאה ${t} נסגרה ויצאה מהרשימה` : `קריאה ${t} נסגרה ועברה להיסטוריה`;
}

/** "דנה כהן", או "—" כשאין שם */
export function callerName(c) {
  const n = [c?.first_name, c?.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  return n || "—";
}

/** זמן אמיתי (שלנו, UTC) → "13/10 09:42" בשעון ישראל */
export function israelLabel(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

// ============================================================
// ⚠️ ויזנט שולחים **שעון ישראל** עם סיומת Z — ולכן אין להמיר אותו
// ============================================================
// נמדד ב-14/10/2026 על הקריאות האמיתיות: `updated_at` של הודעה הוא שנייה־שתיים **לפני** שעת ההגעה
// שלנו, אבל מסומן שלוש שעות קדימה. למשל 12:40:46Z על הודעה שהתקבלה ב-09:40:47 UTC. כלומר ה-Z אינו
// UTC אלא שעון מקומי.
//
// התוצאה לפני התיקון: הוספנו עוד שלוש שעות, וקריאה שנפתחה ב-12:40 הוצגה כ-15:40 — **שעה שעוד לא
// הגיעה**. בעלת המוצר: "הזמן שמוצג לא הגיוני, עדיין לא הגיע השעה הזו".
//
// ⚠️ ולכן יש כאן שתי פונקציות ולא אחת: `received_at` ו-`changed_at` הם **שלנו**, זמן UTC אמיתי,
// וחייבים המרה. כל מה שהגיע מוויזנט — מוצג כמו שנכתב.

/** זמן מוויזנט → השעון שכתוב בו, בלי שום המרה */
export function wizenetLabel(raw) {
  const m = String(raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : String(raw ?? "");
}

/** מתי נפתחה: השעה שוויזנט כתבו; וכשאין — שעת ההגעה אלינו, בשעון ישראל */
export function openedLabel(c) {
  if (c?.opened_at) return wizenetLabel(c.opened_at);
  return israelLabel(c?.received_at);
}

/**
 * אפשרויות לבורר: הרשימה מוויזנט, ו⚠️ הערך הנוכחי גם כשאינו ברשימה — בורר שאין בו את הערך הנוכחי מציג
 * את הראשון ברשימה, וזה נראה כמו "הסטטוס הוא X" כשהוא לא.
 */
export function optionsFor(list, currentId, currentName) {
  const opts = (list ?? []).map((o) => ({ id: String(o.id), name: o.name }));
  if (currentId != null && currentId !== "" && !opts.some((o) => o.id === String(currentId))) {
    opts.unshift({ id: String(currentId), name: currentName || `לא מוכר (${currentId})` });
  }
  return opts;
}
