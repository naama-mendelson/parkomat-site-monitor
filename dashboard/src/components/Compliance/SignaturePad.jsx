// components/Compliance/SignaturePad.jsx — משטח חתימה לסיום ביקור תחזוקה מונעת.
//
// ============================================================
// ⚠️ הקווים נשמרים כווקטורים, לא כפיקסלים
// ============================================================
// בטלפון, גלילה קטנה מעלימה ומחזירה את סרגל הכתובת — והחלון משנה גובה.
// בסיבוב המסך הוא משנה רוחב. גרסה שמנקה את הקנבס ב-resize (או שמשנה את
// canvas.width, מה שמנקה אותו בעצמו) הייתה מוחקת חתימה שהטכנאי סיים
// שנייה קודם, בלי שום סימן למה. לכן כל נקודה נשמרת כווקטור, ו-
// ResizeObserver מצייר הכול מחדש בגודל החדש — ורק כשהגודל באמת השתנה.
//
// ⚠️ **קנה מידה אחד לשני הצירים.** הגרסה הראשונה נרמלה x לרוחב ו-y לגובה
// בנפרד: סיבוב טלפון (343px → 700px, גובה קבוע 180) מתח את החתימה פי שניים
// לרוחב, וה-PNG שנשמר היה מעוות — וחתימה שהתחילה לאורך והסתיימה לרוחב
// ערבבה שני קני מידה. עכשיו יחידת המידה היא **גובה המשטח** (הוא קבוע;
// הרוחב הוא מה שמשתנה), x נמדד ממרכז המשטח, והציור מתאים את עצמו במידה
// אחידה, ממורכז, ומתכווץ רק כשהחתימה רחבה מהמשטח הנוכחי.
//
// ⚠️ touch-action: none על הקנבס בלבד, עם 16px שוליים מכל צד. בלי none
// הדפדפן גולל את הדף במקום לצייר; עם none על כל הרוחב אי אפשר לגלול
// את הטופס כשהמשטח ממלא את המסך. השוליים הם המקום של האגודל לגלילה.
//
// שימוש:
//   const pad = useRef(null);
//   <SignaturePad ref={pad} onChange={(s) => setOk(s.acceptable)} />
//   pad.current.toPngBase64()  → base64 נטו (בלי "data:"), או null כשאינה מספיקה
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { signatureStats } from "../../utils/signature";
import "./SignaturePad.css";

const INK = "#111827";
const LINE_CSS_PX = 2.2;
const EXPORT_WIDTH = 600;   // רוחב ה-PNG — קבוע, כדי שהקובץ לא יגדל עם המסך (תקרה: 200KB)

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// נקודה שמורה: x = (X − w/2) / h, y = Y / h (X,Y ב-CSS px בזמן הציור).
// f = מקדם ההתאמה (≤ 1): כמה לכווץ כדי שכל הדיו ייכנס למשטח הנוכחי.
function fitScale(strokes, w, h) {
  let mx = 0;
  let my = 0;
  for (const s of strokes) {
    for (const p of s) {
      mx = Math.max(mx, Math.abs(p.x));
      my = Math.max(my, Math.abs(p.y - 0.5));
    }
  }
  let f = 1;
  if (mx > 0) f = Math.min(f, w / 2 / (mx * h));
  if (my > 0.5) f = Math.min(f, 0.5 / my);
  return f > 0 && Number.isFinite(f) ? f : 1;
}

const toScreen = (w, h, f, k = 1) => (p) => [(w / 2 + p.x * h * f) * k, (h / 2 + (p.y - 0.5) * h * f) * k];

