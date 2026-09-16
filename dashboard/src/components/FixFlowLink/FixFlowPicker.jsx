// בחירת היעד ב-FixFlow לאתר — בטופס רישום האתר ובעריכתו.
//
// ============================================================
// ⚠️ שתי רמות קישור, וההבדל ביניהן הוא 22 חריגות
// ============================================================
//   אתר ב-FixFlow   התקלות של סוג המכונה **בתוספת חריגות האתר** — דרך
//                   טיפול שנכתבה למתקן הזה בלבד.
//   ספרייה          סוג המכונה בלבד.
//
// ⚠️ **הגרסה הראשונה הציעה ספריות בלבד, וזו הייתה רגרסיה שקטה:** גרוזנברג 7
// מחזיק 15 מתוך 22 חריגות האתר הקיימות, ובחירה ידנית של ספרייה שם הייתה
// מוחקת אותן מהמסך בלי שום סימן — בדיוק סוג הכשל שהפיילוט הזה נלחם בו.
//
// ============================================================
// ⚠️ למה גזירה אוטומטית אינה מספיקה — שלוש שיטות נמדדו
// ============================================================
//   התאמת שם       נכשלת בכל אתר שאינו ברשימת 117 של FixFlow — כלומר בכל
//                  אתר חדש שנרשום מהיום.
//   סוג מכונה      `xy` קיים גם בלולק וגם בביטנקם, ו-`matzbet-x` בלולק
//                  לבדה מתפצל לחמישה פרופילים.
//   נוסח התקלות    נבנה, אומת על 19 אתרים ידועים, ומסרב כשהראיה דקה.
//
// ⚠️ **והחמור: גזירה אינה יכולה לעבוד בעיקרון.** FixFlow מתייקת 5 אתרים
// ל-`שאטל מצבט x` שיש בו **0 מסמכים**, בזמן ש-25 המסמכים יושבים
// ב-`שאטל מצבט שמסובבת במעלית` שיש בו **אתר אחד**.
//
// ============================================================
// ⚠️ ולמה הרכיב יושב כאן ולא בטפסים
// ============================================================
// דרישת ההסרה: "אם לא אהיה מרוצה תעיף את כל ה-FixFlow מהאתר". כל קוד
// הפיילוט בתיקייה הזו, ונקודות החיבור הן שתי שורות בכל אחד משלושה קבצים.
import React, { useState } from "react";
import MAP from "./fixflow-sites.json";
import { FIXFLOW_ENABLED } from "../../services/fixflow.js";
import { resolveLink } from "../../../../shared/fixflow-profiles.mjs";
import "./FixFlowLink.css";

const norm = (v) => String(v ?? "").replace(/[^0-9א-תA-Za-z]/g, "").toLowerCase();

// ⚠️ ספריות ממוינות לפי מספר מסמכים, הגדולה ראשונה. מיון אלפביתי היה שם
// ספרייה ריקה בראש, וזו בדיוק הבחירה השגויה שקל ללחוץ עליה בטעות.
function profileGroups(q) {
  const bySystem = new Map();
  for (const [key, p] of Object.entries(MAP.profiles ?? {})) {
    if (q && !norm(p.profile).includes(q) && !norm(p.system).includes(q)) continue;
    if (!bySystem.has(p.system)) bySystem.set(p.system, []);
    bySystem.get(p.system).push({ key, ...p });
  }
  for (const list of bySystem.values()) list.sort((a, b) => b.docs - a.docs);
  return [...bySystem].sort((a, b) => a[0].localeCompare(b[0], "he"));
}

// ⚠️ 117 אתרים — הרשימה כבר ממוינת לפי שם בקובץ, וזו הדרך שבה מחפשים אתר.
function siteOptions(q) {
  return Object.entries(MAP.ffSites ?? {})
    .filter(([, s]) => !q || norm(s.name).includes(q))
    .map(([id, s]) => ({ id, ...s }));
}

