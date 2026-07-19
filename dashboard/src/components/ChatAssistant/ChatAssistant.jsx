// components/ChatAssistant/ChatAssistant.jsx — עוזר ה-AI: כפתור צף → פאנל שיחה.
//
// העוזר עונה מנתונים אמיתיים בלבד (השרת מריץ כלי קריאה), ומנמק מהארכיטקטורה
// כשהמערכת לא מתעדת סיבה. הוא לא יכול לשנות דבר.
//
// ============================================================
// גילוי — הבעיה האמיתית של הפיצ'ר הזה
// ============================================================
// עוזר שאיש לא יודע שקיים שווה כלום. עיגול עם אימוג'י בפינה אינו אומר דבר, ולכן:
//   1. הכפתור נושא **טקסט** ("שאלו את פרקובוט") ולא רק אייקון — אנשים לוחצים על
//      מה שהם מבינים.
//   2. עליו יושבים **הבוט והלוגו יחד**, כדי שיהיה ברור שזה של פרקומט.
//   3. בביקור הראשון קופצת בועה שמסבירה מה זה — פעם אחת בלבד (localStorage).
//      מי שסגר אותה לא יראה אותה שוב; נודניק הופך לרעש שמתעלמים ממנו.
//   4. הבוט ממצמץ וזז — תנועה עדינה מושכת את העין בלי לצרוח.

import { useEffect, useReducer, useRef, useState } from "react";
import { askAssistant } from "../../services/api";
import BotFace from "./BotFace";
import Logo from "../Logo/Logo";
import "./ChatAssistant.css";

// ==========================================================
// קצב החשיפה — למה יש כאן תור ולא הדפסה ישירה
// ==========================================================
// השרת מזרים מהמודל, אבל המודל לא פולט אות-אות: הוא פולט טוקנים, כלומר מילים
// שלמות או חלקי מילים, בקפיצות לא סדירות. הדפסה ישירה של הנתחים נראית מקרטעת —
// שלוש מילים בבת אחת, המתנה, עוד ארבע.
//
// לכן הנתחים נכנסים לתור, והחשיפה מתקדמת בקצב אחיד. הצעד גדל ככל שהתור מתארך,
// כך שתשובה ארוכה לא זוחלת — היא מדביקה את הפער בלי לאבד את תחושת הזרימה.
const TICK_MS = 16;              // ~60fps
const CATCHUP_DIVISOR = 28;      // ככל שקטן — מדביק מהר יותר

// ==========================================================
// ניקוי Markdown — כי הוראה אינה אכיפה
// ==========================================================
// ה-prompt אוסר Markdown במפורש, ופעמיים: גם בהוראות וגם בתזכורת שאחרי הכלים.
// המודל בכל זאת מחזיר מדי פעם **מודגש**. הבועה מציגה טקסט גולמי, ולכן
// הכוכביות מופיעות כפשוטן ונראות כמו תקלה.
//
// מודל אי אפשר להבטיח — פונקציה אפשר. הניקוי נעשה על הטקסט המצטבר (ולא על
// נתח בודד), אחרת `**` שנחתך בין שני נתחים לא היה נתפס.
function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/gs, "$1")   // **מודגש**
    .replace(/(?<!\*)\*(?!\*)/g, "")    // כוכבית בודדת שנשארה
    .replace(/^#{1,6}\s+/gm, "")        // כותרות
    .replace(/^\s*[-•]\s+/gm, "");      // תבליטים
}

// שמות הכלים בעברית — כדי שהמשתמש יראה *מה* נשלף, ולא `get_site_analytics`.
// שקיפות היא חלק מהאמון: תשובה שמראה מאיפה המספר הגיע ניתנת לבדיקה.
const TOOL_LABELS = {
  get_all_sites: "רשימת האתרים",
  get_site: "פרטי אתר",
  get_site_stats: "מדדי אתר",
  get_site_analytics: "ניתוח מעמיק",
  get_executive_stats: "תמונה מערכתית",
  get_supervisor_stats: "מצב תפעולי",
};

// שאלות שאדם באמת שואל, בניסוח שלו — לא כותרות של דוח.
const STARTERS = [
  "מה נשמע באתרים?",
  "היו תקלות החודש?",
  "איזה אתר הכי בעייתי?",
  "מה זה אחוז כשל?",
];

// ==========================================================
// הפתיחה — שתי שורות, וזהו
// ==========================================================
// הגרסה הקודמת הייתה פסקה שהסבירה מה הבוט יודע, מה הוא לא יכול, ומאיפה מפעילים
// תחזוקה. אף אחד לא קורא את זה — זה נראה כמו תנאי שימוש, וזה מרחיק.
//
// מה שהוא *לא* יכול כבר כתוב בכותרת ("קריאה בלבד"), והוא יגיד את זה בעצמו אם
// יבקשו ממנו לפעול. הפתיחה צריכה רק לומר מי הוא ושהוא שמח לעזור.
//
// ה-👋 נשאר, ה-🤖 לא: יש בוט אמיתי באווטאר ממש לידו, ואימוג'י של רובוט היה
// כפילות. נפנוף הוא מחווה, לא איור. בתשובות עצמן אין אימוג'ים בכלל.
const GREETING = {
  role: "assistant",
  content: "היי, אני פרקובוט 👋\nשאלו אותי מה שתרצו על האתרים — אני כאן כדי לעזור.",
};

