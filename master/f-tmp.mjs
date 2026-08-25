import fs from "node:fs";
const p = "tests/no-silent-drop.test.js";
let s = fs.readFileSync(p, "utf8");
const a = '    const hasTrace = /noteDrop\(|insertSuppressedFault\(|recordIngestDrop\(/.test(window);';
if (s.split(a).length - 1 !== 1) { console.error("❌ עוגן"); process.exit(1); }
s = s.replace(a, [
  a,
  '    // ============================================================',
  '    // ⚠️ "ללא שינוי" אינו זריקה — ההודעה כן טופלה',
  '    // ============================================================',
  '    // כשהמצב שהגיע זהה למצב הרשום, אין מה לרשום: המסד כבר מחזיק את',
  '    // האמת. הענף הזה מעדכן last_seen (או במכוון לא, ב-no_comm — "ניתוק',
  '    // אינו תצפית"), ויוצא. הוא אינו מוחק מידע.',
  '    //',
  '    // ⚠️ הפטור מנוסח על **הקוד** ולא על מספרי שורות: פטור לפי שורה היה',
  '    // מתיישן בעריכה הראשונה ומכסה בשקט זריקה אמיתית שתזוז למקומו.',
  '    const isNoChange = /newStatus === site\.status|ללא שינוי/.test(window);',
].join("\n"));
s = s.replace('    if (isDiscard && !hasTrace) out.push(i + 1);',
              '    if (isDiscard && !hasTrace && !isNoChange) out.push(i + 1);');
fs.writeFileSync(p, s);
console.log("✅ הגלאי דויק");
