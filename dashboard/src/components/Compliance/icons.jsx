// components/Compliance/icons.jsx — האייקונים של שני התחומים.
//
// ⚠️ אותם אייקונים בלשונית ובמנורה, ובכוונה: מי שרואה מפתח ברג על הכרטיס
// ולוחץ, מגיע ללשונית שעליה אותו מפתח ברג. אות ("ב"/"ת") נשקלה ונפסלה —
// "ת" הייתה נקראת "תקלה" ו"ב" — "בתחזוקה", שתי המילים של תגית המצב.
const stroke = {
  fill: "none", stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "round", strokeLinejoin: "round",
};

export function ClipboardCheckIcon({ size = 12, className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="4" y="3.5" width="12" height="14" rx="2" {...stroke} />
      <rect x="7.2" y="2" width="5.6" height="3.2" rx="1" {...stroke} />
      <polyline points="7.3,11.2 9.3,13.2 12.9,9.2" {...stroke} />
    </svg>
  );
}

export function WrenchIcon({ size = 12, className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
        {...stroke}
        strokeWidth={2.2}
      />
    </svg>
  );
}

export function AreaIcon({ area, size, className }) {
  return area === "pm" ? <WrenchIcon size={size} className={className} /> : <ClipboardCheckIcon size={size} className={className} />;
}
