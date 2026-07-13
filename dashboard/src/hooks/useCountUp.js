// hooks/useCountUp.js — אנימציית ספירה מ-0 ליעד (requestAnimationFrame, בלי ספריות)
import { useState, useEffect, useRef } from "react";

/**
 * מחזיר ערך שמטפס מ-0 אל target תוך duration מילישניות, עם האטה בסוף.
 * מכבד prefers-reduced-motion — מי שביקש פחות תנועה מקבל את הערך מיד.
 */
export function useCountUp(target, duration = 1500) {
  const [value, setValue] = useState(0);
  const frame = useRef(null);

  useEffect(() => {
    const goal = Number.isFinite(target) ? target : 0;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (reduced || duration <= 0) {
      setValue(goal);
      return;
    }

    let startTs = null;

    const step = (ts) => {
      if (startTs === null) startTs = ts;
      const p = Math.min((ts - startTs) / duration, 1);

      // easeOutExpo — זינוק מהיר והאטה רכה, מרגיש "יקר"
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      setValue(goal * eased);

      if (p < 1) frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [target, duration]);

  return value;
}
