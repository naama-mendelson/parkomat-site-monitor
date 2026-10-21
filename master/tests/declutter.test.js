// tests/declutter.test.js — "שלא יהיו אחד על השני" (utils/declutter.js, 21/10/2026): התוויות של הטכנאים במפה לא חופפות,
// מי שכבר רחוק נשאר במקומו, שמות ערים שמתנגשים מוסתרים, והתצוגה הראשונה ממוקדת בליבת הצי.
import { test } from "node:test";
import assert from "node:assert/strict";
import { declutter, overlaps, placeLabels, corePoints } from "../../dashboard/src/utils/declutter.js";

const box = (key, x0, y0, w = 100, h = 24) => ({ key, x0, y0, w, h });
const anyOverlap = (list, pad = 3) => {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlaps(list[i], list[j], pad - 0.01)) return [list[i].key, list[j].key];
  return null;
};

test("38 תוויות בגוש אחד (כמו בתצוגה הרחוקה) — אף אחת לא חופפת, וכל אחת עדיין קרובה למקומה", () => {
  // מספרים קבועים ולא אקראיים: בדיקה שעוברת רק לפעמים אינה בדיקה
  const items = Array.from({ length: 38 }, (_, i) => box(`p${String(i).padStart(2, "0")}`, 500 + ((i * 37) % 60), 300 + ((i * 53) % 40), 70 + (i % 5) * 12));
  const out = declutter(items);
  assert.equal(out.length, 38);
  assert.equal(anyOverlap(out), null);
  const far = Math.max(...out.map((o) => Math.hypot(o.x - o.x0, o.y - o.y0)));
  assert.ok(far < 400, `הפיזור הגדול ביותר ${Math.round(far)}px`);
});

test("12 בדיוק באותה נקודה (המשרד) — נפרסים, בלי חפיפה; ושתי תוויות רחבות זו על זו — אחת מעל השנייה", () => {
  const out = declutter(Array.from({ length: 12 }, (_, i) => box(`o${i}`, 200, 200)));
  assert.equal(anyOverlap(out), null);
  const two = declutter([box("a", 100, 100, 120), box("b", 104, 102, 120)]);
  assert.equal(anyOverlap(two), null);
  assert.ok(Math.abs(two[0].x - two[1].x) < 10, "רחבות — הפרדה בגובה ולא ברוחב");
});

test("מי שלא חופף לא זז; אותו קלט — אותה פריסה, בלי קשר לסדר", () => {
  const out = declutter([box("a", 0, 0), box("b", 500, 0), box("c", 0, 300)]);
  for (const o of out) assert.deepEqual([o.x, o.y], [o.x0, o.y0]);
  const items = [box("x", 10, 10), box("y", 12, 14), box("z", 15, 9)];
  const a = declutter(items).map((o) => [o.key, Math.round(o.x), Math.round(o.y)]);
  const b = declutter([...items].reverse()).map((o) => [o.key, Math.round(o.x), Math.round(o.y)]);
  assert.deepEqual(a, b);
  assert.deepEqual(declutter([{ key: "n", x0: NaN, y0: 1 }]), []);
});

test("שמות ערים: הגדולה ראשונה; שם שמתנגש בשם אחר או בתווית טכנאי — מוסתר", () => {
  const keys = placeLabels(
    [{ key: "תל אביב", x: 100, y: 100, w: 60, h: 14, weight: 80 }, { key: "רמת גן", x: 120, y: 104, w: 50, h: 14, weight: 20 },
     { key: "חולון", x: 100, y: 200, w: 40, h: 14, weight: 5 }, { key: "בת ים", x: 300, y: 300, w: 40, h: 14, weight: 3 }],
    [{ x: 100, y: 200, w: 90, h: 24 }]);
  assert.deepEqual([...keys], ["תל אביב", "בת ים"]);
});

test("ליבת הצי: בלי הרחוקים (ירושלים, אשקלון), אבל לפחות שלוש נקודות", () => {
  const tlv = Array.from({ length: 10 }, (_, i) => ({ lat: 32.06 + i * 0.004, lon: 34.78 + i * 0.003 }));
  const out = corePoints([...tlv, { lat: 31.77, lon: 35.21 }, { lat: 31.66, lon: 34.57 }]);
  assert.equal(out.length, 10, "עשרת תל אביב, בלי שני הרחוקים");
  assert.ok(out.every((p) => p.lat > 31.9), "הרחוקים נשארו בחוץ");
  assert.equal(corePoints([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]).length, 2);
});

test("גבולות המפה: תווית של מי שבתוך המסך נשארת בתוכו; מי שמחוץ למסך — לא נמשך פנימה", () => {
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
  // עשר תוויות צמודות לקצה העליון: בלי גבולות חלקן היו עולות מעל 0
  const top = declutter(Array.from({ length: 10 }, (_, i) => box(`t${i}`, 200, 14)), { bounds });
  assert.equal(anyOverlap(top), null);
  assert.ok(top.every((o) => o.y - o.h / 2 >= 0 && o.y + o.h / 2 <= 300), top.map((o) => Math.round(o.y)));
  const out = declutter([box("in", 200, 150), box("away", 900, 150)], { bounds });
  assert.deepEqual(out.map((o) => [o.key, o.x]), [["away", 900], ["in", 200]], "מחוץ למסך — במקומו");
});
