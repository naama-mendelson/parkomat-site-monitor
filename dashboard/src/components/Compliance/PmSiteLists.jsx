// components/Compliance/PmSiteLists.jsx — פרופיל התחזוקה של האתר, והרשימות שהוא מביא (13/10/2026).
//
// בעלת המוצר: "כיון שיש תחזוקה שמתאימה להרבה אתרים אותו דבר — שנקשר את האתר לתחזוקה שמתאימה
// לו כמו ברמזור". שורה אחת: "פרופיל תחזוקה: X". מנהל — "שינוי", ובחירה מרשימת הפרופילים.
// מתחתיה, לקריאה בלבד, הרשימות שהאתר מקבל. את הפרופילים עצמם (שם, רשימות, אתרים) עורכים בלוח.
//
// ⚠️ אתר בלי פרופיל מקבל את רשימת ברירת המחדל (או שיוך ישן אתר-אתר מלפני הפרופילים), והשורה
// אומרת את זה — אחרת "משותף" נראה כמו בחירה שמישהו עשה.
// ⚠️ ביקור שכבר פתוח אינו משתנה: הפריטים שלו צולמו בפתיחה. השינוי חל מהביקור הבא.
// (עד 13/10/2026 כאן נבחרו רשימות לאתר בודד — pm_site_templates. נשאר במסד כגיבוי לאתר בלי פרופיל.)
import { useState } from "react";
import { fetchPmProfiles, setPmSiteProfile } from "../../services/dataSource";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";

const NONE = "";

export default function PmSiteLists({ code, profile = null, templates = [], assigned = false, isManager = false, onChanged }) {
  const [edit, setEdit] = useState(null);      // null | { profiles, chosen:string }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const open = async () => {
    setError("");
    setBusy(true);
    try {
      const { profiles } = await fetchPmProfiles();
      setEdit({ profiles, chosen: profile ? String(profile.id) : NONE });
    } catch (e) { setError(e?.message || "הפרופילים לא נטענו"); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setError("");
    setBusy(true);
    try {
      await setPmSiteProfile(code, edit.chosen === NONE ? null : Number(edit.chosen));
      setEdit(null);
      onChanged?.();
    } catch (e) { setError(e?.message || "השמירה נכשלה"); }
    finally { setBusy(false); }
  };

  const names = templates.map((t) => t.name).join(" · ") || "—";
  const options = edit
    ? [{ value: NONE, label: "בלי פרופיל (רשימת ברירת המחדל)" },
       ...edit.profiles.map((p) => ({ value: String(p.id), label: `${p.name} · ${p.item_count} פריטים` }))]
    : [];

  return (
    <section className="pm-card">
      <div className="pm-site-lists">
        <span>פרופיל תחזוקה:</span>
        <span className="pm-site-lists-names" data-testid="pm-profile-name">
          {profile ? profile.name : "בלי פרופיל"}
        </span>
        {isManager && !edit && (
          <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={open}>שינוי</button>
        )}
      </div>
      <div className="pm-site-lists pm-muted">
        <span>רשימות:</span>
        <span>{names}</span>
        {!profile && !assigned && <span>(ברירת מחדל)</span>}
      </div>
      {edit && (
        <div className="pm-site-lists-edit">
          {/* ⚠️ placeholder מפורש: ChoiceSelect לעולם אינו מציג אפשרות שערכה "" על הכפתור הסגור,
              ובלעדיו אתר בלי פרופיל נקרא "— לבחור —", כאילו חובה לבחור (כמו ב-LiftFields) */}
          <ChoiceSelect label="פרופיל תחזוקה" value={edit.chosen} options={options}
            placeholder="בלי פרופיל (רשימת ברירת המחדל)"
            onChange={(v) => setEdit((e) => ({ ...e, chosen: v }))} />
          {edit.profiles.length === 0 && (
            <p className="pm-muted">עוד אין פרופילים — יוצרים אותם ב"לוח פרופילי התחזוקה" שבכלי המנהל.</p>
          )}
          <p className="pm-muted">חל מהביקור הבא. ביקור שכבר פתוח ממשיך עם מה שהיה בפתיחתו.</p>
          <div className="pm-row">
            <button type="button" className="pm-btn pm-btn--primary" disabled={busy} onClick={save}>
              {busy ? "שומר…" : "שמירה"}</button>
            <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={() => setEdit(null)}>ביטול</button>
          </div>
        </div>
      )}
      {error && <div className="pm-banner pm-banner--error" role="alert">{error}</div>}
    </section>
  );
}
