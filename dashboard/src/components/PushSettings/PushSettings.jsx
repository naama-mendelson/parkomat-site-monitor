// components/PushSettings — הפעלת התראות תקלה, ובחירת אתרים וסוגים.
//
// ⚠️ **הכפתור נפתח מהשדר ולא קופץ מעצמו.** לדפדפן יש הזדמנות אחת לבקש
// הרשאה: מי שילחץ "חסום" כי לא הבין — **לא נוכל לשאול אותו שוב לעולם**,
// רק הוא בהגדרות האתר. לכן ההסבר בא לפני הבקשה, תמיד.
import { useEffect, useState } from "react";
import {
  pushPermission, enablePush, disablePush,
  getPushSites, setPushSites, ensurePushSubscription, pushCoverage,
} from "../../services/pushDirect";
import { supabase } from "../../services/supabase";
import "./PushSettings.css";

// ⚠️ הסדר אינו אקראי — הוא סדר הרעש. ראה ההערה על no_comm למטה.
const KINDS = [
  { key: "fault", label: "תקלה", hint: "אתר נכנס למצב תקלה", always: true },
  { key: "maintenance", label: "תחזוקה", hint: "מישהו פתח חלון תחזוקה" },
  {
    key: "no_comm", label: "ניתוק תקשורת",
    // ⚠️ המספר הזה אינו קישוט. נמדד בפרויקט: אתר 2439 מנותק כרבע מהזמן.
    // מי שידליק את זה בלי לדעת יקבל עשרות התראות ביום ויכבה הכול — כולל
    // את התקלות. תיבת סימון בלי האזהרה היא מלכודת.
    hint: "⚠️ רועש — אתרים מסוימים מתנתקים עשרות פעמים ביום",
  },
];

