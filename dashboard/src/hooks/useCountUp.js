// hooks/useCountUp.js — אנימציית ספירה אל היעד (requestAnimationFrame, בלי ספריות)
import { useState, useEffect, useRef } from "react";

/**
 * מחזיר ערך שמטפס אל target תוך duration מילישניות, עם האטה בסוף.
 * מתחיל מהערך המוצג הקודם ולא מ-0: בעדכון חי (SSE) שמשנה את היעד, המספר
 * ממשיך מהמקום שבו היה במקום "לקפוץ" ל-0 ולספור מחדש (שנראה כמו תקלת נתונים).
 * מכבד prefers-reduced-motion — מי שביקש פחות תנועה מקבל את הערך מיד.
 */
export function useCountUp(target, duration = 1500) {
  const [value, setValue] = useState(0);
  const frame = useRef(null);
  const fromRef = useRef(0); // הערך שממנו מתחילים — הערך המוצג האחרון

  useEffect(() => {
    const goal = Number.isFinite(target) ? target : 0;
    const from = fromRef.current;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (reduced || duration <= 0) {
      fromRef.current = goal;
      setValue(goal);
      return;
    }

    let startTs = null;

    const step = (ts) => {
      if (startTs === null) startTs = ts;
      const p = Math.min((ts - startTs) / duration, 1);

      // easeOutExpo — זינוק מהיר והאטה רכה, מרגיש "יקר"
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const current = from + (goal - from) * eased;
      setValue(current);
      // שומרים את הערך הנוכחי כך שאם היעד ישתנה באמצע — נמשיך מכאן ולא מ-0.
      fromRef.current = current;

      if (p < 1) {
        frame.current = requestAnimationFrame(step);
      } else {
        fromRef.current = goal;
      }
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [target, duration]);

  return value;
}
