// components/Login/AuthGate.jsx — עוטף את האפליקציה: מחובר או מסך התחברות.
//
// ============================================================
// למה שער ולא הסתרת כפתורים
// ============================================================
// הדשבורד קורא מעכשיו את בסיס הנתונים ישירות, ו-RLS מתיר קריאה למאומתים
// בלבד (נבדק: כ-anon התוצאה היא permission denied). כלומר בלי session אין
// נתונים — לא "פחות נתונים", אלא כלום. שער בכניסה הוא הביטוי הכנה של זה.
//
// ============================================================
// ⚠️ מסך קיר — מה שקורה כשה-session פג
// ============================================================
// ה-session נשמר ב-localStorage ומתחדש לבד, ולכן התחברות אחת מחזיקה
// לתקופה ארוכה. אבל אם היא כן תפוג במסך שאיש לא נוגע בו, המסך יציג טופס
// התחברות ולא נתונים — וזה יקרה בשקט.
//
// זו אותה משפחת תקלות כמו האודיו החסום: כשל שאינו מייצר שגיאה. ההבדל הוא
// שכאן הוא **נראה** — טופס התחברות הוא סימן ברור, בעוד שאודיו חסום היה
// שקט ובלתי-נראה. לכן אין כאן חיווי נוסף; המסך עצמו הוא החיווי.
import { useAuth } from "../../hooks/useAuth";
import { isSupabaseConfigured } from "../../services/supabase";
import Login from "./Login";
import ResetPassword from "./ResetPassword";
import { onPasswordRecovery, reloadRole } from "../../services/auth";
import { loginCodeStatus } from "../../services/loginCodeDirect";
import LoginCode, { LoginCodeCheckFailed } from "./LoginCode";
import { useEffect, useState } from "react";

function AuthGate({ children }) {
  const { user, loading } = useAuth();

  // ============================================================
  // מצב שחזור — נקבע פעם אחת ואינו מתאפס לבד
  // ============================================================
  // ⚠️ Supabase פולט PASSWORD_RECOVERY **פעם אחת**, מיד כשהקישור נפתח.
  // ההאזנה יושבת כאן — בשער — ולא בתוך מסך, כי ברגע שהאירוע נפלט
  // המשתמש כבר מחובר, ו-AuthGate היה מציג לו את הדשבורד הרגיל.
  //
  // ⚠️ והוא נשאר דלוק עד שהסיסמה נקבעת בפועל: מסך שאפשר לדלג ממנו
  // משאיר משתמש מחובר עם סיסמה שאינו יודע — כלומר בדיוק המצב שהקישור
  // בא לפתור.
  const [recovering, setRecovering] = useState(false);
  useEffect(() => onPasswordRecovery(() => setRecovering(true)), []);

  // ============================================================
  // קוד כניסה במייל (20/10/2026) — במקום האימות באפליקציה (TOTP), שהוסר
  // ============================================================
  // ⚠️ **הבדיקה כאן היא חוויה, לא אכיפה.** התחברות שלא הקלידה קוד אינה קוראת ואינה כותבת דבר במסד
  // (app.session_ok); המסך הזה קיים כדי שהיא תקליד את הקוד **לפני** שהדשבורד ייטען לתוך שגיאות הרשאה.
  //
  // ⚠️ נבדק מחדש כשהמשתמש משתנה, וגם כשהתפקיד מהמסד נהיה 'unverified' — זה מה שקורה אחרי החלפת סיסמה:
  // changePassword מתחבר מחדש כדי לאמת את הסיסמה הנוכחית, כלומר session חדש, שעוד לא הקליד קוד.
  //
  // ⚠️ כשל בבדיקה עצמה אינו "אין צורך בקוד" (אז הדשבורד היה נטען ריק) ואינו "נעול": מסך עם "נסו שוב", שמנסה
  // לבד כל 15 שניות — מסך קיר שאיבד רשת לרגע חוזר בלי שמישהו ייגש אליו.
  const uid = user?.id ?? null;
  const unverified = user?.role === "unverified";
  const [code, setCode] = useState({ uid: null, checked: false, need: false, email: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!uid) { setCode({ uid: null, checked: false, need: false, email: null, error: null }); return undefined; }
    loginCodeStatus().then((s) => {
      if (!alive) return;
      setCode({ uid, checked: true, need: !s.error && s.required && !s.verified, email: s.email ?? null, error: s.error ?? null });
    });
    return () => { alive = false; };
  }, [uid, unverified, attempt]);
  useEffect(() => {
    if (!code.error) return undefined;
    const t = setTimeout(() => setAttempt((n) => n + 1), 15000);
    return () => clearTimeout(t);
  }, [code.error, attempt]);

  // ⚠️ התפקיד נקרא מחדש מהמסד לפני שהדשבורד עולה: עד הקוד my_role() ענה 'unverified', והאסימון לא משתנה באימות
  async function codeVerified() {
    await reloadRole().catch(() => null);
    setCode((c) => ({ ...c, need: false }));
  }

  // הגדרה חסרה — אומרים מה חסר, ולא נותנים טופס שלא יכול לעבוד.
  if (!isSupabaseConfigured) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1 className="login-title">האימות אינו מוגדר</h1>
          <p className="login-error" role="alert">
            חסרים VITE_SUPABASE_URL או VITE_SUPABASE_PUBLISHABLE_KEY ב-dashboard/.env
          </p>
        </div>
      </div>
    );
  }

  // בודקים session שמור. בלי השלב הזה טופס ההתחברות היה מבליח בכל רענון.
  if (loading) {
    return <div className="app-loading">בודק התחברות…</div>;
  }

  if (!user) return <Login />;

  // לפני שהבדיקה חזרה לא מציגים כלום — הבהוב של הדשבורד ואז מסך קוד קורא כמו תקלה.
  if (!code.checked || code.uid !== uid) return <div className="app-loading">בודק התחברות…</div>;

  if (code.error) {
    return <LoginCodeCheckFailed message={code.error} onRetry={() => setAttempt((n) => n + 1)} />;
  }

  if (code.need) return <LoginCode key={uid} email={code.email} onVerified={codeVerified} />;

  // אחרי user ולפני children: הגעה מקישור איפוס חוסמת את הדשבורד עד
  // שנקבעת סיסמה.
  if (recovering) return <ResetPassword onDone={() => setRecovering(false)} />;

  return children;
}

export default AuthGate;
