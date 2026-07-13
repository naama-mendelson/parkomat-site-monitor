// components/Logo/Logo.jsx — הלוגו של פרקומט, במקום אחד.
// הריבוע הלבן מאחוריו הוא חלק מהעניין: הכחול העמוק של הלוגו (0e4194)
// כמעט נבלע ברקע הכהה של הממשק, ועל לבן הוא נקרא בכל ערכת נושא.
import "./Logo.css";

function Logo({ size = 24, variant = "", title }) {
  return (
    <img
      src="/parkomat-logo.png"
      className={`lg ${variant ? `lg--${variant}` : ""}`}
      style={{ width: size, height: size }}
      alt={title ? "Parkomat" : ""}
      aria-hidden={title ? undefined : "true"}
    />
  );
}

export default Logo;