function PushSettings({ onClose }) {
  const [perm, setPerm] = useState(pushPermission());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sites, setSites] = useState([]);
  const [chosen, setChosen] = useState([]);
  const [kinds, setKinds] = useState([]);
  const [cover, setCover] = useState(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("sites").select("id, code, site_name").order("site_name");
      setSites(data || []);
      if (pushPermission() === "granted") {
        // ⚠️ חידוש שקט לפני הצגת המצב: אחרת המסך היה מציג "לא מכוסה" על
        // מנוי שהיה מתחדש שנייה אחר כך מעצמו.
        await ensurePushSubscription().catch(() => {});
        setCover(await pushCoverage().catch(() => null));
        setChosen(await getPushSites().catch(() => []));
        const { data: t } = await supabase.from("push_user_types").select("kind");
        setKinds((t || []).map((r) => r.kind));
      }
    })();
  }, []);

  async function enable() {
    setBusy(true); setErr("");
    try { setPerm(await enablePush()); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setErr("");
    try { await disablePush(); setPerm(Notification.permission); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function toggleSite(id) {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    setChosen(next);
    await setPushSites(next).catch((e) => setErr(e.message));
  }

  // ⚠️ 'תקלה' אינה ניתנת לכיבוי: כיבוי כל הסוגים היה משאיר מנוי חי שאינו
  // מקבל דבר — מצב שנראה כמו תקלה ואינו. מי שאינו רוצה כלום מבטל את המנוי.
  async function toggleKind(key) {
    if (key === "fault") return;
    const next = kinds.includes(key) ? kinds.filter((x) => x !== key) : [...kinds, key];
    setKinds(next);
    // ⚠️ אותה טעות שהייתה ב-pushDirect: select().limit(1) על app_users
    // מחזיר את השורה הראשונה בטבלה ולא את המשתמש הנוכחי.
    const { data: myId } = await supabase.rpc("my_app_user_id");
    if (!myId) return;
    await supabase.from("push_user_types").delete().eq("app_user_id", myId);
    // 'fault' נשמר תמיד יחד עם השאר — ברירת המחדל "אין שורות" מכסה רק
    // את המקרה שבו איש לא בחר דבר.
    const rows = ["fault", ...next.filter((k) => k !== "fault")]
      .map((k) => ({ app_user_id: myId, kind: k }));
    await supabase.from("push_user_types").insert(rows).catch((e) => setErr(e.message));
  }

  // ⚠️ שומר את הסירוב **ואז** סוגר. הסדר ההפוך היה מאבד אותו אם הסגירה
  // מפרקת את הרכיב לפני שהכתיבה הסתיימה.
  function decline() {
    try { localStorage.setItem("push-declined", "1"); } catch { /* מצב פרטי */ }
    onClose();
  }

  const on = perm === "granted";

  return (
    <div className="pushset-back" onClick={onClose}>
      <div className="pushset" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="pushset-head">
          <h3>התראות תקלה</h3>
          <button className="pushset-close" onClick={onClose} aria-label="סגירה">✕</button>
        </div>

        {perm === "unsupported" && (
          <p className="pushset-note">
            הדפדפן הזה אינו תומך בהתראות.
            {/* ⚠️ אייפון: ההרשאה זמינה **רק** באפליקציה מותקנת, מ-iOS 16.4.
                בלי המשפט הזה משתמש אייפון רואה "לא נתמך" ומסיק שזה שבור. */}
            <br />באייפון — יש להוסיף את האתר למסך הבית ולפתוח משם.
          </p>
        )}

        {perm === "denied" && (
          // ⚠️ 'denied' אינו 'default'. מכאן **אי אפשר** לבקש שוב — רק
          // המשתמשת, בהגדרות הדפדפן. כפתור כאן היה מבטיח מה שלא יקרה.
          <p className="pushset-note pushset-blocked">
            ההתראות חסומות בדפדפן. לא ניתן לבקש שוב מכאן —
            יש לפתוח את הגדרות האתר בדפדפן ולאפשר התראות.
          </p>
        )}

        {perm === "not-installed" && (
          // ⚠️ מסך ההסבר, לא שגיאה: זה המצב **הרגיל** במחשב, וגם באייפון
          // לפני התקנה. ניסוח של תקלה כאן היה שולח מישהו לחפש באג.
          <p className="pushset-note">
            ההתראות פועלות <strong>רק באפליקציה המותקנת</strong>, לא בלשונית דפדפן.
            <br /><br />
            <strong>אייפון:</strong> שיתוף ⬆️ → "הוסף למסך הבית", ולפתוח משם.
            <br />
            <strong>אנדרואיד:</strong> תפריט ⋮ → "התקן אפליקציה".
          </p>
        )}

        {perm === "unconfigured" && (
          <p className="pushset-note">מפתח ההתראות אינו מוגדר בבנייה.</p>
        )}

        {(perm === "default" || perm === "granted") && (
          <>
            <p className="pushset-note">
              התראה בטלפון כשאתר נכנס לתקלה — <strong>גם כשהאפליקציה סגורה</strong>.
              כתוב בה איזה אתר ומה התקלה, ולחיצה פותחת את הכרטיס.
            </p>

            <button className={`pushset-main ${on ? "is-on" : ""}`}
                    onClick={on ? disable : enable} disabled={busy}>
              {busy ? "רגע…" : on ? "כבה התראות במכשיר הזה" : "הפעל התראות"}
            </button>

            {/* ⚠️ **סירוב מפורש, ולא סגירה.** בלי הכפתור הזה אין דרך לומר
                "לא" — וסגירת החלון אינה החלטה, ולכן ההזמנה תחזור בפתיחה
                הבאה. מי שלא רוצה חייב מקום לומר זאת פעם אחת. */}
            {!on && (
              <button className="pushset-decline" onClick={decline} disabled={busy}>
                לא, תודה — אל תשאלו שוב
              </button>
            )}

            {on && (
              <>
                {/* ⚠️ מצב הכיסוי — כדי שאובדן לא יישאר שקט.
                    iOS מוחק PWA שלא נפתח כשבועיים, כולל ההרשמה. מי שנגרע
                    לא מקבל התראות ו**לא יודע** — הוא מניח שאין תקלות. */}
                {cover && (
                  <p className={`pushset-hint${cover.stale ? " pushset-stale" : ""}`}>
                    {cover.stale > 0
                      ? `⚠️ ${cover.stale} מתוך ${cover.devices.length} מכשירים לא אומתו מעל שבוע — ייתכן שאינם מקבלים התראות. פתיחת האפליקציה במכשיר מחדשת אותו.`
                      : `מכוסה · ${cover.devices.length} ${cover.devices.length === 1 ? "מכשיר" : "מכשירים"} · אומת עכשיו`}
                  </p>
                )}

                <h4 className="pushset-sub">על מה להתריע</h4>
                {KINDS.map((k) => (
                  <label key={k.key} className={`pushset-row ${k.always ? "is-locked" : ""}`}>
                    <input type="checkbox"
                           checked={k.always || kinds.includes(k.key)}
                           disabled={k.always}
                           onChange={() => toggleKind(k.key)} />
                    <span>
                      <strong>{k.label}</strong>
                      <em>{k.hint}</em>
                    </span>
                  </label>
                ))}

                <h4 className="pushset-sub">על אילו אתרים</h4>
                {/* ⚠️ המשפט הזה חייב להיות כאן: ריק = **הכל**, לא "אף אחד".
                    בלעדיו מי שמנקה את הבחירה חושב שהשתיק את עצמו וקיבל את ההפך. */}
                <p className="pushset-hint">
                  {chosen.length === 0
                    ? "לא נבחר דבר — יגיעו התראות מכל האתרים."
                    : `נבחרו ${chosen.length} אתרים. ניקוי הבחירה מחזיר להכל.`}
                </p>
                <div className="pushset-sites">
                  {sites.map((s) => (
                    <label key={s.id} className="pushset-site">
                      <input type="checkbox" checked={chosen.includes(s.id)}
                             onChange={() => toggleSite(s.id)} />
                      <span>{s.site_name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {err && <p className="pushset-err">{err}</p>}
      </div>
    </div>
  );
}

export default PushSettings;
