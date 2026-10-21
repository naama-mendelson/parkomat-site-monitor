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
import { lazy, Suspense, useEffect, useState } from "react";
import { isTechPhoneEmail, parsePairHash } from "../../utils/techPhone";
import { clearDeviceMark, readDevice, resumeDevice, wasDisconnected } from "../../services/techDevice";

// הטלפון של הטכנאי (21/10/2026) — נטען רק בטלפון כזה, לא בחבילה של הדשבורד
const TechPhone = lazy(() => import("../TechPhone/TechPhone"));
const PhoneOff = lazy(() => import("../TechPhone/TechPhone").then((m) => ({ default: m.PhoneOff })));
const PairScreen = lazy(() => import("../TechPhone/PairScreen"));

function AuthGate({ children }) {
  const { user, loading } = useAuth();

  // ============================================================
  // הטלפון של הטכנאי (21/10/2026, שלב 2 של "צא ל:")
  // ============================================================
  // • קישור מה-QR שבכרטיס (#pair=…) — מסך החיבור, לפני הכול. אחריו הכתובת מתנקה (הפרטים לא נשארים בהיסטוריה).
  // • טלפון שה-session שלו אבד (נגרף אחרי יממה בלי שימוש) — מתחבר שוב לבד מהפרטים ששמר, ולא מציג טופס התחברות.
  // • משתמש של טלפון — מסך המשימה בלבד, ולא הדשבורד (שהמסד ממילא לא נותן לו לקרוא).
  const [pair, setPair] = useState(() => parsePairHash(typeof window !== "undefined" ? window.location.hash : ""));
  // ⚠️ 21/10/2026 (בדיקת הבאגים): התחברות שקטה שנכשלה הציגה תמיד את טופס "אימייל וסיסמה" — גם אחרי QR חדש (הפרטים כבר
  // לא עובדים; הטכנאי לא יודע מה לכתוב שם), וגם בלי קליטה (ואז נתקע שם עד שסוגרים את האפליקציה). עכשיו:
  //   off     — הפרטים שגויים (נוצר QR חדש / נותק): מסך "הטלפון אינו מחובר — לבקש מהרכז QR חדש".
  //   offline — אין חיבור: "מנסה שוב", וניסיון חוזר כל 20 שניות, כשהרשת חוזרת, וכשחוזרים למסך.
  const [resume, setResume] = useState("idle");      // idle | trying | done | off | offline
  useEffect(() => {
    if (loading || user || pair || resume !== "idle") return;
    if (!readDevice()) { if (wasDisconnected()) setResume("off"); return; }
    setResume("trying");
    resumeDevice().then((r) => setResume(r.ok ? "done" : r.reason === "network" ? "offline" : r.reason === "invalid" ? "off" : "done"));
  }, [loading, user, pair, resume]);
  // מחובר שוב — ניסיון שקט נוסף מותר בפעם הבאה שה-session יאבד (ולא לולאה: ניסיון שנכשל נשאר "done")
  useEffect(() => { if (user) setResume("idle"); }, [user]);
  useEffect(() => {
    if (resume !== "offline") return undefined;
    const again = () => setResume("idle");
    const onVis = () => { if (document.visibilityState === "visible") again(); };
    const t = setTimeout(again, 20_000);
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(t); window.removeEventListener("online", again); document.removeEventListener("visibilitychange", onVis); };
  }, [resume]);
  const pairDone = () => {
    try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch { /* */ }
    setPair(null);
  };

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

  if (pair) {
    return (
      <Suspense fallback={<div className="app-loading">מחבר את הטלפון…</div>}>
        <PairScreen cred={pair} user={user} loading={loading} onDone={pairDone} />
      </Suspense>
    );
  }

  // בודקים session שמור. בלי השלב הזה טופס ההתחברות היה מבליח בכל רענון.
  if (loading) {
    return <div className="app-loading">בודק התחברות…</div>;
  }

  if (!user && resume === "trying") return <div className="app-loading">מתחבר…</div>;
  if (!user && resume === "offline") return <div className="app-loading" role="status">אין חיבור כרגע — מנסה להתחבר שוב…</div>;
  if (!user && resume === "off") {
    return (
      <Suspense fallback={<div className="app-loading">טוען…</div>}>
        <PhoneOff onPersonLogin={() => { clearDeviceMark(); setResume("done"); }} />
      </Suspense>
    );
  }
  if (!user) return <Login />;

  // ⚠️ גם לפי האימייל: טלפון שנותק מקבל מהמסד 'anonymous', ובלי זה היה נופל לדשבורד ריק במקום להסביר מה לעשות
  if (user.role === "technician" || isTechPhoneEmail(user.email)) {
    return (
      <Suspense fallback={<div className="app-loading">טוען…</div>}>
        <TechPhone />
      </Suspense>
    );
  }

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
