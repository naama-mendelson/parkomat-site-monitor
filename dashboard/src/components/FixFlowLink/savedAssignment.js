// שיוך ספרייה שנשמר זה עתה — משותף לכפתור (FixFlowLink) ולפאנל (FixFlowSolution).
//
// ============================================================
// ⚠️ למה לא state מקומי בכפתור
// ============================================================
// השמירה הוחזקה ב-`useState` של הכפתור, ולכן רק הוא ראה אותה. הפאנל שלצדו
// המשיך לחשב מהאתר הישן עד הסקירה הבאה (עד 60 שניות): אחרי שיוך מחדש הכפתור
// הראשי עוד פתח את הנוהל של הספרייה **הקודמת**, ואזהרת הבטיחות שהוצגה הייתה
// של מתקן אחר. בדיוק הרגע שבו המוקדן סומך על מה שכתוב.
//
// ⚠️ והדריסה חלה **רק כל עוד הרשימה עדיין מחזיקה את הערך שהיה בזמן השמירה**.
// ברגע שהיא מתעדכנת — כי השמירה הגיעה, או כי מישהו אחר שינה שוב — הרשימה
// גוברת. דריסה קבועה הייתה מסתירה שינוי של משתמשת אחרת עד רענון הדף.
//
// הקובץ בתוך תיקיית הפיילוט בכוונה: הסרת FixFlow נשארת "מחיקת התיקייה".
import { useSyncExternalStore } from "react";

const saved = new Map();          // code → { profile, baseline }
const listeners = new Set();
let version = 0;

export function rememberAssignment(site, profile) {
  saved.set(String(site.code), { profile, baseline: site.fixflow_profile ?? "" });
  version++;
  for (const l of listeners) l();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** האתר כפי שצריך להציג אותו — עם השיוך שנשמר, אם הרשימה עוד לא התעדכנה. */
export function withSavedAssignment(site) {
  const s = site && saved.get(String(site.code));
  if (!s || (site.fixflow_profile ?? "") !== s.baseline) return site;
  return { ...site, fixflow_profile: s.profile };
}

export function useSavedAssignment(site) {
  useSyncExternalStore(subscribe, () => version);
  return withSavedAssignment(site);
}
