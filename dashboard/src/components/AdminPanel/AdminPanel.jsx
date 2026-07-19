// components/AdminPanel/AdminPanel.jsx — ניהול אתרים: הוספה, עריכה, מחיקה, שינוי קוד.
// זמין רק למנהל בקרה ומנהל כללי, ומאחורי קוד מנהל שהשרת אוכף.
import { useState } from "react";
import { STATUS_COLORS, STATUS_LABELS, TIER_OPTIONS, TIER_LABELS } from "../../utils/constants";
import { updateSite, deleteSite, changeAdminCode, storeAdminCode } from "../../services/api";
import { useAdmin } from "../../hooks/useAdmin";
import AddSiteModal from "../AddSiteModal/AddSiteModal";
import "./AdminPanel.css";
import Logo from "../Logo/Logo";

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function AdminPanel({ sites, onClose, onChanged }) {
  const { unlocked, unlock, lock, checking, error: unlockError } = useAdmin();

  const [code, setCode] = useState("");
  const [editing, setEditing] = useState(null);       // קוד האתר שנערך
  const [draft, setDraft] = useState({ name: "", code: "" });
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
    setDraft({ name: site.site_name, code: site.code, tier: site.tier || "basic" });
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
      await updateSite(originalCode, { site_name: name, code: newCode, tier: draft.tier });
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

  // ===== מסך נעילה =====
  if (!unlocked) {
    return (
      <div className="adm-overlay" onClick={onClose}>
        <div className="adm-lock" onClick={(e) => e.stopPropagation()}>
          <div className="adm-lock-icon"><Logo size={40} /></div>
          <h2>ניהול אתרים</h2>
          <p>הזן את קוד המנהל כדי להוסיף, לערוך או למחוק אתרים.</p>

          <form onSubmit={handleUnlock}>
            <input
              type="password"
              placeholder="קוד מנהל"
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
            <button className="adm-btn-ghost" onClick={() => setPwOpen((o) => !o)}>
              שנה קוד מנהל
            </button>
            <button className="adm-btn-ghost" onClick={() => { lock(); onClose(); }}>נעל</button>
            <button className="adm-close" onClick={onClose} aria-label="סגירה">✕</button>
          </div>
        </header>

        {msg && <div className="adm-msg">{msg}</div>}
        {err && <div className="adm-err adm-err-bar">{err}</div>}

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

        {/* רשימת האתרים */}
        <div className="adm-list">
          {sites.length === 0 ? (
            <p className="adm-empty">אין אתרים רשומים. התחל בהוספת אתר.</p>
          ) : (
            sites.map((s) => {
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
                      <p className="adm-warn">
                        ⚠ שינוי הקוד משנה את נתיב ה-MQTT. הסוכן באתר חייב להתעדכן גם הוא,
                        אחרת הודעותיו יידחו.
                      </p>
                    </div>
                  ) : (
                    <div className="adm-info">
                      <span className="adm-name">{s.site_name}</span>
                      <span className="adm-meta">
                        קוד: <b>{s.code}</b> · דרגה: <b>{TIER_LABELS[s.tier] || TIER_LABELS.basic}</b> · {STATUS_LABELS[s.status] || s.status}
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
      </div>

      {addOpen && (
        <AddSiteModal
          onClose={() => setAddOpen(false)}
          onSuccess={() => { setAddOpen(false); onChanged(); flash("האתר נוסף"); }}
        />
      )}
    </div>
  );
}

export default AdminPanel;
