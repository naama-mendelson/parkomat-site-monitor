// utils/sitePatch.js — עדכון רשימת האתרים ישירות מהודעת ה-SSE.
//
// ==========================================================
// למה בכלל
// ==========================================================
// קודם, *כל* הודעה מאתר גררה שליפה מחדש של כל רשימת האתרים. אבל ההודעה
// עצמה כבר נושאת את מה שהשתנה: המצב החדש, זמן האירוע, מונה המחזורים,
// כיוון הפעולה. אין שום צורך לשאול את השרת מה הוא כבר סיפר לנו.
//
// הכלל שהנחה אותי כאן: **מעדכנים רק שדות שההודעה נותנת במדויק.**
// מדדים מצטברים (אחוז כשל, זמינות, מספר פעולות שבועי) *לא* מחושבים כאן —
// הם נגזרים מחלון של 7 ימים בשרת, וניחוש מקומי שלהם היה גורם למספרים
// בדשבורד לסטות מהמספרים ב-DB. אותם עדיין שולפים, אבל בקצב נמוך בהרבה.
// ==========================================================

/**
 * מחזיר רשימת אתרים חדשה עם ההודעה מוחלת עליה.
 * אם ההודעה לא נוגעת לאף אתר מוכר — מחזיר את אותה רשימה (בלי render מיותר).
 */
export function applySiteUpdate(sites, msg) {
  if (!msg?.code) return sites;

  const index = sites.findIndex((s) => s.code === msg.code);
  if (index === -1) return sites;          // אתר חדש שנרשם — צריך שליפה מלאה

  const site = sites[index];
  const patch = patchFor(site, msg);
  if (!patch) return sites;

  const next = sites.slice();
  next[index] = { ...site, ...patch };
  return next;
}

function patchFor(site, msg) {
  if (msg.type === "state") {
    return {
      status: msg.newStatus,
      // המצב התחיל עכשיו — זה בדיוק מה שהשרת היה מחזיר ב-statusSince
      statusSince: msg.occurredAt,
      // ניתוק אינו "צפייה": הודעת no_comm מגיעה מה-Broker בשם אתר שהתנתק,
      // ולכן אסור לה לרענן את last_seen. אותו כלל בדיוק קיים בשרת
      // (updateStatusOnly) — אם נסטה ממנו כאן, אתר מת ייראה "נצפה זה עתה".
      ...(msg.newStatus === "no_comm" ? {} : { last_seen: msg.occurredAt }),
    };
  }

  if (msg.type === "operation") {
    return {
      last_seen: msg.occurredAt,
      // cycleTotal מגיע מהשרת אחרי החישוב (delta/reset/backfill) — לא מנחשים
      ...(msg.cycleTotal !== null && msg.cycleTotal !== undefined
        ? { cycle_total: msg.cycleTotal }
        : {}),
      lastOperation: {
        start_end: msg.startEnd,
        entry_exit: msg.entryExit,
        occurred_at: msg.occurredAt,
      },
    };
  }

  return null;   // registered / סוג לא מוכר → צריך שליפה מלאה
}

/**
 * האם ההודעה משנה גם מדדים מצטברים (שאי אפשר לגזור מההודעה עצמה)?
 * רק אז צריך לשלוף מהשרת.
 *
 *  - operation שאינה אנומליה → מספר הפעולות ואחוז הכשל השתנו.
 *  - כניסה/יציאה ממצב error  → מספר התקלות והזמינות השתנו.
 *  - רישום/מחיקת אתר         → הרשימה עצמה השתנתה.
 *
 * מעבר ready↔operating, לעומת זאת, לא משנה שום מדד מצטבר — והוא הרוב
 * המוחלט של התנועה באתר עמוס.
 */
export function needsRefetch(msg) {
  if (!msg?.type) return true;
  if (msg.type === "registered") return true;

  if (msg.type === "operation") {
    return msg.startEnd === "end" && !msg.isAnomaly;
  }

  if (msg.type === "state") {
    return msg.newStatus === "error" || msg.oldStatus === "error" ||
           msg.newStatus === "maintenance" || msg.oldStatus === "maintenance" ||
           msg.newStatus === "no_comm" || msg.oldStatus === "no_comm";
  }

  return true;
}