function paint(ctx, strokes, map, w, h, lineWidth) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.length === 1) {
      const [x, y] = map(s[0]);
      ctx.beginPath();
      ctx.arc(x, y, lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    const [x0, y0] = map(s[0]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < s.length; i++) {
      const [x, y] = map(s[i]);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

export default function SignaturePad({ ref, height = 180, onChange, disabled = false }) {
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const activeRef = useRef(null);            // { id, stroke } — האצבע/העט שמצייר כרגע
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const fitRef = useRef(1);                  // קבוע במהלך קו; מחושב מחדש ב-redraw
  const onChangeRef = useRef(onChange);
  const [stats, setStats] = useState(() => signatureStats([]));
  const [touched, setTouched] = useState(false);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // הדיו בקואורדינטות 0..1 של המשטח **כפי שהוא מוצג עכשיו** — עליהן נבדק
  // תנאי ה"חתימה ולא שרבוט", באותה מידה אחידה שבה היא מצוירת ונשמרת.
  const shownStrokes = useCallback(() => {
    const { w, h } = sizeRef.current;
    if (!w || !h) return strokesRef.current.map((s) => s.map((p) => ({ x: p.x + 0.5, y: p.y })));
    const map = toScreen(w, h, fitRef.current);
    return strokesRef.current.map((s) => s.map((p) => {
      const [x, y] = map(p);
      return { x: x / w, y: y / h };
    }));
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (!canvas || !w) return;
    fitRef.current = fitScale(strokesRef.current, w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(ctx, strokesRef.current, toScreen(w, h, fitRef.current), w, h, LINE_CSS_PX);
  }, []);

  const publish = useCallback(() => {
    const st = signatureStats(shownStrokes());
    setStats(st);
    onChangeRef.current?.(st);
    return st;
  }, [shownStrokes]);

  // ResizeObserver: גודל חדש → backing store חדש → ציור מחדש מהווקטורים.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // w/h — מידות התוכן (בלי המסגרת), כדי שפיקסל בקנבס יהיה פיקסל על המסך.
    const apply = (w, h) => {
      const cur = sizeRef.current;
      if (!w || !h || (Math.abs(w - cur.w) < 0.5 && Math.abs(h - cur.h) < 0.5)) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      redraw();
      // המשטח השתנה — גם היחס "כמה מהמשטח החתימה תופסת"
      if (strokesRef.current.length) publish();
    };
    apply(canvas.clientWidth, canvas.clientHeight);
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [height, redraw, publish]);

  // ⚠️ ביחס לתוכן הקנבס ולא למסגרת שלו: הקנבס נושא border, ו-ResizeObserver
  // מודד את התוכן — מדידה לפי getBoundingClientRect הייתה מזיזה כל קו בעובי המסגרת.
  const toPoint = (ev) => {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    const w = sizeRef.current.w || c.clientWidth || r.width;
    const h = sizeRef.current.h || c.clientHeight || r.height;
    const f = fitRef.current;
    const X = clamp(ev.clientX - r.left - c.clientLeft, 0, w);
    const Y = clamp(ev.clientY - r.top - c.clientTop, 0, h);
    return { x: (X - w / 2) / (h * f), y: 0.5 + (Y - h / 2) / (h * f) };
  };

  const drawSegment = (a, b) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const { w, h, dpr } = sizeRef.current;
    if (!ctx || !w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = LINE_CSS_PX;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const map = toScreen(w, h, fitRef.current);
    const [bx, by] = map(b);
    ctx.beginPath();
    if (!a) {
      ctx.arc(bx, by, LINE_CSS_PX / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const [ax, ay] = map(a);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };

  const onPointerDown = (e) => {
    if (disabled || activeRef.current) return;          // אצבע שנייה — מתעלמים
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* דפדפן ישן — ממשיכים בלי לכידה */ }
    const p = toPoint(e);
    const stroke = [p];
    strokesRef.current.push(stroke);
    activeRef.current = { id: e.pointerId, stroke };
    drawSegment(null, p);
  };

  const onPointerMove = (e) => {
    const act = activeRef.current;
    if (!act || act.id !== e.pointerId) return;
    e.preventDefault();
    // אירועים מאוחדים: בטלפון האירוע מגיע ב-60Hz אבל המגע נדגם מהר יותר —
    // בלעדיהם עקומה מהירה הופכת לקווים שבורים.
    const native = e.nativeEvent;
    const evs = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [native]) {
      const p = toPoint(ev);
      const last = act.stroke[act.stroke.length - 1];
      if (last && last.x === p.x && last.y === p.y) continue;
      act.stroke.push(p);
      drawSegment(last, p);
    }
  };

  const endStroke = (e) => {
    const act = activeRef.current;
    if (!act || act.id !== e.pointerId) return;
    activeRef.current = null;
    setTouched(true);
    publish();
  };

  const clear = useCallback(() => {
    strokesRef.current = [];
    activeRef.current = null;
    redraw();
    setTouched(false);
    return publish();
  }, [publish, redraw]);

  const undo = useCallback(() => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    redraw();
    return publish();
  }, [publish, redraw]);

  useImperativeHandle(ref, () => ({
    clear,
    undo,
    stats: () => signatureStats(shownStrokes()),
    isAcceptable: () => signatureStats(shownStrokes()).acceptable,
    /** הווקטורים השמורים (יחידה = גובה המשטח, x ממרכזו) — אינם משתנים בשינוי גודל. */
    strokes: () => strokesRef.current.map((s) => s.map((p) => ({ ...p }))),
    /** PNG על רקע לבן, base64 נטו. null כשהחתימה אינה עומדת בתנאים. */
    toPngBase64() {
      if (!signatureStats(shownStrokes()).acceptable) return null;
      const { w, h } = sizeRef.current;
      if (!w || !h) return null;
      const W = EXPORT_WIDTH;
      const k = W / w;
      const H = Math.max(1, Math.round(h * k));
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      const lw = Math.min(5, Math.max(2, LINE_CSS_PX * k));
      // אותה מידה אחידה בדיוק כמו על המסך, מוגדלת כולה ב-k
      paint(ctx, strokesRef.current, toScreen(w, h, fitRef.current, k), W, H, lw);
      const url = out.toDataURL("image/png");
      const comma = url.indexOf(",");
      return comma === -1 ? null : url.slice(comma + 1);
    },
  }), [clear, undo, shownStrokes]);

  const tooSmall = touched && !stats.empty && !stats.acceptable;

  return (
    <div className={`sp-wrap${disabled ? " sp-wrap--disabled" : ""}`}>
      <canvas
        ref={canvasRef}
        className="sp-canvas"
        style={{ height: `${height}px` }}
        role="img"
        aria-label="משטח חתימה"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onLostPointerCapture={endStroke}
      />
      <div className="sp-bar">
        <span className={`sp-hint${tooSmall ? " sp-hint--warn" : ""}`} role={tooSmall ? "alert" : undefined}>
          {tooSmall
            ? "החתימה קטנה מדי — חתמו שוב, על רוב המשטח"
            : stats.acceptable
              ? "✓ החתימה נקלטה"
              : "חתמו בתוך המסגרת"}
        </span>
        <span className="sp-actions">
          <button type="button" className="sp-btn" onClick={undo} disabled={disabled || stats.empty}>
            ביטול קו
          </button>
          <button type="button" className="sp-btn" onClick={clear} disabled={disabled || stats.empty}>
            ניקוי
          </button>
        </span>
      </div>
    </div>
  );
}
