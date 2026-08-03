// components/SiteCard/SiteCard.jsx — כרטיס אתר.
// לחיצה על הכרטיס *מרחיבה* אותו במקום — גדל, ברור יותר, עם פירוט מלא —
// ומתוכו אפשר לפתוח את פאנל הפירוט המלא.
import { STATUS_LABELS, STATUS_COLORS, STUCK_COLOR, TIER_LABELS, TIER_COLORS, DIRECTION_LABELS, DIRECTION_COLORS } from "../../utils/constants";
import { timeAgo } from "../../utils/helpers";
import { stuckInfo } from "../../utils/stuck";
import "./SiteCard.css";

// צבע אחוז הכשל: 0% = ירוק, עד 5% = צהוב, מעל 5% = אדום
function failureRateColor(rate) {
  if (rate > 5) return STATUS_COLORS.error.dot;         // אדום
  if (rate > 0) return STATUS_COLORS.maintenance.dot;   // ענבר
  return STATUS_COLORS.ready.dot;                       // ירוק
}

// תג דרגת האתר (VIP / מורחב / בסיסי) — מוצג ליד שם האתר.
function TierBadge({ tier }) {
  const t = tier || "basic";
  const c = TIER_COLORS[t] || TIER_COLORS.basic;
  return (
    <span
      className="tier-badge"
      style={{ background: c.bg, color: c.text, borderColor: c.border }}
      title={`דרגה: ${TIER_LABELS[t]}`}
    >
      {TIER_LABELS[t]}
    </span>
  );
}

