// ============================================================
// הסכם השירות של האתר — מתוך לוח הרמזור
// ============================================================
// ⚠️ **זה לא תצוגה בלבד, וזו הנקודה.** שעות ההסכם קובעות מתי הזמינות
// בכלל נמדדת, ולכן אתר שאינו מחובר לשורה ברמזור מחושב 24/7 — כלומר
// תקלה בשבת באתר בסיסי נספרת ככשל מלא. עד עכשיו החיבור נעשה בהקלדת
// קוד לתוך הלוח, וזה דבר שצריך לזכור לעשות; כאן הוא נעשה מהמקום שבו
// שואלים את השאלה.
//
// ⚠️ **החיבור הוא לפי קוד ולא לפי שם, ונמדד למה.** התאמה לפי שם נתנה
// 5 מתוך 23, ושתי המלכודות שלה חמורות: "ז'בוטינסקי" מול "ז'בוטניסקי"
// לא מתאימים לעולם **בשקט**, ו"הירקון 72" מול "הירקון 224" הם בניינים
// שונים שהתאמה מקורבת הייתה מזווגת. זיווג שגוי מדווח זמינות של אתר
// אחד על חשבון אחר.
import { useEffect, useMemo, useState } from "react";
import { useAdmin } from "../../hooks/useAdmin";
import CodePrompt from "../TrafficLight/CodePrompt";
import { fetchBoard, setCell, addRow, deleteRow } from "../../services/dataSource";
import "./ServiceAgreement.css";

const CODE_LABEL = "קוד אתר";
const KIND_LABEL = "להתייחס כ";
// ⚠️ **שתי עמודות, שתי שאלות שונות — וזה לא כפילות.**
//   מסלול  = מה ההסכם שנחתם          (סוג הסכם שירות במקור)
//   שירות  = איך מתייחסים אליו בפועל  (להתייחס כ)
// ‏**רק "שירות" מחשב את הזמינות.** אתר שנחתם עליו בסיסי ומטופל כ-VIP
// יימדד לפי VIP, וזו החלטה תפעולית שגוברת על החוזה. הצגת שניהם זה לצד
// זה היא מה שהופך את הפער הזה לגלוי במקום למפתיע.
const PLAN_LABEL = "סוג הסכם שירות במקור";

// שעות ההסכם — אותו מקור אמת כמו `app.service_windows` ב-SQL.
// ⚠️ כפילות מודעת: כאן זה טקסט למסך, שם זה חישוב. מה שאסור הוא ששניהם
// יהיו *חישוב* בשני מקומות.
const HOURS = {
  basic: "א׳–ה׳ 08:00–17:00",
  ext: "א׳–ה׳ 07:00–22:00 · ו׳ 08:00–13:00",
  vip: "א׳–ה׳ 07:00–22:00 · ו׳–ש׳ 08:00–22:00",
};

const KIND_NAMES = { basic: "בסיסי", ext: "מורחב", vip: "VIP" };

// ⚠️ **תא הקוד מחזיק רשימה, לא קוד יחיד.** לקוח אחד יכול להחזיק כמה
// חניונים תחת אותו הסכם — אותם אנשי קשר, אותה אחריות, אותו סוג שירות.
// שורה כפולה לכל אתר פירושה שעדכון פרט אחד צריך להיעשות בכמה מקומות,
// ומי שיעדכן רק אחד מהם יישאר עם לוח שסותר את עצמו.
// ============================================================
// ⚠️ זיהוי שורה דומה — לפני שנוצרת כפולה
// ============================================================
// קרה בפועל: "ז'בוטינסקי 6" בלוח מול "ז'בוטניסקי 6" במערכת. אותו
// בניין, שתי אותיות מוחלפות, ושתי שורות נפרדות שאיש לא הבחין בהן עד
// שספרנו. השוואה מדויקת לא תופסת את זה — ולכן ההשוואה היא על **רב-קבוצת
// התווים**: החלפת סדר אותיות מניבה בדיוק אותה קבוצה.
//
// ⚠️ ומספרי הבתים נשמרים בהשוואה, ולכן "אחד העם 13" ו-"אחד העם 100"
// **אינם** דומים — הספרות שונות. זיהוי מוטעה כאן גרוע מהחמצה: הוא
// היה מציע לחבר אתר לשורה של בניין אחר.
// ⚠️ **אותן אותיות, לא אותם פסיקים.** "אוסישקין 58 , ת\"א" במערכת מול
// "אוסישקין 58, ת\"א" בלוח הם אותו אתר; ההבדל היחיד הוא סימני פיסוק
// ורווחים. ההשוואה כאן היא על רצף האותיות והספרות בלבד — **בסדר**,
// בניגוד ל-`fingerprint` שלמטה — ולכן היא זהות ולא דמיון.
function letters(name) {
  return String(name ?? "").replace(/[^0-9א-תA-Za-z]/g, "");
}