const NUDGE_KEY = "parkomat.assistant.seen";

function ChatAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // הבועה של הביקור הראשון
  const [nudge, setNudge] = useState(false);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const fabRef = useRef(null);

  // סגירה בלחיצה מחוץ לפאנל. מתעלמים מלחיצה על הכפתור הצף — הוא כבר מטפל
  // בפתיחה/סגירה בעצמו (toggle), ובלי החרגה הזו לחיצה עליו הייתה סוגרת-ופותחת.
  // pointerdown (ולא click) — סוגר מיד, גם במגע.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (panelRef.current?.contains(e.target)) return;
      if (fabRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // ===== מנוע החשיפה =====
  // targetRef    = כל מה שהתקבל מהשרת עד כה (כבר מנוקה מ-Markdown)
  // revealLenRef = **כמה תווים** מתוכו כבר מוצגים — אורך, לא מחרוזת.
  // force()      = מרנדר מחדש בלי להחזיק את הטקסט ב-state (אחרת רינדור לכל תו)
  //
  // ==========================================================
  // למה אורך ולא מחרוזת — באג עדין שנתפס בבדיקה
  // ==========================================================
  // ניקוי ה-Markdown רץ על הטקסט המצטבר, ולכן היעד יכול **להתכווץ**: ברגע
  // שהכוכביות הסוגרות של `**מוכן**` מגיעות, ארבעה תווים נעלמים.
  //
  // אילו היינו שומרים את המוצג כמחרוזת, היא הייתה נשארת ארוכה מהיעד החדש —
  // התנאי "הגעתי לסוף" היה מתקיים, ה-ticker היה עוצר, והמשתמש היה נשאר תקוע
  // מול טקסט ישן שכולל כוכביות.
  //
  // אורך נחתך מעצמו (Math.min), ולכן ההתכווצות מטופלת בלי מקרה קצה.
  const targetRef = useRef("");
  const revealLenRef = useRef(0);
  const tickRef = useRef(null);
  const [, force] = useReducer((x) => x + 1, 0);

  const revealedText = () => targetRef.current.slice(0, revealLenRef.current);

  function startTicker() {
    if (tickRef.current) return;
    tickRef.current = setInterval(() => {
      const target = targetRef.current;
      const len = Math.min(revealLenRef.current, target.length);   // חיתוך על התכווצות

      if (len >= target.length) {
        if (len !== revealLenRef.current) {
          revealLenRef.current = len;
          force();
        }
        return;
      }

      const backlog = target.length - len;
      revealLenRef.current = len + Math.max(1, Math.ceil(backlog / CATCHUP_DIVISOR));
      force();
    }, TICK_MS);
  }

  function stopTicker() {
    clearInterval(tickRef.current);
    tickRef.current = null;
  }

  // ניקוי — אחרת ה-interval שורד את פירוק הרכיב וממשיך לרנדר לתוך הריק
  useEffect(() => stopTicker, []);

  // הבועה מופיעה רק פעם אחת אי־פעם, ורק אחרי שנייה וחצי — כדי לא לקפוץ על
  // המשתמש בזמן שהדשבורד עוד נטען.
  useEffect(() => {
    if (localStorage.getItem(NUDGE_KEY)) return;
    const t = setTimeout(() => setNudge(true), 1500);
    return () => clearTimeout(t);
  }, []);

  function dismissNudge() {
    setNudge(false);
    localStorage.setItem(NUDGE_KEY, "1");
  }

  function toggle() {
    dismissNudge();          // פתיחת הצ'אט = ראית את הבועה
    setOpen((v) => !v);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Esc סוגר. שאר הדשבורד נסגר בלחיצה בחוץ, אבל צ'אט הוא לא תפריט — סגירה
  // בלחיצה מקרית על הרקע הייתה מוחקת שיחה באמצע. Esc הוא מכוון.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(text) {
    const question = (text ?? input).trim();
    if (!question || busy) return;

    setError(null);
    setInput("");

    // ההיסטוריה שנשלחת לשרת אינה כוללת את הודעת הפתיחה — היא טקסט של הממשק,
    // לא משהו שהמודל אמר. שליחתה הייתה גורמת לו "לזכור" דברים שלא אמר.
    const next = [...messages, { role: "user", content: question }];
    setMessages(next);
    setBusy(true);

    targetRef.current = "";
    revealLenRef.current = 0;

    try {
      const payload = next
        .filter((m) => m !== GREETING)
        .map(({ role, content }) => ({ role, content }));

      const { text: answer, toolsUsed } = await askAssistant(payload, (chunk) => {
        // מנקים את המצטבר, לא את הנתח: `**` יכול להיחתך בין שני נתחים.
        targetRef.current = stripMarkdown(targetRef.current + chunk);
        startTicker();
      });

      // הזרם נגמר, אבל החשיפה עוד רודפת אחריו. ממתינים שתסיים — אחרת המשפט
      // האחרון היה "קופץ" לתצוגה במקום להיכתב, וזה בדיוק מה שנשבר לעין.
      await new Promise((resolve) => {
        const check = () => {
          if (revealLenRef.current >= targetRef.current.length) return resolve();
          setTimeout(check, TICK_MS);
        };
        check();
      });

      // גם ההודעה השמורה מנוקה — היא נשלחת חזרה למודל כהיסטוריה, ומודל שרואה
      // את ה-Markdown של עצמו נוטה לחזור עליו.
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: stripMarkdown(answer), toolsUsed },
      ]);
    } catch (err) {
      setError(err.message);
      // מסירים את השאלה שנכשלה כדי שאפשר יהיה לנסות שוב בלי כפילות בהיסטוריה
      setMessages((prev) => prev.slice(0, -1));
      setInput(question);
    } finally {
      stopTicker();
      targetRef.current = "";
      revealLenRef.current = 0;
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      {/* ===== הבועה של הביקור הראשון ===== */}
      {nudge && !open && (
        <div className="chat-nudge" role="status">
          <button className="chat-nudge-x" onClick={dismissNudge} aria-label="סגירה">✕</button>
          <strong>היי, אני פרקובוט 👋</strong>
          <p>שאלו אותי כל דבר על האתרים — אני עונה מנתונים אמיתיים.</p>
          <button className="chat-nudge-cta" onClick={toggle}>בוא נדבר</button>
        </div>
      )}

      {/* ===== הכפתור הצף ===== */}
      <button
        ref={fabRef}
        className={`chat-fab ${open ? "is-open" : ""} ${nudge ? "is-nudging" : ""}`}
        onClick={toggle}
        aria-label={open ? "סגירת העוזר" : "פתיחת עוזר פרקומט"}
      >
        {open ? (
          <span className="chat-fab-x">✕</span>
        ) : (
          <>
            <span className="chat-fab-art">
              <BotFace size={38} talking />
              <Logo size={16} variant="chip" />
            </span>
            <span className="chat-fab-label">שאלו את פרקובוט</span>
          </>
        )}
      </button>

      {/* ===== הפאנל ===== */}
      {open && (
        <div className="chat-panel" role="dialog" aria-label="עוזר פרקומט" ref={panelRef}>
          <header className="chat-head">
            <span className="chat-head-art">
              <BotFace size={40} talking={busy} />
            </span>
            <div className="chat-head-txt">
              <h3>
                פרקובוט
                <Logo size={14} variant="chip" />
              </h3>
              <p>העוזר של פרקומט · עונה מנתונים אמיתיים</p>
            </div>
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="סגירה">✕</button>
          </header>

          <div className="chat-body" ref={scrollRef}>
            {messages.map((m, i) => (
              <div key={i} className={`chat-row is-${m.role}`}>
                {m.role === "assistant" && (
                  <span className="chat-avatar"><BotFace size={30} /></span>
                )}

                <div className="chat-msg">
                  <div className="chat-bubble">{m.content}</div>

                  {/* מאיפה הגיעו המספרים */}
                  {m.toolsUsed?.length > 0 && (
                    <div className="chat-tools">
                      {[...new Set(m.toolsUsed)].map((t) => (
                        <span key={t} className="chat-tool">{TOOL_LABELS[t] || t}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* בזמן התשובה: שלוש נקודות עד שמגיע התו הראשון, ומשם — הטקסט
                נכתב על המסך תוך כדי שהמודל מייצר אותו. */}
            {busy && (
              <div className="chat-row is-assistant">
                <span className="chat-avatar"><BotFace size={30} talking /></span>
                <div className="chat-msg">
                  {revealLenRef.current > 0 ? (
                    <div className="chat-bubble chat-streaming">
                      {revealedText()}
                      <span className="chat-caret" />
                    </div>
                  ) : (
                    <div className="chat-bubble chat-typing"><span /><span /><span /></div>
                  )}
                </div>
              </div>
            )}

            {error && <div className="chat-error">{error}</div>}
          </div>

          {/* שאלות פתיחה — רק כשעוד לא נשאל כלום */}
          {messages.length === 1 && !busy && (
            <div className="chat-starters">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => send(s)} className="chat-starter">{s}</button>
              ))}
            </div>
          )}

          <div className="chat-input">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              placeholder="שאל/י על האתרים…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <button onClick={() => send()} disabled={busy || !input.trim()} aria-label="שליחה">↑</button>
          </div>
        </div>
      )}
    </>
  );
}

export default ChatAssistant;