export default function FixFlowPicker({ site, value, onChange }) {
  // ⚠️ הוק לפני כל `return` מוקדם — React אוסר קריאה מותנית להוקים, ובדיקת
  // FIXFLOW_ENABLED לפניו הייתה מפילה את המסך ברגע שהפיילוט נכבה.
  const [q, setQ] = useState("");
  if (!FIXFLOW_ENABLED) return null;

  const query = norm(q);
  const profiles = profileGroups(query);
  const sites = siteOptions(query);
  const total = profiles.reduce((n, [, l]) => n + l.length, 0) + sites.length;

  // מה ייקרה אם לא בוחרים דבר — מוצג כדי שהבחירה תהיה מודעת ולא בחושך.
  const auto = resolveLink({ ...site, fixflow_profile: "" }, MAP);
  const chosenSite = value?.startsWith("site:") ? MAP.ffSites?.[value.slice(5)] : null;
  const chosenProfile = value && !value.startsWith("site:") ? MAP.profiles?.[value] : null;

  return (
    <div className="ffp">
      <label className="ffp-row">
        <span>יעד ב-FixFlow</span>
        <input
          type="search"
          className="ffp-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="סינון לפי שם אתר או ספרייה…"
          aria-label="סינון היעד"
        />
      </label>

      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {/* ⚠️ "אוטומטי" הוא ערך אמיתי ולא placeholder: הוא מנקה בחירה קודמת
            ומחזיר את האתר לגזירה. בלעדיו אי אפשר לבטל בחירה שנעשתה בטעות. */}
        <option value="">אוטומטי — לפי שם האתר או סוג המכונה</option>

        {/* ⚠️ האתרים ראשונים, כי קישור ברמת האתר עדיף תמיד: הוא מביא את אותן
            תקלות **ועוד** את חריגות האתר. סדר הוא המלצה שקטה. */}
        {sites.length > 0 && (
          <optgroup label={`אתר ב-FixFlow — כולל חריגות אתר (${sites.length})`}>
            {sites.map((s) => (
              <option key={s.id} value={`site:${s.id}`}>
                {s.name} · {s.profile} · {s.docs} מסמכים
                {s.overrides ? ` · ${s.overrides} חריגות` : ""}
              </option>
            ))}
          </optgroup>
        )}

        {profiles.map(([system, list]) => (
          <optgroup key={system} label={`ספרייה — ${system}`}>
            {list.map((p) => (
              <option key={p.key} value={p.key}>
                {p.profile} — {p.docs} מסמכים
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {/* ⚠️ "לא נמצא" מפורש ולא רשימה שנראית ריקה: תפריט בלי אפשרויות נראה
          כמו תקלת טעינה, ולא כמו תוצאה של מה שהוקלד. */}
      {query && total === 0 && (
        <small className="ffp-note ffp-warn">אין יעד שתואם ל"{q}".</small>
      )}

      {/* ============================================================
          ⚠️ התוצאה מוצגת מתחת לשדה, ולא רק נשמרת
          ============================================================
          קישור שמוביל ליעד הלא נכון אינו מציג שגיאה — כל הצעדים שם נראים
          סבירים. השורה הזו היא ההזדמנות היחידה להבחין בכך לפני שמוקדן
          נשלח לשם באמצע אירוע. */}
      <Outcome value={value} chosenSite={chosenSite} chosenProfile={chosenProfile} auto={auto} />
    </div>
  );
}

function Outcome({ value, chosenSite, chosenProfile, auto }) {
  if (!value) {
    return (
      <small className={auto.status === "ok" ? "ffp-note" : "ffp-note ffp-warn"}>
        {auto.status === "ok"
          ? `אוטומטי מוביל ל: ${auto.system} / ${auto.profile}` +
            (auto.docs === 0 ? " — ⚠️ ריקה" : auto.docs ? ` · ${auto.docs} מסמכים` : "")
          : `⚠️ אוטומטי אינו מצליח: ${auto.reason}`}
      </small>
    );
  }
  if (value.startsWith("site:")) {
    if (!chosenSite)
      return <small className="ffp-note ffp-warn">⚠️ האתר שנבחר אינו ברשימה — ייתכן שנמחק ב-FixFlow</small>;
    return (
      <small className={chosenSite.docs > 0 ? "ffp-note" : "ffp-note ffp-warn"}>
        {chosenSite.docs > 0
          ? `נבחר האתר ${chosenSite.name} · ${chosenSite.profile} · ${chosenSite.docs} מסמכים` +
            (chosenSite.overrides ? ` · ${chosenSite.overrides} חריגות אתר` : " · אין חריגות אתר")
          : `⚠️ "${chosenSite.name}" משויך ל-${chosenSite.profile}, שאין בה מסמכים`}
      </small>
    );
  }
  if (!chosenProfile)
    return <small className="ffp-note ffp-warn">⚠️ הספרייה "{value}" אינה קיימת ב-FixFlow</small>;
  return (
    <small className={chosenProfile.docs > 0 ? "ffp-note" : "ffp-note ffp-warn"}>
      {chosenProfile.docs > 0
        ? `נבחרה הספרייה ${chosenProfile.system} / ${chosenProfile.profile} · ${chosenProfile.docs} מסמכים · ללא חריגות אתר`
        : `⚠️ "${chosenProfile.profile}" קיימת אך ריקה — הכפתור בכרטיס יאמר "ספרייה ריקה"`}
    </small>
  );
}
