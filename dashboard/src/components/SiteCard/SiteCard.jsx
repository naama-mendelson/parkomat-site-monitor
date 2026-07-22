// components/SiteCard/SiteCard.jsx — כרטיס אתר.
// לחיצה על הכרטיס *מרחיבה* אותו במקום — גדל, ברור יותר, עם פירוט מלא —
// ומתוכו אפשר לפתוח את פאנל הפירוט המלא.
import { STATUS_LABELS, STATUS_COLORS, TIER_LABELS, TIER_COLORS, DIRECTION_LABELS, DIRECTION_COLORS } from "../../utils/constants";
import { timeAgo } from "../../utils/helpers";
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

function SiteCard({ site, density = "normal", expanded, onToggle, onHover, onOpenDetail }) {
  const status = site.status;
  const colors = STATUS_COLORS[status] || STATUS_COLORS.no_comm;
  const label = STATUS_LABELS[status] || status;
  const isMini = density === "mini";
  const isNormal = density === "normal";

  const failureRate = site.failureRate ?? 0;

  // כשהאתר *בפעולה* — הפעולה הנוכחית: כניסה/יציאה + מספר הכרטיס שביצע אותה.
  const op = status === "operating" ? site.lastOperation : null;
  const opView = op && op.entry_exit ? (
    <div className="card-op">
      <span className="card-op-dir" style={{ color: DIRECTION_COLORS[op.entry_exit] }}>
        {op.entry_exit === "entry" ? "↓" : "↑"} {DIRECTION_LABELS[op.entry_exit] || op.entry_exit}
      </span>
      {op.card_number
        ? <span className="card-op-card">כרטיס {op.card_number}</span>
        : <span className="card-op-card card-op-card--none">ללא כרטיס</span>}
    </div>
  ) : null;

  const statusTag = (
    <span className="card-status" style={{ background: colors.bg, color: colors.text }}>
      <span className="status-dot" style={{ background: colors.dot }} />
      {label}
    </span>
  );

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
        className="site-card is-expanded"
        data-code={site.code}
        onMouseEnter={() => onHover?.(site.code)}
        style={{ borderInlineStartColor: colors.dot, "--c": colors.dot }}
      >
        <div className="exp-head">
          <div className="exp-title">
            <h3 className="exp-name">
              {site.site_name}
              <TierBadge tier={site.tier} />
            </h3>
            <span className="exp-code">קוד אתר: {site.code}</span>
          </div>
          <span className="exp-status" style={{ background: colors.bg, color: colors.text }}>
            <span className="status-dot" style={{ background: colors.dot }} />
            {label}
          </span>
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
      className={`site-card density-${density}`}
      data-code={site.code}
      style={{ borderInlineStartColor: colors.dot }}
      onClick={() => onToggle(site.code)}
      onMouseEnter={() => onHover?.(site.code)}
      title={isNormal ? "רחפו להרחבה · לחצו לנעילה" : `${site.site_name} — ${label}`}
    >
      <div className="card-header">
        <span className="card-name">
          <span className="card-name-text">{site.site_name}</span>
          {!isMini && <TierBadge tier={site.tier} />}
        </span>
        {!isMini && <span className="card-code">#{site.code}</span>}
      </div>

      {isMini ? (
        <span className="mini-dot" style={{ background: colors.dot }} title={label} />
      ) : (
        statusTag
      )}

      {!isMini && opView}

      {isNormal ? (
        details
      ) : (
        <div className="card-hover-panel">
          {isMini && statusTag}
          {details}
        </div>
      )}
    </div>
  );
}

export default SiteCard;
