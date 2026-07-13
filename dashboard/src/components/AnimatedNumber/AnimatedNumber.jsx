// components/AnimatedNumber/AnimatedNumber.jsx — מספר שמטפס ליעד
import { useCountUp } from "../../hooks/useCountUp";
import "./AnimatedNumber.css";

/**
 * value    — היעד
 * decimals — כמה ספרות אחרי הנקודה
 * suffix   — מה שמופיע אחרי המספר ("%", "ש'")
 * duration — משך האנימציה
 */
function AnimatedNumber({ value, decimals = 0, suffix = "", prefix = "", duration = 1500 }) {
  const current = useCountUp(value, duration);

  const text = current.toLocaleString("he-IL", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span className="anum">
      {prefix}
      <span className="anum-value">{text}</span>
      {suffix && <span className="anum-suffix">{suffix}</span>}
    </span>
  );
}

export default AnimatedNumber;
