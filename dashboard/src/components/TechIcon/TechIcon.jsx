// components/TechIcon/TechIcon.jsx — איקון "טכנאי באתר" (21/10/2026, הבעלת: "תשים איקון טכנאי באתר"): דמות בקסדת עבודה.
// ⚠️ SVG ולא אמוג'י — 🧑‍🔧 מצויר אחרת בכל מערכת, ובווינדוס ישן מתפרק לשני סימנים. הצבע — של הטקסט שלידו (currentColor).
// משותף לכרטיס הטכנאי (TechCards) ולכרטיס האתר בלוח (SiteCard), כדי שהסמל יהיה אותו סמל בשני המקומות.
export default function TechIcon({ size = 18, className = "" }) {
  return (
    <svg className={`tech-ico${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" width={size} height={size}
      aria-hidden="true" focusable="false">
      <path d="M6.5 10.6a5.5 5.5 0 0 1 11 0z" fill="currentColor" />
      <rect x="11" y="4.1" width="2" height="2.6" rx="0.6" fill="currentColor" />
      <rect x="4.6" y="10.2" width="14.8" height="1.9" rx="0.95" fill="currentColor" />
      <path d="M8.7 12.9a3.3 3.3 0 0 0 6.6 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.8 21.4c0-3.2 3.3-5.1 7.2-5.1s7.2 1.9 7.2 5.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
