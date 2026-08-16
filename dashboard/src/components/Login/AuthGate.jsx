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
import { onPasswordRecovery } from "../../services/auth";
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

  // אחרי user ולפני children: הגעה מקישור איפוס חוסמת את הדשבורד עד
  // שנקבעת סיסמה.
  if (recovering) return <ResetPassword onDone={() => setRecovering(false)} />;

  return children;
}

export default AuthGate;