function SiteCard({ site, density = "normal", expanded, onToggle, onHover, onOpenDetail, style }) {
  const status = site.status;
  const colors = STATUS_COLORS[status] || STATUS_COLORS.no_comm;
  const label = STATUS_LABELS[status] || status;
  const isMini = density === "mini";
  const isNormal = density === "normal";

  const failureRate = site.failureRate ?? 0;

  // ==========================================================
  // כשהאתר "בפעולה" — מה בדיוק קורה בו
  // ==========================================================
  // הכיוון והכרטיס מוצגים **רק אם הפעולה באמת פתוחה** (start_end === "start").
  // lastOperation הוא הפעולה האחרונה שנרשמה, לאו דווקא הנוכחית: אתר יכול להיות
  // "בפעולה" בזמן שהפעולה האחרונה שלו הסתיימה לפני שעה, ואז הצגת הכיוון והכרטיס
  // שלה כ"עכשיו" היא פשוט שקר. (נצפה בשטח: אתר במצב בפעולה שהציג כניסה+כרטיס
  // מפעולה שהסתיימה שעה קודם.)
  //
  // ואם אין פעולה פתוחה — אומרים זאת במפורש במקום להשאיר את הכרטיס שותק. זה
  // המצב של אתר שהסוכן עלה בו כשה-MODE כבר היה בכניסה/יציאה: המוח משדר פעולה
  // רק על *שינוי* MODE, ולכן שום פעולה לא נרשמה. שתיקה שם נראית כמו נתון חסר;
  // אמירה מפורשת היא רמז אבחוני (MODE תקוע / כתובת רגיסטר שגויה).
  const op = status === "operating" ? site.lastOperation : null;
  const openOp = op && op.start_end === "start" && op.entry_exit ? op : null;

  const opView = status === "operating" ? (
    <div className="card-op">
      {openOp ? (
        <>
          <span className="card-op-dir" style={{ color: DIRECTION_COLORS[openOp.entry_exit] }}>
            {openOp.entry_exit === "entry" ? "↓" : "↑"} {DIRECTION_LABELS[openOp.entry_exit] || openOp.entry_exit}
          </span>
          {openOp.card_number
            ? <span className="card-op-card">כרטיס {openOp.card_number}</span>
            : <span className="card-op-card card-op-card--none">ללא כרטיס</span>}
        </>
      ) : (
        <span
          className="card-op-card card-op-card--none"
          title="הבקר מדווח 'בפעולה', אך לא הגיעה פעולה עם כיוון וכרטיס. מסוכן בגרסה ישנה שעלה באמצע פעולה, או מ-MODE תקוע בבקר."
        >
          לא דווחה פעולה
        </span>
      )}
    </div>
  ) : null;

  const statusTag = (
    <span className="card-status" style={{ background: colors.bg, color: colors.text }}>
      <span className="status-dot" style={{ background: colors.dot }} />
      {label}
    </span>
  );

  // ==========================================================
  // "ייתכן תקוע" — תצוגה בלבד, אפס נגיעה בחשבון
  // ==========================================================
  // שער לא יכול להיות "בפעולה" שעות. עד עכשיו אתר כזה נראה תקין לגמרי בכרטיס,
  // ואפילו קיבל 100% זמינות (מצב 'בפעולה' נספר כזמן תקין). התג הזה אומר
  // "המספר לא סביר" — הוא **אינו** משנה אף מדד. ראה utils/stuck.js.
  //
  // אתר שקט במצב 'מוכן' אינו מסומן, בכוונה: מנוחה היא מצב תקין, וחניון יכול
  // לא לדווח ימים.
  const stuck = stuckInfo(site);

  const stuckBadge = stuck ? (
    <span
      className="card-stuck"
      style={{ background: STUCK_COLOR.bg, color: STUCK_COLOR.text, borderColor: STUCK_COLOR.border }}
      title={stuck.title}
    >
      <span className="card-stuck-icon" aria-hidden="true">⚠</span>
      {stuck.text}
    </span>
  ) : null;

  const details = (
    <div className="card-details">
      <div className="card-detail">
        <span className="detail-label">פעולות</span>
        <span className="detail-value">{(site.operations ?? 0).toLocaleString()}</span>
      </div>
      <div className="card-detail">
        <span className="detail-label">אחוז כשל (שבועי)</span>
        <span className="detail-value" style={{ color: failureRateColor(failureRate) }}>
          {failureRate}%
        </span>
      </div>
    </div>
  );

  // ===== מורחב: גדול, ברור, עם כל המידע =====
  if (expanded) {
    return (
      <div
        className={`site-card is-expanded${stuck ? " is-stuck" : ""}`}
        data-code={site.code}
        onMouseEnter={() => onHover?.(site.code)}
        // style מגיע מ-SiteGrid ומכיל מיקום מפורש כשהכרטיס בעמודה האחרונה
        // (ראה placementFor שם). מפוזר אחרון כדי שיוכל להוסיף, ולא לדרוס צבע.
        style={{ borderInlineStartColor: colors.dot, "--c": colors.dot, ...style }}
      >
        <div className="exp-head">
          <div className="exp-title">
            <h3 className="exp-name">
              {site.site_name}
              <TierBadge tier={site.tier} />
            </h3>
            <span className="exp-code">קוד אתר: {site.code}</span>
          </div>
          <div className="exp-status-wrap">
            <span className="exp-status" style={{ background: colors.bg, color: colors.text }}>
              <span className="status-dot" style={{ background: colors.dot }} />
              {label}
            </span>
            {stuckBadge}
          </div>
        </div>

        {opView}

        <div className="exp-metrics">
          <div className="exp-metric">
            <span className="exp-value">{(site.operations ?? 0).toLocaleString()}</span>
            <span className="exp-label">פעולות</span>
            <span className="exp-hint">בשבוע האחרון</span>
          </div>

          <div className="exp-metric">
            <span className="exp-value" style={{ color: failureRateColor(failureRate) }}>
              {failureRate}%
            </span>
            <span className="exp-label">אחוז כשל</span>
            <span className="exp-hint">
              {(site.errors ?? 0) === 0 ? "לא נרשמו תקלות" : `${site.errors} תקלות`}
            </span>
          </div>

          <div className="exp-metric">
            <span className="exp-value">
              {site.plc_cycle_last != null ? site.plc_cycle_last.toLocaleString() : "—"}
            </span>
            <span className="exp-label">מונה מחזורים</span>
            <span className="exp-hint">המונה המצטבר של המכונה</span>
          </div>

          <div className="exp-metric">
            <span className="exp-value exp-value--sm">
              {(site.statusSince || site.last_seen)
                ? timeAgo(site.statusSince || site.last_seen)
                : "טרם דיווח"}
            </span>
            <span className="exp-label">המצב השתנה ל{label}</span>
          </div>
        </div>

        <button className="exp-open" onClick={() => onOpenDetail(site.code)}>
          פתח פירוט מלא ←
        </button>

        <span className="exp-hint-close">לחצו מחוץ לכרטיס כדי לכווץ</span>
      </div>
    );
  }

  // ===== רגיל =====
  return (
    <div
      className={`site-card density-${density}${stuck ? " is-stuck" : ""}`}
      data-code={site.code}
      style={{ borderInlineStartColor: colors.dot }}
      onClick={() => onToggle(site.code)}
      onMouseEnter={() => onHover?.(site.code)}
      // בצפיפות mini אין מקום לתג, ולכן ההסבר עובר ל-title — שם הוא כל מה שיש.
      title={stuck ? stuck.title
        : isNormal ? "רחפו להרחבה · לחצו לנעילה"
        : `${site.site_name} — ${label}`}
    >
      <div className="card-header">
        <span className="card-name">
          <span className="card-name-text">{site.site_name}</span>
          {!isMini && <TierBadge tier={site.tier} />}
        </span>
        {!isMini && <span className="card-code">#{site.code}</span>}
      </div>

      {isMini ? (
        // ב-mini הכרטיס הוא שם + נקודה. הנקודה שומרת על צבע המצב (אחרת המקרא
        // נשבר) ומקבלת טבעת סגולה — סימן שנראה בלי לקרוא, גם ברשת של 50 אתרים.
        <span
          className={`mini-dot${stuck ? " mini-dot--stuck" : ""}`}
          style={{ background: colors.dot, "--stuck": STUCK_COLOR.dot }}
          title={stuck ? stuck.text : label}
        />
      ) : (
        statusTag
      )}

      {!isMini && stuckBadge}

      {!isMini && opView}

      {isNormal ? (
        details
      ) : (
        <div className="card-hover-panel">
          {isMini && statusTag}
          {isMini && stuckBadge}
          {details}
        </div>
      )}
    </div>
  );
}

export default SiteCard;
