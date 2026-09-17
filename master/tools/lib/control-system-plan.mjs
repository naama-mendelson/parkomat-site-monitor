// tools/lib/control-system-plan.mjs — מה לשנות בכל אתר: מערכת, סוג, וקישור ליצרן אחר.
//
// פונקציה טהורה: מקבלת את האתרים, את טבלת האתרים ואת מפת FixFlow, ומחזירה תוכנית.
// הכלי (`tools/backfill-control-system.mjs`) קורא ומבצע; ההחלטות כאן, ונבדקות ב-
// tests/backfill-control-system.test.js בלי מסד ובלי כונן.
//
// ============================================================
// ⚠️ סדר המקורות — ולמה
// ============================================================
//   1. **ערך שכבר הוגדר באתר — לא נדרס.** מי שהגדיר אותו ידע משהו.
//   2. **טבלת האתרים** (`G:\...\איתור תקלות\טבלת אתרים.xlsx`) — הסמכות שנקבעה
//      ב-17/09/2026: "תסתכל ב-EXCEL של סוגי האתרים, שם מפורט בדיוק".
//   3. **הנחיית המוצר לאתרים שאינם בטבלה:** "סוגי האתרים פה הם מסוג לולק, חוץ
//      מגרוזנברג שהוא מסוג ביטנקם". הטבלה עדיין לא מכילה את כל האתרים.
//
// ⚠️ **והתאמה לטבלה היא מדויקת ויחידה**, באותו נרמול כמו מפת FixFlow. שם שמתאים
// לשתי שורות אינו מותאם כלל — הוא מדווח. ניחוש כאן היה קובע יצרן לפי שם דומה.
import { norm } from "./site-names.mjs";
import { CONTROL_SYSTEM_KEYS } from "../../../shared/control-systems.mjs";
import { resolveLink, systemForType } from "../../../shared/fixflow-profiles.mjs";

// סוג הרובוט בטבלה → `plc_type` בדשבורד. **רק מה שחד-משמעי.** "מצבט", "קומבי",
// "אקסטרקטור" ו"מערכת cam" אין להם מקבילה בדשבורד — הם מדווחים ואינם מתורגמים.
export const TABLE_ROBOT_TO_PLC = {
  "xy": "xy",
  "דולי שאטל": "doli",
  "דולי": "doli",
  "שאטל מסילה": "shuttle-x",
  "שאטל מצבט y מסובבת": "matzbet-y",
  "שאטל מצבט y": "matzbet-y",
  "שאטל מצבט x": "matzbet-x",
  "שאטל מצבט x קומתי": "matzbet-x",
};

const RULE = "הנחיית המוצר: כל האתרים לולק חוץ מגרוזנברג (ביטנקם)";

/**
 * @param {Array<{id:number, code:string, site_name:string, plc_type?:string|null,
 *                control_system?:string|null, fixflow_profile?:string|null}>} sites
 * @param {Array<{name:string, robot:string, sys:string}>} tableRows
 * @param {object} map  מפת FixFlow (fixflow-sites.json)
 */
export function planControlSystems(sites, tableRows, map) {
  const byNorm = new Map();
  for (const r of tableRows) {
    const k = norm(r.name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(r);
  }

  return sites.map((s) => {
    const notes = [];
    const set = {};
    // ============================================================
    // ⚠️ שני מפתחות: שם האתר, ושם האתר ב-FixFlow שנבחר לו ידנית
    // ============================================================
    // בדשבורד "דה האז", בטבלה "דה האז 3 ת"א" — התאמה מדויקת אינה מחברת אותם, וזה
    // נכון שלא תחבר. אבל מישהו כבר קישר את הכרטיס ידנית ל-`דה האז 3 ת"א` ב-FixFlow,
    // ושמות האתרים שם **נזרעו מהטבלה**. זו ראיה שאדם נתן, לא דמיון שמות.
    const chosenId = String(s.fixflow_profile ?? "").trim().startsWith("site:")
      ? String(s.fixflow_profile).trim().slice(5).trim() : null;
    let matches = byNorm.get(norm(s.site_name)) ?? [];
    const chosenName = chosenId ? map?.ffSites?.[chosenId]?.name : null;
    if (!matches.length && chosenName) {
      const viaLink = byNorm.get(norm(chosenName)) ?? [];
      // ⚠️ **אבל קישור ידני אינו ראיה כשהוא סותר את הסוג.** הירקון 224 (מצבט — לולק
      // בלבד) קושר ידנית להירקון 38, שבטבלה הוא **ביטנקם**. שימוש בקישור כמפתח היה
      // קובע לו ביטנקם ומנציח בדיוק את הטעות שהכלי הזה בא לתקן.
      const mustSystem = systemForType(s.plc_type);
      if (viaLink.length === 1 && mustSystem && viaLink[0].sys !== mustSystem) {
        notes.push(`הקישור הידני מוביל ל"${viaLink[0].name}" (${viaLink[0].sys}), והסוג מחייב ${mustSystem} — לא שימש להתאמה`);
      } else {
        matches = viaLink;
      }
    }
    const row = matches.length === 1 ? matches[0] : null;
    if (matches.length > 1)
      notes.push(`השם מתאים ל-${matches.length} שורות בטבלה (${matches.map((m) => m.name).join(" / ")}) — לא הותאם`);

    // ---------- מערכת ----------
    let system = s.control_system || null;
    let systemSource = system ? "כבר הוגדר" : null;
    if (!system) {
      if (row && CONTROL_SYSTEM_KEYS.includes(row.sys)) {
        system = row.sys;
        systemSource = `טבלת האתרים: "${row.name}"`;
      } else {
        if (row) notes.push(`בטבלה: מערכת "${row.sys}" שאינה מוכרת — הוחל הכלל`);
        system = /גרוזנברג/.test(s.site_name) ? "ביטנקם" : "לולק";
        systemSource = RULE;
      }
      set.control_system = system;
    } else if (row && row.sys !== system) {
      notes.push(`⚠️ מוגדר ${system}, ובטבלה ${row.sys} — לא שונה, דורש בדיקה`);
    }

    // ---------- סוג ----------
    let plc = s.plc_type || null;
    if (row) {
      const fromTable = TABLE_ROBOT_TO_PLC[row.robot];
      if (!fromTable) notes.push(`בטבלה סוג "${row.robot}" — אין לו מקבילה בדשבורד`);
      else if (fromTable !== plc) {
        set.plc_type = fromTable;
        notes.push(`סוג: ${plc ?? "לא הוגדר"} → ${fromTable} (לפי הטבלה: "${row.robot}")`);
        plc = fromTable;
      }
    }

    // ---------- קישור ליצרן אחר ----------
    const chosen = String(s.fixflow_profile ?? "").trim();
    if (chosen) {
      const link = resolveLink({ ...s, plc_type: plc, control_system: system }, map);
      if (link.status === "system-mismatch") {
        set.fixflow_profile = "";
        notes.push(`קישור ידני נוקה: ${link.reason}`);
      }
    }

    return { id: s.id, code: s.code, name: s.site_name, systemSource, set, notes, tableRow: row };
  });
}
