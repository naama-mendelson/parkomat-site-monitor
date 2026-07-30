// hooks/useAlertAudio.js — חיבור מצב ההתראות הקוליות ל-React.
//
// המנוע (utils/audio/alerts.js) חי מחוץ ל-React בכוונה: הוא צריך לשרוד
// re-render, להחזיק AudioContext יחיד, ולהמשיך לרוץ גם כשאף קומפוננטה לא
// מוצגת. useSyncExternalStore הוא בדיוק הגשר לזה.
//
// getAlertState מחזיר **מחרוזת**, ולא אובייקט. אילו החזיר אובייקט חדש בכל
// קריאה, React היה רואה ערך חדש בכל בדיקה ונכנס ללולאת render אינסופית.

import { useSyncExternalStore, useEffect, useCallback } from "react";
import {
  subscribe,
  getAlertState,
  toggleMute,
  unlockAudio,
  startAudioWatchdog,
} from "../utils/audio/alerts";

export function useAlertAudio() {
  const state = useSyncExternalStore(subscribe, getAlertState, () => "locked");

  // ===== שחרור האודיו =====
  // *לא* { once }: הדפדפן משעה מחדש את ה-AudioContext כשהטאב יורד לרקע, ולכן
  // צריך לנסות שוב בכל מחווה ובכל חזרה לחזית — לא פעם אחת בטעינה.
  useEffect(() => {
    const onGesture = () => unlockAudio(true);
    const onVisible = () => unlockAudio(false);

    unlockAudio(false);   // אולי כבר מותר (ניווט פנימי, הרשאה קיימת לאתר)

    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    document.addEventListener("visibilitychange", onVisible);
    const stopWatchdog = startAudioWatchdog();

    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onVisible);
      stopWatchdog();
    };
  }, []);

  // לחיצה על המחוון: כשחסום היא *עצמה* המחווה שמשחררת, אחרת היא מתג השתקה.
  const onControlClick = useCallback(() => {
    if (getAlertState() === "locked") unlockAudio(true);
    else toggleMute();
  }, []);

  return { state, onControlClick };
}
