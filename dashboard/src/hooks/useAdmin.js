// hooks/useAdmin.js — מצב ניהול: נעילה/פתיחה בעזרת קוד מנהל
import { useState, useCallback } from "react";
import { verifyAdminCode, getAdminCode, storeAdminCode } from "../services/api";

/**
 * ⚠️ זו איננה מערכת הרשאות. הקוד משותף לכולם ונשלח בכל בקשה.
 * הוא נועד למנוע *טעויות* (מחיקת אתר בלחיצה מקרית), לא לעצור תוקף.
 * השרת אוכף אותו גם הוא — ראה requireAdmin ב-routes.js.
 */
export function useAdmin() {
  const [unlocked, setUnlocked] = useState(() => Boolean(getAdminCode()));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const unlock = useCallback(async (code) => {
    setChecking(true);
    setError(null);
    try {
      await verifyAdminCode(code);
      storeAdminCode(code);
      setUnlocked(true);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setChecking(false);
    }
  }, []);

  const lock = useCallback(() => {
    storeAdminCode(null);
    setUnlocked(false);
  }, []);

  return { unlocked, unlock, lock, checking, error };
}
