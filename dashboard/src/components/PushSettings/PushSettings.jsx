// components/PushSettings — הפעלת התראות תקלה, ובחירת אתרים וסוגים.
//
// ⚠️ **הכפתור נפתח מהשדר ולא קופץ מעצמו.** לדפדפן יש הזדמנות אחת לבקש
// הרשאה: מי שילחץ "חסום" כי לא הבין — **לא נוכל לשאול אותו שוב לעולם**,
// רק הוא בהגדרות האתר. לכן ההסבר בא לפני הבקשה, תמיד.
import { useEffect, useState } from "react";
import {
  pushPermission, enablePush, disablePush,
  getPushSites, setPushSites,
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

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("sites").select("id, code, site_name").order("site_name");
      setSites(data || []);
      if (pushPermission() === "granted") {
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
    const { data: me } = await supabase.from("app_users").select("id").limit(1).maybeSingle();
    if (!me) return;
    await supabase.from("push_user_types").delete().eq("app_user_id", me.id);
    // 'fault' נשמר תמיד יחד עם השאר — ברירת המחדל "אין שורות" מכסה רק
    // את המקרה שבו איש לא בחר דבר.
    const rows = ["fault", ...next.filter((k) => k !== "fault")]
      .map((k) => ({ app_user_id: me.id, kind: k }));
    await supabase.from("push_user_types").insert(rows).catch((e) => setErr(e.message));
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

            {on && (
              <>
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
