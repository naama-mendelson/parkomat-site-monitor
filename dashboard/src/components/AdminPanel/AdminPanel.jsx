// components/AdminPanel/AdminPanel.jsx — ניהול אתרים: הוספה, עריכה, מחיקה, שינוי קוד.
// זמין רק למנהל בקרה ומנהל כללי, ומאחורי קוד מנהל שהשרת אוכף.
import { useState, useEffect } from "react";
import SiteIdentities from "../SiteIdentities/SiteIdentities";
import { STATUS_COLORS, STATUS_LABELS, TIER_OPTIONS, TIER_LABELS } from "../../utils/constants";
// ⚠️ הכתיבות דרך dataSource, ו-`changeAdminCode`/`storeAdminCode` נשארים
// מ-api: הקוד המשותף הוא מנגנון של השרת בלבד ואינו קיים ב-Supabase.
import { updateSite, deleteSite, provisionAgent, agentEverBeat, markControllerReplaced, sitesWithAgentIdentity } from "../../services/dataSource";
import { changeAdminCode } from "../../services/dataSource";
import { markUnlocked as storeAdminCode } from "../../services/adminCodeDirect";
import { SITE_TYPE_GROUPS, siteTypeFullLabel } from "../../../../shared/site-types.mjs";
import { CONTROL_SYSTEMS } from "../../../../shared/control-systems.mjs";
import { useAdmin } from "../../hooks/useAdmin";
import { copyText } from "../../utils/clipboard";
import AddSiteModal from "../AddSiteModal/AddSiteModal";
import FixFlowPicker from "../FixFlowLink/FixFlowPicker.jsx"; // פיילוט FixFlow — להסרה: מחק שורה זו ואת <FixFlowPicker/> למטה
import "./AdminPanel.css";
import Logo from "../Logo/Logo";

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function AdminPanel({ sites, onClose: closePanel, onChanged }) {
  // ============================================================
  // ⚠️ סגירה בזמן שסיסמה חד-פעמית על המסך — רק באישור מפורש
  // ============================================================
  // Supabase שומרת hash בלבד, ולכן סיסמת סוכן שנמחקה מהמסך אובדת. הרקע,
  // ה-✕ ו"חזרה לאתרים" כולם הרסו אותה בלחיצה אחת — ו-AddSiteModal, שמרונדר
  // בתוך השכבה הזו, העביר לחיצה על הרקע שלו עד לכאן וסגר את כל הפאנל.
  const [secretShown, setSecretShown] = useState(false);
  const mayLeave = () => !secretShown || window.confirm("הסיסמה שמוצגת תאבד ואי אפשר לשחזר אותה. לסגור בכל זאת?");
  const onClose = () => { if (mayLeave()) closePanel(); };
  const { unlocked, unlock, checking, error: unlockError, roleGated, role } = useAdmin();
  // ⚠️ במצב ישיר אין קוד מנהל — פותחים בסיסמת החשבון. הטקסט חייב לומר
  // את זה: מסך שמבקש "קוד מנהל" ממי שאין לו קוד הוא מסך שאי אפשר לעבור.
  // ⚠️ שתי הזרועות מבקשות עכשיו את **קוד המנהל**, ולכן אין יותר טקסט מותנה.

  const [code, setCode] = useState("");
  const [editing, setEditing] = useState(null);       // קוד האתר שנערך
  const [draft, setDraft] = useState({ name: "", code: "" });
  // ⚠️ פרטי הזהות שהונפקה — נשארים על המסך עד סגירה ידנית.
  const [agentIssued, setAgentIssued] = useState(null);
  // ⚠️ אישור נפרד: הפעולה משנה את משמעות המונה ואינה הפיכה.
  const [confirmController, setConfirmController] = useState(null);
  const [confirmRotate, setConfirmRotate] = useState(null);
  // ⚠️ **מי מנפיק, ולא "מנפיקים".** `busy` הוא סטייט אחד לכל הפאנל, ולכן
  // לחיצה על אתר אחד החליפה את הכיתוב ל"מנפיק…" **בכל השורות** והשביתה
  // את כולן — נראה בדיוק כאילו נלחצו כל האתרים בבת אחת.
  const [issuing, setIssuing] = useState(null);

  // ============================================================
  // ⚠️ מי חסר זהות סוכן — שאלה שלא הייתה ניתנת לשאילה מהמסך
  // ============================================================
  // ‏15/09/2026: הזהויות הופיעו ברשימת המשתמשים בין בני אדם, נמחקו בהיגיון
  // מלא, ו-19 אתרים איבדו את המסלול הישיר. איש לא ידע: MQTT המשיך למסור,
  // המסכים נשארו נכונים, ורק הפעימה מתה — כלומר **זיהוי הניתוק עצמו**.
  //
  // ⚠️ `undefined` = עוד לא נבדק · `null` = לא הצלחנו לברר · Set = התשובה.
  // שלושה מצבים ולא שניים: קבוצה ריקה בגלל שגיאת רשת הייתה צובעת את כל
  // האתרים באזהרה שקרית.
  const [showIdentities, setShowIdentities] = useState(false);

  // ============================================================
  // ⚠️ חיפוש אתר — והנרמול זהה לזה של הרמזור, בכוונה
  // ============================================================
  // ‏34 אתרים הם רשימה שגוללים בה, וכל פעולה כאן (עריכה, זהות, מחיקה) היא
  // פעולה על **אתר מסוים** שצריך למצוא קודם.
  //
  // ⚠️ ההשוואה מתעלמת מפיסוק ומרווחים, בדיוק כמו בחיפוש הרמזור: מי שמקלידה
  // "אביגיל 20 רג" מהזיכרון תמצא את `אביגיל 20, ר"ג`. חיפוש שנכשל על פסיק
  // הוא חיפוש שנראה כאילו האתר אינו קיים.
  const [query, setQuery] = useState("");
  const normQ = (v) => String(v ?? "").replace(/[^0-9א-תA-Za-z]/g, "").toLowerCase();
  const q = normQ(query);
  // מחפש בשם ובקוד: "2222" ו-"גרוזנברג" הם שתי דרכים לחשוב על אותו אתר.
  const visibleSites = q
    ? sites.filter((s) => normQ(s.site_name).includes(q) || normQ(s.code).includes(q))
    : sites;
  const [withIdentity, setWithIdentity] = useState(undefined);
  useEffect(() => { sitesWithAgentIdentity().then(setWithIdentity).catch(() => setWithIdentity(null)); }, [agentIssued]);
  const missingIdentity = (s) => withIdentity instanceof Set && !withIdentity.has(s.id);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  // שינוי קוד המנהל
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });

  function flash(text) {
    setMsg(text);
    setErr(null);
    setTimeout(() => setMsg(null), 2600);
  }

  async function handleUnlock(e) {
    e.preventDefault();
    await unlock(code);
    setCode("");
  }

  function startEdit(site) {
    setEditing(site.code);
    // ⚠️ `?? ""` ולא `|| ""` — הערכים במסד הם NULL, ו-input עם value=null
    // הופך ל"uncontrolled" ומדפיס אזהרה ב-React. וריק כאן הוא ערך תקין:
    // הוא מה שיישלח כדי לנקות שדה.
    setDraft({
      name: site.site_name,
      code: site.code,
      // ⚠️ מהמסד ולא מההסכם — ראה `manualTier` ב-sitesDirect. `initialTier`
      // נשמר כדי לשלוח דרגה **רק כשהמשתמשת שינתה אותה**.
      tier: site.manualTier ?? site.tier ?? "basic",
      initialTier: site.manualTier ?? site.tier ?? "basic",
      plcType: site.plc_type ?? "",
      controlSystem: site.control_system ?? "",
      initialControlSystem: site.control_system ?? "",
      fixflowProfile: site.fixflow_profile ?? "",   // פיילוט FixFlow
    });
    setErr(null);
  }

  async function saveEdit(originalCode) {
    const name = draft.name.trim();
    const newCode = draft.code.trim();

    if (!name) return setErr("שם האתר לא יכול להיות ריק");
    if (!CODE_PATTERN.test(newCode)) {
      return setErr("קוד האתר: אותיות באנגלית, ספרות, מקף וקו תחתון בלבד");
    }

    setBusy(true);
    setErr(null);
    try {
      // ⚠️ סוג המתקן נשלח **תמיד**, גם כשהוא ריק. שליחה מותנית
      // (רק כשיש ערך) הייתה הופכת "נקה את השדה" לפעולה בלתי אפשרית: השרת
      // מבדיל בין שדה שלא נשלח לבין שדה שנשלח ריק, וזה בדיוק ההבדל בין
      // "אל תיגע" לבין "מחק".
      await updateSite(originalCode, {
        site_name: name,
        code: newCode,
        // undefined = "אל תיגע" (updateSiteDirect אינו שולח p_tier).
        tier: draft.tier !== draft.initialTier ? draft.tier : undefined,
        plc_type: draft.plcType,
        // ⚠️ רק כששונתה — ריק כששונתה פירושו "נקה". undefined = אל תיגע.
        control_system: draft.controlSystem !== draft.initialControlSystem ? draft.controlSystem : undefined,
        // ⚠️ נשלח תמיד, גם ריק — מאותה סיבה בדיוק כמו סוג המתקן: ריק הוא
        // "חזור לגזירה האוטומטית", ובלי שליחה אי אפשר לבטל בחירה. פיילוט FixFlow.
        fixflow_profile: draft.fixflowProfile,
      });
      setEditing(null);
      onChanged();
      flash(`האתר "${name}" עודכן`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(site) {
    setBusy(true);
    setErr(null);
    try {
      const r = await deleteSite(site.code);
      setConfirmDelete(null);
      onChanged();
      flash(
        `האתר "${r.deleted.name}" נמחק — ` +
        `${r.deleted.operations} פעולות ו-${r.deleted.statusHistory} שינויי מצב הוסרו`,
      );
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ============================================================
  // הנפקת זהות סוכן לאתר קיים
  // ============================================================
  // ⚠️ **הסיסמה מוצגת פעם אחת ואינה ניתנת לשחזור**, ולכן היא לא נכנסת
  // ל-flash שנעלם מעצמו — היא נשארת על המסך עד שסוגרים אותה ידנית.
  //
  // ⚠️ **ו-409 ("כבר קיימת") אינו מסך סופי אלא שאלה.** הוא אומר שהאתר כבר
  // מוגדר, וזו תשובה נכונה — אבל עד כה הוא הוצג כשגיאה, ואז
  // הדרך היחידה להנפיק סיסמה חדשה הייתה פקודה ידנית על מחשב עם `.env` —
  // כלומר פעולה שאי אפשר לעשות מהדשבורד, לאתר שכבר מוגדר. שלושה אתרים
  // (1326, 1414, 3510) נתקעו בדיוק שם: זהות שהונפקה ב-06/09, סיסמה
  // שהוצגה פעם אחת ולא נשמרה, ואפס דרכים להמשיך מהמסך.
  async function issueAgent(site, rotate = false) {
    setIssuing(site.code);
    setErr(null);
    try {
      const r = await provisionAgent(site.code, { rotate });
      setConfirmRotate(null);
      setAgentIssued({
        code: site.code, email: r.email, password: r.password,
        rotated: Boolean(r.rotated),
      });
    } catch (e) {
      // ⚠️ הסיבוב **אינו** קורה בלחיצה אחת: הוא מבטל את הסיסמה הקודמת
      // מיד, ואתר שכבר משתמש בה מפסיק לדווח עד שמעדכנים אותו בשטח.
      if (!e.alreadyExists || rotate) { setErr(e.message); return; }

      // ============================================================
      // ⚠️ לחיצה אחת כשזה בטוח, אישור כשלא
      // ============================================================
      // אתר ש**מעולם לא פעם** — הסיסמה שלו אינה בשימוש
      // בשום מקום, וסיבוב אינו שובר כלום. לדרוש שם אישור
      // הוא להפוך את ההגנה למכשול: שלושה אתרים היו תקועים
      // שבוע בדיוק משום שפעולה ללא סיכון נראתה כמו שגיאה.
      //
      // ⚠️ אתר ש**פועם** נמצא במסלול הישיר ברגע זה, וסיבוב
      // מפסיק את הדיווח שלו עד שמישהו ייסע לעדכן את ה-config.
      // ו-`null` הוא "לא הצלחתי לברר" — גם הוא דורש אישור.
      // ⚠️ **עטוף, כי הוא רץ בתוך `catch`.** חריגה כאן הייתה בורחת מ-
      // `issueAgent` כולה — בלי הודעת שגיאה, בלי אישור, בלי כלום. המסך
      // היה נראה כאילו הכפתור פשוט אינו עושה דבר, וזה הכשל הכי קשה
      // לאבחון: אין מה לקרוא.
      let beat = null;
      try { beat = await agentEverBeat(site.id); } catch { beat = null; }

      if (beat === false) { await issueAgent(site, true); return; }
      setConfirmRotate(site.code);
    } finally {
      setIssuing(null);
    }
  }

  // ============================================================
  // "הוחלף בקר" — הקריאה הבאה נקלטת כבסיס, בלי להוסיף למונה
  // ============================================================
  // ⚠️ **באישור ולא בלחיצה אחת.** הפעולה משנה את משמעות המונה, ולחיצה
  // בטעות על אתר שלא הוחלף בו בקר תגרום לקריאה הבאה להיקלט כבסיס —
  // כלומר המחזורים שנעשו מאז הקריאה האחרונה **לא ייספרו**.
  //
  // ⚠️ והנזק אינו סימטרי: לא לסמן כשצריך מוסיף עשרות מחזורים מדומים;
  // לסמן כשלא צריך מאבד את מה שנעשה בין שתי הקריאות. שניהם בלתי הפיכים.
  async function replaceController(site) {
    setBusy(true);
    setErr(null);
    try {
      const r = await markControllerReplaced(site.code);
      setConfirmController(null);
      onChanged();
      flash(`${site.site_name}: הבקר סומן כמוחלף — המונה נשאר ${r.cycleTotal?.toLocaleString() ?? "?"}`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleChangeCode(e) {
    e.preventDefault();
    setErr(null);

    if (pw.next.trim().length < 4) return setErr("הקוד החדש חייב להכיל לפחות 4 תווים");
    if (pw.next !== pw.confirm) return setErr("הקוד החדש ואימותו אינם תואמים");

    setBusy(true);
    try {
      await changeAdminCode(pw.current, pw.next.trim());
      // הקוד השמור חייב להתעדכן, אחרת הבקשה הבאה תיכשל עם הקוד הישן
      storeAdminCode(pw.next.trim());
      setPw({ current: "", next: "", confirm: "" });
      setPwOpen(false);
      flash("קוד המנהל עודכן");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ============================================================
  // ⚠️ מסך נעילה — ושתי גרסאות שונות, לא אחת עם טקסט אחר
  // ============================================================
  // כשההרשאה נגזרת מהתפקיד, **אין מה להקליד**. טופס קוד כאן היה מזמין
  // בקר לנסות שוב ושוב משהו שלא יעבוד לעולם, ולהסיק שהוא הקליד שגוי.
  if (!unlocked && roleGated) {
    return (
      <div className="adm-overlay" onClick={onClose}>
        <div className="adm-lock" onClick={(e) => e.stopPropagation()}>
          <div className="adm-lock-icon"><Logo size={40} /></div>
          <h2>ניהול אתרים</h2>
          {checking ? (
            <p>בודק הרשאות…</p>
          ) : (
            <>
              <p>הוספה, עריכה ומחיקה של אתרים מותרות למנהלים בלבד.</p>
              {/* ⚠️ מוצג במפורש: בלי זה המסך אומר "אין לך הרשאה" ומשתמשת
                  שיודעת שהיא מנהלת אינה יכולה לדעת שהתפקיד שלה במסד שונה
                  ממה שהיא חושבת — וזה בדיוק המצב שקרה בפועל. */}
              <p className="adm-lock-role">התפקיד שלך: {role === "manager" ? "מנהל" : "בקר"}</p>
              <p className="adm-lock-hint">לשינוי התפקיד — יש לפנות למנהל אחר.</p>
            </>
          )}
          <div className="adm-lock-actions">
            <button type="button" className="adm-btn" onClick={onClose}>סגור</button>
          </div>
        </div>
      </div>
    );
  }

  // ===== מסך נעילה — זרוע השרת, קוד משותף =====
  if (!unlocked) {
    return (
      <div className="adm-overlay" onClick={onClose}>
        <div className="adm-lock" onClick={(e) => e.stopPropagation()}>
          <div className="adm-lock-icon"><Logo size={40} /></div>
          <h2>ניהול אתרים</h2>
          <p>הזיני את קוד המנהל כדי להוסיף, לערוך או למחוק אתרים.</p>

          <form onSubmit={handleUnlock}>
            <input
              type="password"
              placeholder="קוד מנהל"
              autoComplete="current-password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            {unlockError && <p className="adm-err">{unlockError}</p>}
            <div className="adm-lock-actions">
              <button type="button" className="adm-btn-ghost" onClick={onClose}>ביטול</button>
              <button type="submit" className="adm-btn" disabled={checking || !code}>
                {checking ? "בודק…" : "כניסה"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ===== מסך הניהול =====
  return (
    <div className="adm-overlay" onClick={onClose}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <header className="adm-head">
          <div>
            <h2>ניהול אתרים</h2>
            <p>{sites.length} אתרים רשומים</p>
          </div>
          <div className="adm-head-actions">
            <button className="adm-btn" onClick={() => setAddOpen(true)}>+ הוסף אתר</button>
            {/* ⚠️ מסך נפרד, ולא עוד עמודה בטבלת האתרים. זהות היא נושא בפני
                עצמו — היא נוצרת, מושבתת ומוחלפת בסיסמה — והמקום היחיד שבו
                היא הופיעה עד 15/09 היה רשימת המשתמשים, בין בני אדם. */}
            <button className="adm-btn-ghost" onClick={() => { if (mayLeave()) { setSecretShown(false); setShowIdentities((v) => !v); } }}>
              {showIdentities ? "← חזרה לאתרים" : "זהויות אתרים"}
            </button>
            {/* ⚠️ מוסתר במצב ישיר, כי הוא משנה סוד שאף כתיבה כאן אינה
                שולחת יותר. כפתור שנראה כמו "שנה סיסמת ניהול" ובפועל
                משנה מנגנון רדום הוא הטעיה — למי שילחץ עליו ייראה שהוא
                החמיר אבטחה, ולא שינה כלום. */}
            {!roleGated && (
              <button className="adm-btn-ghost" onClick={() => setPwOpen((o) => !o)}>
                שנה קוד מנהל
              </button>
            )}
            {/* ⚠️ כפתור "נעל" הוסר. המסך נעול בכל פתיחה ממילא, ולכן
                כפתור שנועל אותו שוב הוא הבטחה ריקה — הוא לא עשה דבר
                מלבד לסגור. */}
            <button className="adm-close" onClick={onClose} aria-label="סגירה">✕</button>
          </div>
        </header>

        {msg && <div className="adm-msg">{msg}</div>}
        {err && <div className="adm-err adm-err-bar">{err}</div>}

        {/* ⚠️ החלפה מלאה ולא הצגה זו לצד זו: זהויות ואתרים הם שני נושאים,
            ושתי טבלאות באותו מסך היו מחזירות בדיוק את הבלבול שהמסך הזה נולד
            כדי לפתור — שורה שנראית כמו שורה אחרת ומזמינה את אותה פעולה. */}
        {showIdentities ? <SiteIdentities onSecretShown={setSecretShown} /> : (<>

        {/* ==========================================================
            הזהות שהונפקה — נשארת עד סגירה ידנית
            ==========================================================
            ⚠️ **לא flash.** flash נעלם אחרי 2.6 שניות, והסיסמה כאן אינה
            ניתנת לשחזור — היעלמות אוטומטית הייתה מאבדת אותה לתמיד ומשאירה
            אתר שאי אפשר לחבר. הסגירה חייבת להיות פעולה של אדם. */}
        {agentIssued && (
          <div className="adm-agent-overlay">
          <div className="adm-agent-modal">
            <b>{agentIssued.rotated
              ? `הונפקה סיסמה חדשה לאתר ${agentIssued.code}`
              : `נוצרה זהות לאתר ${agentIssued.code}`}</b>
            <div style={{ marginTop: 8, fontFamily: "monospace", direction: "ltr" }}>
              {agentIssued.email}
            </div>
            <div style={{ fontFamily: "monospace", direction: "ltr", wordBreak: "break-all" }}>
              {agentIssued.password}
            </div>
            <div style={{ marginTop: 8 }}>
              ⚠️ הסיסמה מוצגת <b>פעם אחת בלבד</b>. היא נכנסת להגדרות הסוכן
              במחשב שבאתר, בשדה "סיסמת האתר".
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button className="adm-btn" onClick={async () => {
                // ⚠️ **הסיסמה בלבד, בלי המייל** (בקשת בעלת המוצר, 24/09/2026).
                // בטופס הסוכן יש שדה אחד — "סיסמת האתר"; המייל נגזר מקוד האתר
                // (SupabaseDefaults.EmailFor), ולכן העתקת שניהם חייבה למחוק שורה
                // לפני ההדבקה. copyText ולא navigator.clipboard: הוא עובד גם
                // בהקשר לא-מאובטח, ואינו זורק.
                if (await copyText(agentIssued.password)) flash("הסיסמה הועתקה");
                else setErr("ההעתקה נכשלה — יש להעתיק ידנית");
              }}>העתק סיסמה</button>
              <button className="adm-btn-ghost"
                onClick={() => setAgentIssued(null)}>העתקתי, סגור</button>
            </div>
          </div>
          </div>
        )}

        {/* שינוי קוד מנהל */}
        {pwOpen && (
          <form className="adm-pw" onSubmit={handleChangeCode}>
            <h3>שינוי קוד המנהל</h3>
            <div className="adm-pw-row">
              <input type="password" placeholder="הקוד הנוכחי" value={pw.current}
                onChange={(e) => setPw({ ...pw, current: e.target.value })} />
              <input type="password" placeholder="קוד חדש (4+ תווים)" value={pw.next}
                onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              <input type="password" placeholder="אימות הקוד החדש" value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              <button className="adm-btn" disabled={busy}>עדכן</button>
            </div>
          </form>
        )}

        {/* ============================================================ */}
        {/* הפעלה מחדש של השרת                                          */}

        {/* רשימת האתרים */}
        {/* ⚠️ מוצג רק כשיש מה לחפש בו. תיבת חיפוש מעל שלושה אתרים היא רעש. */}
        {sites.length > 6 && (
          <div className="adm-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חיפוש אתר לפי שם או קוד…"
              aria-label="חיפוש אתר"
            />
            {q && (
              <span className="adm-search-count">
                {visibleSites.length} מתוך {sites.length}
              </span>
            )}
          </div>
        )}

        <div className="adm-list">
          {sites.length === 0 ? (
            <p className="adm-empty">אין אתרים רשומים. התחל בהוספת אתר.</p>
          ) : visibleSites.length === 0 ? (
            /* ⚠️ אומר במפורש שזו תוצאת סינון ולא רשימה ריקה — אחרת זה נראה
               כאילו האתרים נעלמו. */
            <p className="adm-empty">אין אתר שתואם ל"{query}".</p>
          ) : (
            visibleSites.map((s) => {
              const c = STATUS_COLORS[s.status] || STATUS_COLORS.no_comm;
              const isEditing = editing === s.code;
              const isConfirming = confirmDelete === s.code;

              return (
                <div key={s.code} className={`adm-row ${isConfirming ? "is-danger" : ""}`}>
                  <span className="adm-dot" style={{ background: c.dot }} />

                  {isEditing ? (
                    <div className="adm-edit">
                      <label>
                        <span>שם</span>
                        <input value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                      </label>
                      <label>
                        <span>קוד</span>
                        <input value={draft.code}
                          onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                      </label>
                      <label>
                        <span>דרגה</span>
                        <select value={draft.tier}
                          onChange={(e) => setDraft({ ...draft, tier: e.target.value })}>
                          {TIER_OPTIONS.map((t) => (
                            <option key={t} value={t}>{TIER_LABELS[t]}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>סוג המתקן</span>
                        <select value={draft.plcType}
                          onChange={(e) => setDraft({ ...draft, plcType: e.target.value })}>
                          <option value="">לא הוגדר</option>
                          {SITE_TYPE_GROUPS.map((g) => (
                            <optgroup key={g.key} label={g.label}>
                              {g.types.map((t) => (
                                <option key={t.key} value={t.key}>{t.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </label>
                      {/* ⚠️ מערכת ההפעלה — ליד הסוג, כי שניהם יחד קובעים את הנהלים.
                          אותו XY של לולק ושל ביטנקם מקבל ספריית תקלות אחרת. */}
                      <label>
                        <span>מערכת</span>
                        <select value={draft.controlSystem}
                          onChange={(e) => setDraft({ ...draft, controlSystem: e.target.value })}>
                          <option value="">לא הוגדר</option>
                          {CONTROL_SYSTEMS.map((c) => (
                            <option key={c.key} value={c.key}>{c.label}</option>
                          ))}
                        </select>
                      </label>
                      <FixFlowPicker
                        // ⚠️ עם הטיוטה, לא עם השמור: שינוי מערכת או סוג בטופס חייב
                        // לשנות מיד את היעד האוטומטי שמוצג מתחת — אחרת רואים את
                        // התוצאה הישנה ושומרים משהו אחר.
                        site={{ ...s, plc_type: draft.plcType || null, control_system: draft.controlSystem || null }}
                        value={draft.fixflowProfile}
                        onChange={(v) => setDraft({ ...draft, fixflowProfile: v })}
                      />
                      <p className="adm-warn">
                        ⚠ שינוי הקוד משנה את נתיב ה-MQTT. הסוכן באתר חייב להתעדכן גם הוא,
                        אחרת הודעותיו יידחו.
                      </p>
                    </div>
                  ) : (
                    <div className="adm-info">
                      <span className="adm-name">{s.site_name}</span>
                      <span className="adm-meta">
                        קוד: <b>{s.code}</b> · דרגה: <b>{TIER_LABELS[s.tier] || TIER_LABELS.basic}</b> · סוג: <b>{siteTypeFullLabel(s.plc_type)}</b> · {STATUS_LABELS[s.status] || s.status}
                      </span>
                    </div>
                  )}

                  <div className="adm-actions">
                    {isEditing ? (
                      <>
                        <button className="adm-btn" disabled={busy}
                          onClick={() => saveEdit(s.code)}>שמור</button>
                        <button className="adm-btn-ghost"
                          onClick={() => { setEditing(null); setErr(null); }}>ביטול</button>
                      </>
                    ) : confirmRotate === s.code ? (
                      <>
                        {/* ⚠️ אומרים מה **יקרה**, לא "האם את בטוחה" —
                            אותו כלל כמו בהחלפת בקר ובמחיקה. */}
                        <span className="adm-confirm-text">
                          הסיסמה הקודמת תתבטל מיד — אתר שמשתמש בה יפסיק לדווח
                          עד שתעדכני אותו
                        </span>
                        <button className="adm-btn" disabled={issuing === s.code}
                          onClick={() => issueAgent(s, true)}>
                          {issuing === s.code ? "מנפיק…" : "כן, הנפק סיסמה חדשה"}
                        </button>
                        <button className="adm-btn-ghost"
                          onClick={() => setConfirmRotate(null)}>ביטול</button>
                      </>
                    ) : confirmController === s.code ? (
                      <>
                        {/* ⚠️ הטקסט אומר מה **יקרה**, לא "האם את בטוחה".
                            "בטוחה?" הוא שאלה שאין עליה תשובה מושכלת. */}
                        <span className="adm-confirm-text">
                          הקריאה הבאה תיקלט כבסיס — המונה יישאר {(s.cycle_total ?? 0).toLocaleString()}
                        </span>
                        <button className="adm-btn" disabled={busy}
                          onClick={() => replaceController(s)}>
                          {busy ? "מסמן…" : "כן, הוחלף בקר"}
                        </button>
                        <button className="adm-btn-ghost"
                          onClick={() => setConfirmController(null)}>ביטול</button>
                      </>
                    ) : isConfirming ? (
                      <>
                        <span className="adm-confirm-text">למחוק לצמיתות?</span>
                        <button className="adm-btn-danger" disabled={busy}
                          onClick={() => handleDelete(s)}>
                          {busy ? "מוחק…" : "כן, מחק"}
                        </button>
                        <button className="adm-btn-ghost"
                          onClick={() => setConfirmDelete(null)}>ביטול</button>
                      </>
                    ) : (
                      <>
                        <button className="adm-btn-ghost" onClick={() => startEdit(s)}>ערוך</button>
                        {/* ⚠️ **הכפתור הזה הוא מסלול השחזור, לא נוחות.**
                            הזהות נוצרת אוטומטית בהרשמת האתר — אבל אם ההנפקה
                            נכשלה שם, האתר קיים ו**לא יוכל לדווח לעולם**. בלי
                            כפתור, הדרך היחידה חזרה היא פקודה על DELL008, וזה
                            בדיוק מה שהאוטומציה נועדה לבטל. */}
                        {/* ⚠️ אתר בלי זהות אינו מציג שום סימן היום — הוא פשוט
                            מפסיק לפעום, וזה נראה כמו אתר שקט. הסימון הוא
                            ההבדל בין "צריך לטפל" לבין "לא שמתי לב חודשיים". */}
                        <button
                          className={missingIdentity(s) ? "adm-btn-ghost adm-needs-identity" : "adm-btn-ghost"}
                          disabled={issuing === s.code}
                          title={missingIdentity(s)
                            ? "לאתר אין זהות סוכן — הוא אינו יכול לכתוב ישירות ל-Supabase"
                            : "הנפקת זהות סוכן לאתר"}
                          onClick={() => issueAgent(s)}>
                          {issuing === s.code ? "מנפיק…" : missingIdentity(s) ? "⚠ חסרה זהות סוכן" : "זהות סוכן"}
                        </button>
                        {/* ⚠️ נמדד: בקר חדש שמגיע עם 87 מחזורי בדיקות מפעל
                            מוסיף אותם כמחזורים אמיתיים, ו-cycle_total הוא
                            בלתי הפיך. אי אפשר להסיק — בקר שהתאפס במקום
                            ובקר שהוחלף נראים זהים מהמספר. */}
                        <button className="adm-btn-ghost"
                          onClick={() => { setConfirmController(s.code); setErr(null); }}>
                          הוחלף בקר
                        </button>
                        <button className="adm-btn-ghost adm-danger-text"
                          onClick={() => { setConfirmDelete(s.code); setErr(null); }}>
                          מחק
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <p className="adm-note">
          מחיקת אתר מוחקת גם את כל ההיסטוריה שלו — פעולות, שינויי מצב ותחזוקה. אין ביטול.
        </p>
        </>)}
      </div>

      {/* ⚠️ עטיפה שעוצרת את הבעבוע: המודאל יושב בתוך `adm-overlay`, ולחיצה
          על הרקע שלו — גם במסך הסיסמה — הגיעה ל-onClose של הפאנל כולו. */}
      {addOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <AddSiteModal
            onClose={() => setAddOpen(false)}
            onSuccess={() => { setAddOpen(false); onChanged(); flash("האתר נוסף"); }}
          />
        </div>
      )}
    </div>
  );
}

export default AdminPanel;
