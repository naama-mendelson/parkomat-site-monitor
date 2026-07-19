// hooks/useTheme.js — ערכת הנושא: בהירה כברירת מחדל, והבחירה נזכרת.
//
// ==========================================================
// שתי החלטות שכדאי להבין
// ==========================================================
// 1. ברירת המחדל היא **בהירה**. קודם היא הייתה כהה קשיחה בקוד
//    (useState(true)), ולא הייתה שום דרך לשנות אותה.
//
// 2. הבחירה נשמרת ב-localStorage ולא ב-sessionStorage: היא צריכה לשרוד
//    סגירת דפדפן, אחרת "ברירת המחדל" הייתה מתאפסת בכל בוקר.
//
// למה *לא* לכבד את prefers-color-scheme של מערכת ההפעלה: המשתמשת ביקשה
// במפורש שהמצב ההתחלתי יהיה בהיר. אילו היינו הולכים לפי המערכת, מי
// שהמחשב שלה במצב כהה הייתה מקבלת מסך כהה — כלומר בדיוק לא מה שביקשה.
// מי שרוצה כהה — לוחצת פעם אחת, וזה נזכר.

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "parkomat.theme";
const DEFAULT_THEME = "light";

// קריאה בטוחה: בגלישה פרטית / חסימת אחסון, localStorage זורק.
// נפילה כאן הייתה מונעת מהאפליקציה כולה לעלות.
function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

function writeStored(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* אחסון חסום — הבחירה תחיה רק עד לרענון */
  }
}

export function useTheme() {
  // הפונקציה נקראת פעם אחת בלבד (lazy init) ולא בכל render
  const [theme, setTheme] = useState(() => readStored() || DEFAULT_THEME);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStored(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  // חזרה לברירת המחדל של המערכת (בהירה) — מוחק את ההעדפה השמורה
  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* אחסון חסום */
    }
    setTheme(DEFAULT_THEME);
  }, []);

  return { theme, darkMode: theme === "dark", setTheme, toggle, reset };
}
