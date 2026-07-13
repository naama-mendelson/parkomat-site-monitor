// components/SiteCard/SiteCard.jsx — כרטיס אתר בודד (3 רמות צפיפות, PRD 12.1)
import { STATUS_LABELS, STATUS_COLORS } from "../../utils/constants";
import "./SiteCard.css";

// צבע אחוז הכשל: 0% = ירוק, עד 5% = צהוב, מעל 5% = אדום
function failureRateColor(rate) {
  if (rate > 5) return "#ef4444";   // אדום
  if (rate > 0) return "#eab308";   // צהוב
  return "#22c55e";                 // ירוק
}

function SiteCard({ site, density = "normal", onClick }) {
  const status = site.status;
  const colors = STATUS_COLORS[status] || STATUS_COLORS.no_comm;
  const label = STATUS_LABELS[status] || status;
  const isMini = density === "mini";
  const isNormal = density === "normal";

  // פס צד צבעוני לפי מצב — אינדיקציה ויזואלית מהירה
  const cardStyle = { borderInlineStartColor: colors.dot };

  const statusTag = (
    <span className="card-status" style={{ background: colors.bg, color: colors.text }}>
      <span className="status-dot" style={{ background: colors.dot }} />
      {label}
    </span>
  );

  // שדות מהגדול לקטן (PRD 12.1): (2) פעולות; (3) אחוז כשל (עם צבע)
  const failureRate = site.failureRate ?? 0;
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

  return (
    <div
      className={`site-card density-${density}${site.is_vip ? " is-vip" : ""}`}
      style={cardStyle}
      onClick={() => onClick(site.code)}
      title={isNormal ? undefined : `${site.site_name} — ${label}`}
    >
      {/* כותרת: שם (+ סימון VIP) + קוד */}
      <div className="card-header">
        <span className="card-name">
          {site.is_vip && <span className="vip-badge" title="אתר VIP">★</span>}
          {site.site_name}
        </span>
        {!isMini && <span className="card-code">#{site.code}</span>}
      </div>

      {/* mini: רק נקודת מצב; אחרת: תג מצב מלא */}
      {isMini ? (
        <span className="mini-dot" style={{ background: colors.dot }} title={label} />
      ) : (
        statusTag
      )}

      {/* normal: פרטים גלויים תמיד. compact/mini: נחשפים ב-hover (popover) */}
      {isNormal ? (
        details
      ) : (
        <div className="card-hover-panel">
          {/* ב-mini אין תג מצב גלוי — מציגים אותו בתוך ה-popover */}
          {isMini && statusTag}
          {details}
        </div>
      )}
    </div>
  );
}

export default SiteCard;
