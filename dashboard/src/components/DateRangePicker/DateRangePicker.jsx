// components/DateRangePicker/DateRangePicker.jsx — בחירת טווח: select קומפקטי,
// ושדות "מ–עד" שנפתחים רק כשבוחרים טווח מותאם.
import "./DateRangePicker.css";

const iso = (d) => {
  // YYYY-MM-DD בשעון *מקומי* — toISOString היה מזיז יום אחורה באזור זמן חיובי
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// כל אפשרות מחזירה או { period } (שהשרת כבר מכיר) או { from, to }
function rangeOf(key) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  switch (key) {
    case "today":    return { from: iso(new Date(y, m, d)), to: iso(now) };
    case "week":     return { period: "week" };
    case "month":    return { period: "month" };
    case "quarter":  return { from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: iso(now) };
    case "year":     return { period: "year" };
    case "lastYear": return { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) };
    default:         return { period: "month" };
  }
}

const OPTIONS = [
  { key: "today", label: "היום" },
  { key: "week", label: "7 הימים האחרונים" },
  { key: "month", label: "החודש הנוכחי" },
  { key: "quarter", label: "הרבעון הנוכחי" },
  { key: "year", label: "השנה הנוכחית" },
  { key: "lastYear", label: "שנה שעברה" },
  { key: "custom", label: "טווח מותאם…" },
];

function DateRangePicker({ value, onChange, summary, days }) {
  const isCustom = value.preset === "custom";
  const today = iso(new Date());

  function pick(key) {
    if (key === "custom") {
      // פותחים בטווח של החודש האחרון, כדי שלא יהיה ריק
      const now = new Date();
      const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      onChange({
        preset: "custom",
        from: value.from || iso(monthAgo),
        to: value.to || today,
      });
      return;
    }
    // ==========================================================
    // הסדר כאן קריטי — וכאן היה הבאג
    // ==========================================================
    // קודם היה כתוב:  onChange({ preset: key, ...rangeOf(key), from: "", to: "" })
    // כלומר rangeOf החזיר את הטווח, ומיד אחר כך `from: ""` ו-`to: ""` **דרסו אותו**.
    // מה שנשאר היה preset בלבד, בלי טווח ובלי period — והצרכן נפל ל-|| "month".
    //
    // התוצאה: "היום", "הרבעון הנוכחי" ו"שנה שעברה" — שלוש האפשרויות היחידות
    // שמחזירות from/to ולא period — כולן הציגו בשקט את **החודש הנוכחי**.
    // הבורר הראה "היום" והנתונים היו של יולי. שום שגיאה, רק מספרים לא נכונים.
    //
    // עכשיו כל שדה נקבע במפורש, ואין דריסה: מי שמחזיר period מנקה את from/to,
    // ומי שמחזיר from/to מנקה את period.
    const r = rangeOf(key);
    onChange({
      preset: key,
      period: r.period,          // undefined כשיש טווח מפורש
      from: r.from || "",
      to: r.to || "",
    });
  }

  function setDate(field, val) {
    const next = { preset: "custom", from: value.from || today, to: value.to || today, [field]: val };
    // ולידציה: from לא יכול להיות אחרי to
    if (next.from > next.to) {
      if (field === "from") next.to = next.from;
      else next.from = next.to;
    }
    onChange(next);
  }

  return (
    <div className="drp">
      <label className="drp-field">
        <span>טווח</span>
        <select value={value.preset || "month"} onChange={(e) => pick(e.target.value)}>
          {OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
      </label>

      {isCustom && (
        <>
          <label className="drp-field">
            <span>מ־</span>
            <input type="date" max={today} value={value.from || ""}
              onChange={(e) => setDate("from", e.target.value)} />
          </label>
          <label className="drp-field">
            <span>עד</span>
            <input type="date" max={today} value={value.to || ""}
              onChange={(e) => setDate("to", e.target.value)} />
          </label>
        </>
      )}

      {summary && (
        <span className="drp-summary">
          {summary}{days ? ` · ${days} ימים` : ""}
        </span>
      )}
    </div>
  );
}

export default DateRangePicker;