// ⚠️ וזו השכבה השנייה: רב-קבוצת תווים, שתופסת גם החלפת סדר אותיות
// ("בוטינסקי" מול "בוטניסקי"). היא **מציעה** ואינה מזהה — ולכן היא
// אזהרה, ולא בחירה מראש.
function fingerprint(name) {
  return String(name ?? "")
    .replace(/["'׳״,()\-]/g, "")
    .replace(/\s+/g, "")
    .split("")
    .sort()
    .join("");
}

function codesOf(cell) {
  return String(cell ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ⚠️ **עמודת סטטוס נערכת ברשימה סגורה ולא בהקלדה.** "VIP " או "Vip"
// אינם מוכרים ל-`app.service_agreement`, והאתר היה חוזר בשקט לחישוב
// 24/7 — בדיוק הכשל שהמסך הזה קיים כדי למנוע. אותו נימוק שהוציא את
// בורר התעבורה בסוכן מתיבת טקסט לרשימה.
function FieldEditor({ column, value, disabled, onSave }) {
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => { setDraft(value ?? ""); }, [value]);

  if (column.kind === "status") {
    const base = Array.isArray(column.options) ? column.options : [];

    // ⚠️ **ערך שאינו ברשימה מוצג ולא נבלע.** התא שומר את ה-`value` של
    // האפשרות; ערך שנכתב לפני שהעמודה הפכה לרשימה — או אחרי, בלי
    // שהאפשרות נוספה — היה מציג בורר **ריק**, והשמירה הראשונה הייתה
    // מוחקת אותו בשקט. כאן הוא מופיע כאפשרות נוספת, מסומן.
    const cur = String(draft ?? "").trim();
    const opts = cur && !base.some((o) => String(o.value) === cur)
      ? [...base, { value: cur, label: `${cur} (לא ברשימה)` }]
      : base;
    return (
      <select
        className="sa-select sa-select--cell"
        value={String(draft ?? "")}
        disabled={disabled}
        onChange={(e) => { setDraft(e.target.value); onSave(e.target.value); }}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>{o.label || o.value}</option>
        ))}
      </select>
    );
  }

  if (column.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={draft === true}
        disabled={disabled}
        onChange={(e) => { setDraft(e.target.checked); onSave(e.target.checked); }}
      />
    );
  }

  // ⚠️ שמירה ב-blur ולא בכל הקשה: שמירה לכל תו היא עשרות קריאות רשת
  // על מילוי שדה אחד, ובחיבור איטי היא גם מייצרת סדר כתיבה שאינו
  // בהכרח סדר ההקלדה.
  return (
    <input
      className="sa-cell-input"
      type="text"
      value={String(draft ?? "")}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (String(draft ?? "") !== String(value ?? "")) onSave(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
}

export default function ServiceAgreement({ site, onLinked = null }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState("");
  const [q, setQ] = useState("");

  // ⚠️ **אותו שער בדיוק כמו בלוח עצמו**, ולא שני מנגנונים שנראים זהים.
  // ‏`useAdmin` מאמת מול התפקיד, ו-`app.require_manager()` במסד הוא מה
  // שבאמת דוחה כתיבה — הקוד כאן הוא נוחות.
  const { unlocked, unlock, checking, error: unlockError } = useAdmin();
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchBoard()
      .then((b) => { if (alive) setBoard(b); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  const { codeKey, kindKey, planKey, nameKey, row, columns } = useMemo(() => {
    if (!board) return {};
    const cols = board.columns || [];
    const ck = cols.find((c) => c.label === CODE_LABEL)?.key;
    const kk = cols.find((c) => c.label === KIND_LABEL)?.key;
    const pk = cols.find((c) => c.label === PLAN_LABEL)?.key;
    const nk = cols[0]?.key;
    const r = ck
      ? (board.rows || []).find(
          (x) => codesOf(x.cells?.[ck]).includes(String(site.code)))
      : null;
    return { codeKey: ck, kindKey: kk, planKey: pk, nameKey: nk, row: r, columns: cols };
  }, [board, site.code]);

  // ⚠️ **שורה חדשה היא המקרה הרגיל, לא החריג.** ברוב האתרים אין שורה
  // בלוח כלל — הלוח נבנה מרשימת לקוחות ולא מרשימת האתרים המנוטרים.
  // דרישה למצוא שורה קיימת הייתה אומרת שכדי לחבר אתר צריך קודם ליצור
  // לו שורה בלוח, כלומר בדיוק הצעד שצריך לזכור ושבגללו 23 אתרים לא
  // חוברו.
  const NEW_ROW = "__new__";

  // ⚠️ **שמירה לפי תא ולא לפי שורה**, כמו בלוח עצמו: שליחת השורה
  // כולה הופכת כל שמירה לדריסה של מה שעורך אחר כתב בתא אחר.
  async function saveCell(rowId, key, value) {
    setBusy(true);
    setError(null);
    try {
      await setCell(rowId, key, value);
      setBoard(await fetchBoard());

      // ⚠️ שינוי ב"שירות" משנה את שעות המדידה ואת התג בכרטיס — לכן
      // רענון גם כאן, ולא רק בחיבור.
      if (key === kindKey) onLinked?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    if (!choice || !codeKey) return;
    setBusy(true);
    setError(null);
    try {
      let rowId = Number(choice);

      if (choice === NEW_ROW) {
        rowId = Number(await addRow(null));

        // ⚠️ **השם נכתב לפני הקוד, וזה לא סגנון.** אם הכתיבה השנייה
        // תיכשל, שורה עם שם ובלי קוד היא שורה שאפשר לראות ולתקן ביד;
        // שורה עם קוד ובלי שם היא שורה אלמונית שנראית כמו תקלה בלוח.
        if (nameKey) await setCell(rowId, nameKey, String(site.site_name ?? ""));
      }

      // ⚠️ **מוסיפים לרשימה ולא דורסים אותה.** דריסה הייתה מנתקת אתר
      // אחר מההסכם שלו — בשקט, ובלי שאיש יראה זאת עד שמישהו ישים לב
      // שהזמינות שלו חזרה ל-24/7.
      const target = (board.rows || []).find((r) => r.id === rowId);
      const existing = codesOf(target?.cells?.[codeKey]);
      const next = existing.includes(String(site.code))
        ? existing
        : [...existing, String(site.code)];

      await setCell(rowId, codeKey, next.join(", "));

      // ============================================================
      // ⚠️ ניתוק מהשורה הקודמת — אחרת הקוד יושב בשתיים
      // ============================================================
      // ‏`app.service_agreement` בוחרת `LIMIT 1` בלי סדר מוגדר. קוד
      // שמופיע בשתי שורות עם הסכמים שונים פירושו שהזמינות של האתר
      // תחושב לפי אחת מהן — **ולא תמיד אותה אחת**. זה לא "לא מסודר",
      // זה מדד שמשנה את עצמו בלי סיבה.
      if (row && row.id !== rowId) {
        const rest = codesOf(row.cells?.[codeKey]).filter((x) => x !== String(site.code));
        await setCell(row.id, codeKey, rest.length ? rest.join(", ") : "");
      }

      setBoard(await fetchBoard());
      setPicking(false);
      setChoice("");

      // ⚠️ **רשימת האתרים נטענת מחדש מיד.** רמת השירות של הכרטיס נגזרת
      // מההסכם שבשורה, ובלי הרענון התג ממשיך להציג את הערך הישן —
      // והמשתמשת רואה פעולה שלא עשתה כלום.
      onLinked?.();

      // ============================================================
      // ⚠️ שורה שנוצרה עכשיו נפתחת ישר לעריכה
      // ============================================================
      // היא נכתבת עם שם וקוד בלבד, ובתצוגה שדה ריק אינו מוצג — כלומר
      // מיד אחרי היצירה הפאנל נראה כמעט ריק, **בלי שום רמז שיש עוד
      // עשר עמודות למלא**. בעריכה כל העמודות מוצגות, גם הריקות, וזה
      // בדיוק הרגע שבו באים למלא אותן.
      //
      // ⚠️ ורק על שורה חדשה. חיבור לשורה **קיימת** של לקוח אחר אינו
      // הזמנה לערוך את הנתונים שלו.
      if (choice === NEW_ROW) {
        if (unlocked) setEditing(true);
        else setAsking(true);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !board) {
    return <div className="sa sa--err">טעינת הרמזור נכשלה: {error}</div>;
  }
  if (!board) return <div className="sa sa--dim">טוען הסכם שירות…</div>;

  if (!codeKey) {
    return (
      <div className="sa sa--err">
        אין בלוח הרמזור עמודת "{CODE_LABEL}" — בלעדיה אי אפשר לחבר אתר לשורה.
      </div>
    );
  }

  // ===== מחובר =====
  if (row && !picking) {
    const kind = String(row.cells?.[kindKey] ?? "").trim().toLowerCase();
    // ⚠️ ערך שאיננו מכירים מוצג כפי שהוא ולא נבלע לברירת מחדל: הוא
    // הסיבה שהזמינות של האתר הזה עדיין מחושבת 24/7, וההודאה בכך היא
    // מה שיגרום למישהו לתקן.
    const known = Object.prototype.hasOwnProperty.call(HOURS, kind);

    return (
      <div className="sa">
        <div className="sa-head">
          <span className="sa-title">שירות</span>
          <span className={`sa-kind sa-kind--${known ? kind : "unknown"}`}>
            {known ? KIND_NAMES[kind] : (kind || "לא הוגדר")}
          </span>

          {/* ⚠️ המסלול מוצג רק כשהוא **שונה** מהשירות. שני תגים זהים
              זה לצד זה הם רעש; שניים שונים הם בדיוק המידע. */}
          {(() => {
            const plan = String(row.cells?.[planKey] ?? "").trim().toLowerCase();
            if (!plan || plan === kind) return null;
            return (
              <span className="sa-plan" title="המסלול שנחתם בפועל — הזמינות מחושבת לפי השירות, לא לפיו">
                מסלול: {KIND_NAMES[plan] || plan}
              </span>
            );
          })()}
        </div>

        <div className="sa-hours">
          {known
            ? HOURS[kind]
            : "ההסכם בלוח אינו אחד מ-basic / ext / vip — הזמינות מחושבת 24/7"}
        </div>

        {known && (
          <div className="sa-note">
            הזמינות נמדדת <b>רק בתוך השעות האלה</b>. זמן מחוץ להן אינו נספר —
            לא לטובה ולא לרעה.
          </div>
        )}

        {/* ⚠️ **בעריכה כל העמודות מוצגות, גם הריקות.** בתצוגה שדה ריק
            הוא רעש; בעריכה הוא בדיוק מה שבאו למלא, והסתרתו הייתה
            הופכת את המסך הזה לחצי-עורך שאי אפשר לסמוך עליו. */}
        <dl className="sa-fields">
          {columns
            .filter((c) => c.label !== CODE_LABEL && c.key !== nameKey)
            .map((c) => {
              const v = row.cells?.[c.key];
              if (!editing && !String(v ?? "").trim()) return null;
              return (
                <div className="sa-field" key={c.key}>
                  <dt>{c.label}</dt>
                  <dd>
                    {editing
                      ? <FieldEditor
                          column={c}
                          value={v}
                          disabled={busy}
                          onSave={(next) => saveCell(row.id, c.key, next)}
                        />
                      : String(v)}
                  </dd>
                </div>
              );
            })}
        </dl>

        <div className="sa-foot">
          <span className="sa-linked">
            מחובר לשורה: <b>{String(row.cells?.[nameKey] ?? "—")}</b>
            {/* ⚠️ שיתוף מוצג במפורש: עריכה כאן משנה גם את האתרים
                האחרים, ומי שלא יודע זאת יגלה את זה אחרי שכבר שינה. */}
            {(() => {
              const others = codesOf(row.cells?.[codeKey])
                .filter((x) => x !== String(site.code));
              return others.length
                ? <> · משותפת עם <b>{others.join(", ")}</b></>
                : null;
            })()}
          </span>

          {editing ? (
            <button type="button" className="sa-btn sa-btn--ghost"
                    onClick={() => setEditing(false)} disabled={busy}>
              סיום עריכה
            </button>
          ) : (
            <>
              <button type="button" className="sa-btn sa-btn--ghost"
                      onClick={() => (unlocked ? setEditing(true) : setAsking(true))}>
                ערוך שורה
              </button>

              {/* ⚠️ **חיבור לשורה אחרת — הפער שחסם בפועל.** אתר שחובר
                  לשורה שגויה, או שנוצרה לו שורה ריקה בזמן שהפרטים
                  יושבים בשורה אחרת, לא היה ניתן להזזה בכלל. זה קרה
                  לפלורנטין: הקוד בשורה אחת, ההסכם והפרטים בשנייה. */}
              <button type="button" className="sa-btn sa-btn--ghost"
                      onClick={() => {
                        if (!unlocked) return setAsking(true);
                        setChoice(""); setQ(""); setPicking(true);
                      }}>
                חבר לשורה אחרת
              </button>

              <button
                type="button"
                className="sa-btn sa-btn--danger"
                disabled={busy}
                onClick={() => {
                  if (!unlocked) return setAsking(true);
                  // ⚠️ האזהרה אומרת **מה יקרה למדד**, לא רק "האם את בטוחה".
                  // מחיקת שורה מחזירה את האתר ל-24/7, וזה נתון שישתנה על
                  // המסך בלי שאיש יקשר בין השניים.
                  const others = codesOf(row.cells?.[codeKey]).filter((x) => x !== String(site.code));
                  const extra = others.length
                    ? `

שים לב: לשורה הזו מחוברים גם ${others.join(", ")} — גם הם יחזרו ל-24/7.`
                    : "";
                  if (!confirm(`למחוק את השורה "${String(row.cells?.[nameKey] ?? "")}"?` +
                               `

האתר יחזור לחישוב זמינות 24/7.${extra}`)) return;
                  setBusy(true);
                  deleteRow(row.id)
                    .then(fetchBoard)
                    .then((b) => { setBoard(b); onLinked?.(); })
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}>
                מחק שורה
              </button>
            </>
          )}
        </div>

        {error && <div className="sa-err">{error}</div>}

        {asking && (
          <CodePrompt
            checking={checking}
            error={unlockError}
            onClose={() => setAsking(false)}
            onUnlock={async (code) => {
              const ok = await unlock(code);
              // ⚠️ `!== false` ולא `if (ok)` — זרוע אחת של `useAdmin`
              // מחזירה `undefined` בהצלחה, ואז `if (ok)` היה משאיר את
              // התיבה פתוחה אחרי קוד **נכון**. אותו ניסוח בדיוק כמו
              // בלוח עצמו, ובכוונה.
              if (ok !== false) { setAsking(false); setEditing(true); }
            }}
          />
        )}
      </div>
    );
  }

  // ===== לא מחובר =====
  // ⚠️ הרשימה מציעה **רק שורות פנויות**. שורה שכבר נושאת קוד אחר
  // תיקח את הזמינות של אתר אחר אם ידרסו אותה, ולכן היא אינה מוצעת.
  // ⚠️ **כל השורות מוצעות, לא רק הפנויות.** שורה שכבר מחוברת לאתר
  // אחר היא בדיוק המקרה של לקוח עם כמה חניונים תחת הסכם אחד, והסתרתה
  // הייתה מאלצת לשכפל שורה — כלומר ליצור שני מקומות לאותה אמת.
  const free = board.rows || [];

  // שורות שנראות כמו אותו אתר — מוצגות לפני האפשרות ליצור חדשה.
  const fp = fingerprint(site.site_name);
  const lt = letters(site.site_name);

  // ⚠️ שתי דרגות, ולא אחת. זהות אותיות היא **אותו אתר** ולכן היא
  // נבחרת מראש; דמיון הוא **חשד** ולכן הוא רק מוצג.
  const exactRow = free.find((r) => letters(r.cells?.[nameKey]) === lt) || null;

  // ⚠️ החיפוש רץ על **כל** תאי השורה — שם, קוד, טלפון. מי שמחפש
  // "0524637238" מחפש בדיוק את מה שהוא רואה בלוח.
  const nq = String(q ?? "").replace(/[^0-9א-תA-Za-z]/g, "").toLowerCase();
  const matches = (nq
    ? free.filter((r) => Object.values(r.cells ?? {}).some(
        (v) => String(v ?? "").replace(/[^0-9א-תA-Za-z]/g, "").toLowerCase().includes(nq)))
    : free)
    // השורה בשם זהה תמיד ראשונה, גם בתוך תוצאות החיפוש.
    .sort((a, b) => (b === exactRow) - (a === exactRow));
  const similar = free.filter(
    (r) => r !== exactRow && fingerprint(r.cells?.[nameKey]) === fp);

  return (
    <div className="sa">
      <div className="sa-head">
        <span className="sa-title">הסכם שירות</span>
        {/* ⚠️ הכותרת אומרת את המצב **הנוכחי**, לא את המסך. אתר מחובר
            שמחפש שורה אחרת אינו "לא מחובר" — והודעה כזו הייתה גורמת
            למישהי לחשוב שהחיבור כבר נותק. */}
        <span className="sa-kind sa-kind--unknown">
          {row ? "בחירת שורה אחרת" : "לא מחובר"}
        </span>
      </div>

      <div className="sa-note">
        {row ? (
          <>
            מחובר כעת ל־<b>{String(row.cells?.[nameKey] ?? "")}</b>.
            בחירת שורה אחרת תנתק אותו מהשורה הזו ותחבר אותו לחדשה.
          </>
        ) : (
          <>
            האתר אינו מחובר לשורה ברמזור, ולכן הזמינות שלו מחושבת <b>24/7</b> —
            גם בשעות שאין בהן שירות.
          </>
        )}
      </div>

      {!picking ? (
        <>
          {/* ⚠️ **שורה בשם זהה מוצעת מיד, בלי לפתוח רשימה.** היא אינה
              "אפשרות אחת מני רבות" — היא האתר הזה. רשימה שצריך לפתוח
              ולחפש בה היא בדיוק הצעד שבגללו נוצרו שורות כפולות. */}
          {exactRow && (
            <div className="sa-match">
              נמצאה שורה בשם זהה: <b>{String(exactRow.cells?.[nameKey] ?? "")}</b>
              <button
                type="button"
                className="sa-btn"
                disabled={busy}
                onClick={() => { setChoice(String(exactRow.id)); setPicking(true); }}
              >
                חבר אליה
              </button>
            </div>
          )}

          <button type="button" className="sa-btn sa-btn--ghost"
                  onClick={() => { setChoice(exactRow ? String(exactRow.id) : ""); setPicking(true); }}>
            {exactRow ? "בחירה אחרת…" : "חבר לשורה ברמזור"}
          </button>
        </>
      ) : (
        <div className="sa-pick">
          {/* ============================================================
              ⚠️ חיפוש ולא רשימה נפתחת
              ============================================================
              הלוח מחזיק 156 שורות. רשימה נפתחת באורך כזה אינה "פחות
              נוחה" — היא בלתי שמישה: אי אפשר לגלול אליה בעין, אי אפשר
              להקליד בה, ומי שלא ימצא את השורה ייצור חדשה. כלומר הרשימה
              עצמה הייתה מייצרת את הכפילויות שאנחנו מונעים.

              ⚠️ וההשוואה מתעלמת מפיסוק, כמו בכל שאר החיפושים כאן. */}
          <input
            type="search"
            className="sa-select"
            placeholder="חיפוש שורה — שם או קוד…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setChoice(""); }}
            disabled={busy}
            autoFocus
          />

          <div className="sa-results">
            {/* יצירת שורה חדשה — תמיד ראשונה וזמינה, גם בזמן חיפוש. */}
            <button
              type="button"
              className={`sa-result ${choice === NEW_ROW ? "sa-result--on" : ""}`}
              onClick={() => setChoice(NEW_ROW)}
              disabled={busy}
            >
              ➕ צור שורה חדשה — {site.site_name}
            </button>

            {matches.slice(0, 12).map((r) => {
              const linked = codesOf(r.cells?.[codeKey]);
              const isExact = r === exactRow;
              return (
                <button
                  type="button"
                  key={r.id}
                  className={`sa-result ${String(choice) === String(r.id) ? "sa-result--on" : ""}` +
                             (isExact ? " sa-result--exact" : "")}
                  onClick={() => setChoice(String(r.id))}
                  disabled={busy}
                >
                  {isExact ? "✔ " : ""}
                  {String(r.cells?.[nameKey] ?? `שורה ${r.id}`)}
                  {linked.length ? <span className="sa-result-codes"> · {linked.join(", ")}</span> : null}
                </button>
              );
            })}

            {/* ⚠️ נאמר כמה לא מוצג. רשימה שנקטעת בשקט גורמת לחפש שוב
                את מה שכבר נמצא. */}
            {matches.length > 12 && (
              <div className="sa-dim">ועוד {matches.length - 12} — צמצמי את החיפוש</div>
            )}
            {q && matches.length === 0 && (
              <div className="sa-dim">אין שורה תואמת — אפשר ליצור חדשה</div>
            )}
          </div>

          <div className="sa-pick-actions">
            <button type="button" className="sa-btn" onClick={link} disabled={!choice || busy}>
              {busy ? "מחבר…" : "חבר"}
            </button>
            <button
              type="button"
              className="sa-btn sa-btn--ghost"
              onClick={() => { setPicking(false); setChoice(""); setQ(""); }}
              disabled={busy}
            >
              ביטול
            </button>
          </div>
        </div>
      )}

      {/* ⚠️ השגיאה מוצגת כפי שהיא. "מנהלים בלבד" מגיע מ-
          `app.require_manager()` במסד, ולא מהמסך — הודעה מנוסחת מחדש
          כאן הייתה מסתירה איזו שכבה סירבה. */}
      {error && <div className="sa-err">{error}</div>}

      {picking && similar.length > 0 && (
        <div className="sa-warn">
          ⚠️ כבר יש בלוח שורה שנראית כמו האתר הזה
          {" — "}
          <b>{String(similar[0].cells?.[nameKey] ?? "")}</b>.
          {" "}שורה שנייה לאותו בניין פירושה שעדכון פרט אחד ייעשה בשתיהן,
          ומי שיעדכן רק אחת יישאר עם לוח שסותר את עצמו.
        </div>
      )}

      {picking && (
        <div className="sa-dim">
          אפשר לחבר כמה אתרים לאותה שורה — לקוח אחד עם כמה חניונים תחת
          אותו הסכם.
        </div>
      )}
    </div>
  );
}
