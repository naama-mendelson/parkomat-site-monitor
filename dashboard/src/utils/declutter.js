// utils/declutter.js — שלא יהיו אחד על השני (21/10/2026). פונקציות טהורות; נבדקות ב-master/tests/declutter.test.js.
//
// בעלת המוצר, על מפת הטכנאים: "שלא יהיו אחד על השני — שיהיה ברור מה קורה". כל טכנאי הוא תווית (עיגול + שם); תוויות
// שחופפות במסך נדחפות זו מזו, ופס דק מוביל מהתווית לנקודה האמיתית. ככל שמתקרבים — הן חוזרות למקומן.

/**
 * פריסה במסך: items = [{key, x0, y0, w, h, rank?}] (מרכז מבוקש ומידות בפיקסלים) → [{key, x0, y0, w, h, x, y}] בלי חפיפה.
 * מציבים אחת אחרי השנייה — rank נמוך קודם (מי שבנסיעה או באתר נשאר הכי קרוב למקום האמיתי), ואז לפי key — כל אחת במקום
 * הפנוי הקרוב ביותר לנקודה שלה: שורות בגובה התווית (רשימה, כמו שעין קוראת), ועמודות בצעדים של step.
 * ⚠️ דחיפת זוגות (הגרסה הראשונה, אותו יום) לא התכנסה בגוש צפוף — 38 תוויות נשארו חופפות אחרי 160 סבבים. כאן אין
 * חפיפה בהגדרה: מקום נבחר רק אם הוא פנוי.
 * ⚠️ דטרמיניסטי: אותו קלט — אותה פריסה, בלי קשר לסדר, כדי שהמפה לא תקפוץ בכל ריענון.
 */
export function declutter(items, { pad = 3, step = 16, reach = 24, bounds = null } = {}) {
  // ⚠️ bounds = המפה במסך: תווית של מי שבתוך המסך נשארת בתוכו (בתצוגה הרחוקה תוויות נדחפו אל מעבר לשוליים ונחתכו). מי
  // שמחוץ למסך — בלי הגבלה, אחרת התווית שלו הייתה נמשכת פנימה עם פס ארוך, ונראית כאילו הוא כאן.
  const inside = (x, y, w, h) => !bounds || (x - w / 2 >= bounds.x0 && x + w / 2 <= bounds.x1 && y - h / 2 >= bounds.y0 && y + h / 2 <= bounds.y1);
  const list = [...(items || [])]
    .filter((it) => Number.isFinite(it?.x0) && Number.isFinite(it?.y0))
    .map((it) => ({ ...it, w: Math.max(1, Number(it.w) || 1), h: Math.max(1, Number(it.h) || 1) }))
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || String(a.key).localeCompare(String(b.key)));
  const placed = [];
  for (const it of list) {
    const rowH = it.h + pad;
    const bounded = bounds && it.x0 >= bounds.x0 && it.x0 <= bounds.x1 && it.y0 >= bounds.y0 && it.y0 <= bounds.y1;
    let best = null;
    let loose = null;   // המקום הפנוי הראשון גם מחוץ לגבולות — אם בתוכם אין
    for (let r = 0; r <= reach && !best; r++) {
      // הטבעת ה-r: כל המשבצות שהמרחק שלהן (בצעדים) הוא בדיוק r; בתוכה — הקרובה ביותר בפיקסלים
      const ring = [];
      for (let ky = -r; ky <= r; ky++) {
        for (let kx = -r * 2; kx <= r * 2; kx++) {
          if (Math.max(Math.abs(ky), Math.ceil(Math.abs(kx) / 2)) !== r) continue;
          ring.push({ x: it.x0 + kx * step, y: it.y0 + ky * rowH });
        }
      }
      ring.sort((a, b) => Math.hypot(a.x - it.x0, a.y - it.y0) - Math.hypot(b.x - it.x0, b.y - it.y0) || a.y - b.y || a.x - b.x);
      for (const c of ring) {
        const cand = { x: c.x, y: c.y, w: it.w, h: it.h };
        if (placed.some((p) => overlaps(p, cand, pad))) continue;
        if (!bounded || inside(c.x, c.y, it.w, it.h)) { best = c; break; }
        loose ??= c;
      }
    }
    const pos = best ?? loose ?? { x: it.x0, y: it.y0 + (reach + 1) * rowH };
    const out = { ...it, x: pos.x, y: pos.y };
    placed.push(out);
  }
  return placed;
}

/** האם שתי תיבות (מרכז + מידות) חופפות, עם מרווח pad. */
export function overlaps(a, b, pad = 0) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + pad && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + pad;
}

/**
 * תוויות קבועות (שמות ערים): הגדולה ראשונה; תווית שחופפת תווית שכבר הוצבה, או מכשול (תוויות הטכנאים), — מוסתרת.
 * labels = [{key, x, y, w, h, weight}] → Set של key שמוצגים.
 */
export function placeLabels(labels, obstacles = [], pad = 4) {
  const shown = [];
  const keys = new Set();
  for (const l of [...(labels || [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || String(a.key).localeCompare(String(b.key)))) {
    if (shown.some((s) => overlaps(s, l, pad)) || obstacles.some((o) => overlaps(o, l, pad))) continue;
    shown.push(l);
    keys.add(l.key);
  }
  return keys;
}

/**
 * הליבה של הצי לתצוגה הראשונה: הנקודות הקרובות למרכז (החציון), בלי הרחוקות — כדי שגוש דן ימלא את המסך ולא אשקלון
 * וירושלים. points = [{lat, lon}] → אותן נקודות, מסוננות.
 */
export function corePoints(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (pts.length <= 3) return pts;
  const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const cLat = med(pts.map((p) => p.lat)), cLon = med(pts.map((p) => p.lon));
  const k = Math.cos((cLat * Math.PI) / 180);
  const d = (p) => Math.hypot(p.lat - cLat, (p.lon - cLon) * k);
  // ⚠️ לפי מרחק ולא לפי אחוז: "85% הקרובים" השאיר בפנים את הרחוק הראשון כשהיו רק שניים (הבדיקה תפסה). הגבול: פי 3 מהמרחק
  // החציוני מהמרכז, ולפחות כ-3 ק"מ — כך גוש דן ממלא את המסך, וירושלים ואשקלון בחוץ.
  const limit = Math.max(med(pts.map(d)) * 3, 0.03);
  const core = pts.filter((p) => d(p) <= limit);
  return core.length >= 3 ? core : [...pts].sort((a, b) => d(a) - d(b)).slice(0, 3);
}
