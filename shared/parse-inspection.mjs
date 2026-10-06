// parse-inspection.mjs — חילוץ תאריכים וליקויים מתסקיר בודק מוסמך.
//
// טהור: בלי DOM, בלי pdfjs, בלי רשת. הקלט הוא בדיוק מה ש-pdfjs מחזיר:
//   pages = [{ items: page.getTextContent().items }, ...]
// כך שאותה פונקציה רצה בדפדפן (על קובץ שהמשתמש בחר) ובצומת (בבדיקות).
//
// הפלט הוא *הצעה* — המעלה מאשר/מתקן לפני שמירה. לכן כל שדה שלא נמצא חוזר
// null, ולא ניחוש: תוקף של 12 חודשים "כברירת מחדל" היה מסמן תסקיר של חצי
// שנה (נוסח ב') כבתוקף חצי שנה אחרי שפג.
//
// opts:
//   debug  — שורות גולמיות (section.rawLines, lines) לתצוגת "כפי שנקרא".
//   pages  — מספרי עמודים (מ-1, כמו בכל הפלט) לפענוח בלוק אחד מתוך קובץ עם
//            כמה תסקירים; הערכים באים כמו שהם מ-reports[i].pages.

const HEB = /[֐-׿]/;
const STRONG_LTR = /[A-Za-z0-9]/;

// תאריך: ISO (yyyy-mm-dd) קודם, ואז יום/חודש/שנה כמקובל בארץ.
// ⚠️ ISO חייב להיבדק במפורש ולפני: בלעדיו "2026-11-11" נקרא כ-26/11/11 —
// כלומר 2011-11-26, תאריך תקין לגמרי ושגוי לגמרי, שעובר כל בדיקת טווח.
// ⚠️ לא צמוד לספרה קודמת — אחרת "12026-11-11" או "105/03/2026" נבלעים
// מהאמצע ויוצא תאריך מספרה שאינה שלו (מספר תסקיר צמוד לתאריך קורה בטפסים).
// ⚠️ (?:^|\D) ולא (?<!\d): lookbehind אינו נתמך ב-Safari לפני 16.4, וביטוי
// כזה ברמת המודול הוא SyntaxError שמפיל את כל ה-chunk של לשוניות הבודק
// והתחזוקה בטלפון ישן — לא רק את הפענוח. אין lookbehind בשום מקום בקובץ.
// בשנה ISO המפריד חוזר על עצמו, כדי ש"2026-04/12" לא ייחשב ISO.
// ⚠️ DATE_TOKEN משובץ בתוך ביטויים אחרים, ולכן הקבוצה שלו *שמית*: הפניה
// ממוספרת (\1) הייתה מצביעה על הקבוצה החיצונית של הביטוי המארח.
const DATE_TOKEN = String.raw`(?:\d{4}\s*(?<sep>[/.\-])\s*\d{1,2}\s*\k<sep>\s*\d{1,2}|\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*(?:\d{4}|\d{2}))(?!\d)`;
const DATE_RE = /(?:^|\D)(?:(\d{4})\s*([/.\-])\s*(\d{1,2})\s*\2\s*(\d{1,2})|(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4}|\d{2}))(?!\d)/;
// התאריך מיד אחרי התווית (":" או מקף ביניהם), או בתחילת השורה שמתחת.
// ⚠️ גם מקף עברי (־, U+05BE): "בתוקף עד ל־05/03/2027" — בלעדיו התווית נמצאה,
// התאריך לא, והתסקיר קיבל no_validity על תוקף שכתוב בו במפורש.
const DATE_AFTER_LABEL = new RegExp(String.raw`^\s*[:\-–־]?\s*(${DATE_TOKEN})`);
const DATE_LINE_START = new RegExp(String.raw`^\s*(${DATE_TOKEN})`);

// ── 1. פריטים ───────────────────────────────────────────────────────────────

// pdfjs מחזיר עברית בסדר לוגי בתוך פריט rtl, אבל שלוש תופעות נשארות:
//   א. סוגריים הפוכים בחלק מהיצרנים (נוסח א': ")1234(") — מטופל ב-fixParens
//      על הטקסט הסופי, כי זה תלוי-גופן ולא תלוי-מסמך (בנוסח ב': f3 תקין, f4 הפוך).
//   ב. מספור סעיף שהנקודה שלו קפצה קדימה: ".9 תיאור" ← "9. תיאור".
//   ג. פריט ltr שמכיל עברית: הריצות בסדר חזותי ("03-5162258 פקס").
function normItem(it) {
  const t = it.transform || [1, 0, 0, 1, 0, 0];
  let s = String(it.str ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const fs = it.height || Math.hypot(t[2], t[3]) || 10;
  if (it.dir === 'rtl') s = s.replace(/^\.(\d{1,3})(?=\s)/, '$1.');
  else if (HEB.test(s) && /\s/.test(s)) s = reorderMixedLtr(s);
  return { s, x: t[4], y: t[5], w: it.width || 0, fs };
}

function reorderMixedLtr(s) {
  const groups = [];
  for (const tok of s.split(' ')) {
    const heb = HEB.test(tok);
    const last = groups[groups.length - 1];
    if (last && last.heb === heb) last.toks.push(tok);
    else groups.push({ heb, toks: [tok] });
  }
  // סימן שעומד *לפני* ריצה עברית ("18/11/2025 :תאריך") הוא חזותית הקצה השמאלי
  // שלה — כלומר הסוף הלוגי. עובר לסוף הריצה כולה, לא לסוף המילה הראשונה.
  return groups.reverse()
    .map(g => { const s2 = g.toks.join(' '); return g.heb ? s2.replace(/^([:.,;]+)(.+)$/, '$2$1') : s2; })
    .join(' ');
}

// ── 2. שורות ────────────────────────────────────────────────────────────────

function groupLines(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y);
  const lines = [];
  for (const it of sorted) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(cur.y - it.y) <= 0.4 * Math.max(cur.fs, it.fs)) {
      cur.items.push(it);
      cur.y = (cur.y * (cur.items.length - 1) + it.y) / cur.items.length;
      cur.fs = Math.max(cur.fs, it.fs);
    } else {
      lines.push({ y: it.y, fs: it.fs, items: [it] });
    }
  }
  for (const l of lines) l.text = joinRtl(l.items);
  return lines;
}

// סדר קריאה RTL: מימין לשמאל לפי הקצה הימני. אבל רצף LTR (מספרים, לטינית)
// שמפוצל לכמה פריטים צמודים — "16" "/" "03" "/" "20" "2" "7" בנוסח ב' — חייב
// להישאר משמאל לימין, אחרת התאריך יוצא "7 2 20/03/16".
// סימן ניטרלי בקצה השמאלי של רצף (":", ".") שייך לצד העברי ונשאר אחריו.
function joinRtl(items) {
  const sorted = items.slice().sort((a, b) => (b.x + b.w) - (a.x + a.w) || b.x - a.x);
  const toks = [];
  for (let i = 0; i < sorted.length;) {
    const it = sorted[i];
    if (HEB.test(it.s) || !STRONG_LTR.test(it.s)) {
      toks.push({ s: it.s, left: it.x, right: it.x + it.w, fs: it.fs });
      i++;
      continue;
    }
    const run = [it];
    let left = it.x;
    for (let j = i + 1; j < sorted.length; j++) {
      const nx = sorted[j];
      if (HEB.test(nx.s)) break;
      if (left - (nx.x + nx.w) > 0.35 * Math.max(it.fs, nx.fs)) break;
      run.push(nx);
      left = Math.min(left, nx.x);
    }
    let k = run.length;
    while (k > 1 && !STRONG_LTR.test(run[k - 1].s)) k--;
    const core = run.slice(0, k).sort((a, b) => a.x - b.x);
    let s = core[0].s;
    for (let m = 1; m < core.length; m++) {
      const gap = core[m].x - (core[m - 1].x + core[m - 1].w);
      s += (gap > 0.15 * core[m].fs ? ' ' : '') + core[m].s;
    }
    toks.push({ s, left: core[0].x, right: Math.max(...core.map(c => c.x + c.w)), fs: it.fs });
    for (const t of run.slice(k)) toks.push({ s: t.s, left: t.x, right: t.x + t.w, fs: t.fs });
    i += run.length;
  }
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    if (i === 0) { out = toks[0].s; continue; }
    const gap = toks[i - 1].left - toks[i].right;
    out += (gap > 0.15 * Math.max(toks[i].fs, toks[i - 1].fs) ? ' ' : '') + toks[i].s;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ── 3. עזרי טקסט ────────────────────────────────────────────────────────────

// מזווג כל ")" שאין לו פותח עם ה-"(" הבא שאין לו סוגר, ומחליף את שניהם.
// עובד על הטקסט המחובר (אחרי איחוד שורות שבורות), כי בשורה בודדת הזוג חתוך.
export function fixParens(s) {
  const chars = [...s];
  const open = [];
  const badClose = [];
  const badOpen = [];
  chars.forEach((c, i) => {
    if (c === '(') open.push(i);
    else if (c === ')') { if (open.length) open.pop(); else badClose.push(i); }
  });
  badOpen.push(...open);
  for (const ci of badClose) {
    const oi = badOpen.findIndex(o => o > ci);
    if (oi < 0) continue;
    chars[ci] = '(';
    chars[badOpen[oi]] = ')';
    badOpen.splice(oi, 1);
  }
  return chars.join('').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
}

export function parseDate(str) {
  const m = DATE_RE.exec(str || '');
  if (!m) return null;
  let d, mo, y;
  if (m[1]) { y = +m[1]; mo = +m[3]; d = +m[4]; }
  else {
    d = +m[5]; mo = +m[6]; y = +m[7];
    if (m[7].length === 2) y += 2000;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// התווית ואחריה תאריך — באותה שורה, ואם לא, בתחילת השורה שמתחתיה.
function findLabeledDate(lines, labels) {
  for (const re of labels) {
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i].text);
      if (!m) continue;
      const after = lines[i].text.slice(m.index + m[0].length);
      const direct = DATE_AFTER_LABEL.exec(after);
      if (direct) { const iso = parseDate(direct[1]); if (iso) return { iso, label: m[0].trim() }; }
      const below = lines[i + 1] && DATE_LINE_START.exec(lines[i + 1].text);
      if (below) { const iso = parseDate(below[1]); if (iso) return { iso, label: m[0].trim(), below: true }; }
    }
  }
  return null;
}

// ── גיבוי לתאריך הבדיקה הבאה ────────────────────────────────────────────────
// כשהמסמך לא כותב "בדיקה הבאה" / "בתוקף עד": כל התאריכים במסמך, ומהם אלה
// שאחרי תאריך הבדיקה. **אחרי תאריך הבדיקה ולא אחרי היום** — תסקיר ישן שמועלה
// לארכיון, מועד הבדיקה הבאה שלו כבר עבר, והוא עדיין התאריך הנכון.
// עד 800 יום — אותו גבול כמו בטופס; תאריך רחוק מזה אינו תוקף של תסקיר.
// מועמד יחיד = הצעה. כמה = רשימה לבחירה, בלי הצעה: בחירה בין שניים לפי
// "המאוחר" או "המוקדם" הייתה ניחוש שנראה כמו קריאה.
const DATE_RE_G = new RegExp(DATE_RE.source, 'g');
const GUESS_MAX_DAYS = 800;
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const ilDate = (iso) => iso.split('-').reverse().join('/');
function guessValidity(lines, inspectedIso) {
  if (!inspectedIso) return null;
  const limit = addDaysIso(inspectedIso, GUESS_MAX_DAYS);
  const all = new Set();
  for (const l of lines) {
    for (const m of l.text.matchAll(DATE_RE_G)) {
      const iso = parseDate(m[0]);
      if (iso && iso > inspectedIso && iso <= limit) all.add(iso);
    }
  }
  const candidates = [...all].sort();
  if (!candidates.length) return null;
  return { iso: candidates.length === 1 ? candidates[0] : null, candidates };
}

function firstMatch(lines, res) {
  for (const re of res) for (const l of lines) { const m = re.exec(l.text); if (m) return m[1].trim(); }
  return null;
}

// ── 4. סיווג עמודים ─────────────────────────────────────────────────────────

const REPORT_HINTS = [/תסקיר\s+בדיק/, /תאריך\s+ה?בחינה/, /בתוקף\s+עד/, /בדיקה\s+ה?באה/,
  /ליקו/, /בודק\s+ה?מוסמך/, /מאשר\s+כי\s+ביום/, /מסקנ/, /התיקונים/, /הוסמכתי/];
const INVOICE_HINTS = [/חשבונית/, /לתשלום/, /מע["״]מ/, /עוסק\s+מורשה/, /קבלה\s+מס/, /סה["״]כ/, /העברה\s+בנקאית/];

function classifyPage(text) {
  const r = REPORT_HINTS.filter(re => re.test(text)).length;
  const inv = INVOICE_HINTS.filter(re => re.test(text)).length;
  return { report: r >= 2 && r > inv, r, inv };
}

// ── 4א. כמה תסקירים בקובץ אחד ──────────────────────────────────────────────

// "הקודמת" מוחרג כמו "הבאה": "תאריך הבדיקה הקודמת" אינו תאריך הבדיקה הזו —
// ומאז שתאריך שונה מפצל בלוקים (למטה), קריאה שגויה שלו היא הערה קריטית.
const INSPECTED_LABELS = [
  /תאריך\s+ה?(?:בחינה|בדיקה)(?!\s*ה?(?:באה|קודמת))/,
  /מאשר\s+(?:בזאת\s+)?כי\s+ביום/,
  /נבדק\s+ביום/,
];
// ⚠️ כל מזהה — בכמה נוסחים. היה נוסח אחד ("מספר מתקן", "מספר תסקיר"), ובקובץ
// שכתוב בו "מס' מתקן" / "תסקיר מס'" / "מתקן מס'" אף מזהה לא נמצא, הפיצול לא
// קרה, והתסקיר השני — זה שפג, עם הליקוי הדחוף — נעלם בביטחון 'high'.
// (?:^|[^א-ת]) לפני הנוסחים הקצרים: "לתסקיר מס' 123" הוא הפניה לתסקיר אחר.
// הנוסחים החדשים בסוף: firstMatch עובר ביטוי-ביטוי, כך שמסמך שנקרא עד היום
// לפי נוסח קיים ממשיך להיקרא בדיוק כך.
const REPORT_NO_RES = [
  /מספר\s+(?:ה)?תסקיר\s*[:\-]?\s*(\d[\d/\-]*\d)/,
  /מס['׳]?\s*(?:סידורי\s+)?(?:של\s+)?ה?(?:דו["״]ח|תסקיר)\s*[:\-]?\s*(\d[\d/\-]*\d)/,
  /מספר\s+(?:ה)?דו["״]ח\s*[:\-]?\s*(\d[\d/\-]*\d)/,
  /(?:^|[^א-ת])(?:תסקיר|דו["״]ח)\s+מס(?:פר|['׳’.])?\s*[:\-]?\s*(\d[\d/\-]*\d)/,
];
const MACHINE_NO_RES = [
  /מספר\s+(?:ה)?מתקן\s*[:\-]?\s*(\d+)/,
  /(?:^|[^א-ת])מס(?:['׳’.]\s*|\s+)(?:ה)?מתקן\s*[:\-]?\s*(\d+)/,
  /(?:^|[^א-ת])מתקן\s+מס(?:פר|['׳’.])?\s*[:\-]?\s*(\d+)/,
];
const REPORT_TITLE = /תסקיר\s+בדיק/;
// "בתוקף עד ל-11/11/2026": בלי ה-ל בתווית, התאריך לא צמוד אליה ולא נקרא
// בכלל — no_validity על תסקיר שהתוקף כתוב בו במפורש. המקף שאחרי ה-ל נבלע
// ב-DATE_AFTER_LABEL, כמו המקף של "עד - 11/11".
// ":" *לפני* ה-ל ("בתוקף עד: ל-05/03/2027"): בלעדיו הקבוצה של ה-ל נכשלה על
// הנקודתיים, ו-":" לבד לא מקדם עד התאריך.
// ("עד לסוף ..." מאבד כאן את ה-ל שלו, וזה בלי נזק: גם כך זה אינו תאריך,
// והחיפוש עובר לשורה שמתחת בדיוק כמו קודם.)
const VALID_LABEL = /(?:בתוקף|תקף)\s+עד\s*:?(?:\s*ליום|\s*לתאריך|\s*ל)?/;
const NEXT_LABELS = [/(?:תאריך|מועד)\s+(?:ה)?בדיקה\s+ה?באה/, /(?:^|\s)בדיקה\s+ה?באה/];

// ⚠️ למה מפצלים בכלל: בודק ששלח שני מתקנים באותו PDF קיבל עד עכשיו תסקיר
// "אחד" — התאריכים והליקויים של הראשון, והשני פשוט נעלם. אם השני הוא זה
// שפג, האתר יצא ירוק. לכן קובץ כזה מחזיר רשימת בלוקים והערה *קריטית*.
//
// בלוק חדש מתחיל בעמוד שבו:
//   (א) מספר המתקן שונה מזה של הבלוק הנוכחי;
//   (ב) כותרת תסקיר חוזרת עם מספר תסקיר אחר. כותרת = מספר תסקיר, ולצידו
//       הכותרת "תסקיר בדיק…" *או* תווית "תאריך הבחינה". ⚠️ לא הכותרת לבדה:
//       "תסקיר בודק מוסמך" / "דו"ח בדיקה" אינם "תסקיר בדיק", ושני תסקירים
//       כאלה התמזגו. ⚠️ ולא המספר לבדו: עמוד המשך שמצטט "ראה מספר תסקיר
//       90/1" אינו תסקיר חדש;
//   (ג) תאריך בחינה אחר — הגיבוי שאינו תלוי בנוסח. תסקיר אחד מתאר בדיקה
//       אחת, ולכן "תאריך הבחינה" שונה בעמוד שנראה כראש תסקיר (כותרת או
//       תווית תוקף) הוא בדיקה אחרת — גם כשאף מזהה לא נקרא. חוץ מעמוד שחוזר
//       על אותו מספר תסקיר: שם זה אותו תסקיר עם סתירה, ו-parseBlock מסמן
//       inspected_mismatch.
// עמוד בלי מזהים (המשך הצהרה, חתימה) נשאר בבלוק הנוכחי.
// ⚠️ שמרני בכוונה: כותרת שחוזרת עם *אותו* מספר (טופס שמדפיס כותרת בכל
// עמוד), או בלי מספר בכלל, אינה מפצלת — פיצול שגוי שובר תסקיר אחד לשניים
// ושולח את המנהל להעלות חצי תסקיר.
function pageIdentity(p) {
  const machineNo = firstMatch(p.lines, MACHINE_NO_RES);
  const reportNumber = firstMatch(p.lines, REPORT_NO_RES);
  const titled = REPORT_TITLE.test(p.text);
  const header = reportNumber != null && (titled || INSPECTED_LABELS[0].test(p.text));
  const inspected = findLabeledDate(p.lines, [INSPECTED_LABELS[0]])?.iso ?? null;
  const headLike = titled || VALID_LABEL.test(p.text) || NEXT_LABELS.some(re => re.test(p.text));
  return { machineNo, reportNumber, header, inspected, headLike };
}

function splitBlocks(reportPages) {
  const blocks = [];
  let cur = null;
  for (const p of reportPages) {
    const id = pageIdentity(p);
    const otherMachine = cur && id.machineNo && cur.machineNo && id.machineNo !== cur.machineNo;
    const otherReport = cur && id.header && cur.headerReport && id.reportNumber !== cur.headerReport;
    const sameReport = cur && id.reportNumber && id.reportNumber === cur.reportNumber;
    const otherDate = cur && id.headLike && id.inspected && cur.inspected && id.inspected !== cur.inspected && !sameReport;
    if (!cur || otherMachine || otherReport || otherDate) {
      cur = { pages: [], machineNo: null, reportNumber: null, headerReport: null, inspected: null };
      blocks.push(cur);
    }
    cur.pages.push(p);
    cur.machineNo ??= id.machineNo;
    cur.reportNumber ??= id.reportNumber;
    if (id.header) cur.headerReport ??= id.reportNumber;
    cur.inspected ??= id.inspected;
  }
  return blocks.map(b => b.pages);
}

// ── 5. מקטע הליקויים ────────────────────────────────────────────────────────

const SECTION_START = [
  { fmt: 'form-a', re: /תיאור\s+הליקו(?:י)?ים/ },
  { fmt: 'form-b', re: /מה\s+התיקונים/ },
  { fmt: 'generic', re: /(?:פירוט|רשימת)\s+(?:ה)?ליקו(?:י)?ים/ },
  { fmt: 'generic', re: /ליקו(?:י)?ים\s+ש?(?:נמצאו|התגלו)/ },
];
// סוף המקטע — שני סוגים:
//   קשה: כותרת הסעיף הבא בטופס. "הערה/הערות" היא כותרת כשהשורה *כולה*
//        כותרת: המילה, לכל היותר מילה אחת שאומרת איזו/של מי ("אחרות",
//        "הבודק"), ונקודתיים — ממוספרת ("5. הערות אחרות:") או לא ("הערה"
//        בנוסח א', "הערות הבודק:").
//        ⚠️ שורה "הערה: יש לתקן את המעקה" *בתוך* הרשימה היא תוכן, לא סוף —
//        קודם היא חתכה את המקטע, וכל ליקוי שאחריה נעלם בלי שום סימן.
//        ⚠️ ואותו דבר כשהיא ממוספרת: "2. הערות התסקיר הקודם טרם תוקנו" ברשימה
//        1, 2, 3 היא ליקוי 2. ראו endKindOf.
//   רך:  מסקנה / חתימה / הצהרת "אני" — המקטע אכן נגמר, אבל הטופס דילג על
//        הכותרת הצפויה, ולכן ייתכן שליקוי נחתך או שהצהרה נדבקה. מסומן
//        soft_section_end (ביטחון בינוני), והשורות שאחרי מוצגות ב-debug.
// ⚠️ "אני" ולא אני\b: ב-JS \b מכיר רק אותיות ASCII, כך ש-אני\b *לעולם* לא
// תאם — לא לפני רווח ולא בסוף שורה. הצהרת הבודק נדבקה לליקוי האחרון.
// ":" ו-"," נוספו לרווח ולסוף השורה כי כך כותבים ("אני: מהנדס", "אני, ישראל").
const NOTES_HEADING = /^(?:\d{1,2}\s*[.)]\s*)?(?:הערה|הערות)(?:\s+(?:אחרות|נוספות|כלליות|ו?ה[א-ת]+))?\s*[:.\-–]?\s*$/;
const NOTES_NUMBERED = /^(\d{1,2})\s*[.)]\s*(?:הערה|הערות)(?![א-ת])/;
const HARD_END = /^(?:\d{1,2}\s*[.)]\s*)?(?:הוסמכתי|האמצעים\s+שיש\s+לנקוט)/;
const SOFT_END = /^(?:\d{1,2}\s*[.)]\s*)?(?:מסקנ(?:ה|ות|ת)|חתימת|אני(?=[\s:,]|$))/;
const ITEM_NO = /^\(?(\d{1,2})\s*[.)](?!\d)/;
const DEADLINE_PHRASE = /תוך\s*(\d+)\s*(?:יום|ימים)\s*(?:אם|אלא\s+אם)\s*לא\s*צוי?ין\s*אחרת/;
// כותרת עמוד שטופס מדפיס שוב בראש כל עמוד — רק כשהיא *פותחת* את השורה, כדי
// ש"- לסמן את מספר המתקן 111 על השלט" יישאר ליקוי.
const RUNNING_HEADER = [REPORT_TITLE, ...REPORT_NO_RES, ...MACHINE_NO_RES, INSPECTED_LABELS[0], VALID_LABEL, /מקום\s+הבדיקה/];
const PAGE_MARK = /^\s*(?:(?:עמוד|דף)\s*\d{1,3}(?:\s*(?:מתוך|\/)\s*\d{1,3})?|page\s*\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?)\s*$/i;
// נוסח ב': הכותרת ממשיכה במילים שלה ("מה התיקונים: החידושים או השינויים
// הדרושים והתקופה שיש לבצעם (תוך 45 יום…):") — אלה אינם ליקוי.
const HEADING_TAIL = /^\s*(?:החידושים\s+או\s+)?השינויים\s+הדרושים(?:\s+והתקופה\s+שיש\s+לבצעם)?/;
const DEADLINE_IN_PARENS = new RegExp(String.raw`[()\s]*${DEADLINE_PHRASE.source}[()\s]*`);
const BOILERPLATE = /^[\s\-–—:()]*תוך\s*(\d+)\s*(?:יום|ימים)\s*(?:אם|אלא\s+אם)\s*לא\s*צוי?ין\s*אחרת[\s\-–—:()]*$/;
const NONE_LINE = /^[\s\-–—]*(?:אין|אין\s+ליקויים|אין\s+הערות|לא\s+נמצאו\s+ליקויים|ללא(?:\s+ליקויים)?|תקין)[\s.]*$/;
const BULLET = /^(?:[-–—•●▪*]+\s*|\(\d{1,2}\)\s*|\d{1,2}[.)](?!\d)\s*|[א-ת]['׳]?[.)]\s+)/;
// שורה שכולה סיומת דחיפות היא המשך של הליקוי הקודם, גם אם היא מתחילה במקף.
const TAIL_ONLY = /^[-–—]\s*(?:לטיפול\s+מי?ידי|מי?ידי|תוך\s+\d+\s+(?:יום|ימים))[\s.]*$/;
const URGENT = /לטיפול\s+מי?ידי|באופן\s+מי?ידי|(?:^|\s)מי?ידי(?:ת)?(?:\s|$|\.)/;

function findSection(reportPages) {
  for (let pi = 0; pi < reportPages.length; pi++) {
    const { lines } = reportPages[pi];
    for (let li = 0; li < lines.length; li++) {
      for (const st of SECTION_START) {
        if (st.re.test(lines[li].text)) return { pi, li, fmt: st.fmt, re: st.re };
      }
    }
  }
  return null;
}

// נוסח א': סעיף 9 (ליקויים) וסעיף 10 (אמצעים) הם שתי עמודות באותה שורה.
// הולכים שמאלה מהכותרת פריט אחר פריט; רווח של יותר מ-40pt בין שני פריטים
// סמוכים הוא גבול עמודה. ⚠️ לא "מרחק מהכותרת": בנוסח ב' הכותרת נמשכת ברצף
// עד x=124 ("(תוך 45 יום...)"), ומדידה מהעוגן חתכה שם עמודה שאינה קיימת.
function columnLeftBound(line, re) {
  const anchor = line.items.find(it => re.test(it.s));
  if (!anchor) return -Infinity;
  const leftward = line.items.filter(it => it !== anchor && it.x + it.w <= anchor.x + 1)
    .sort((a, b) => (b.x + b.w) - (a.x + a.w));
  let edge = anchor.x;
  for (const it of leftward) {
    if (edge - (it.x + it.w) > 40) return it.x + it.w + 2;
    edge = Math.min(edge, it.x);
  }
  return -Infinity;
}

// שורה ממוספרת שפותחת ב"הערה/הערות" ויש אחריה תוכן — ליקוי או הסעיף הבא?
// המספר מכריע: n שממשיך את מספור הרשימה (הפריט הקודם + 1) הוא ליקוי n;
// n שהוא מספר הסעיף הבא בטופס (כותרת המקטע + 1, "4. ליקויים" → "5. הערות: אין")
// הוא סוף. כששניהם נכונים או אף אחד — סוף *רך*: עדיף אזהרה על שורה שנחתכה
// מאשר ליקוי שנעלם בשקט (כך נעלם "3. … לטיפול מיידי" אחרי "2. הערות …").
function endKindOf(text, headNo, lastNo) {
  if (NOTES_HEADING.test(text) || HARD_END.test(text)) return 'hard';
  const nm = NOTES_NUMBERED.exec(text);
  if (nm) {
    const n = +nm[1];
    const continues = lastNo != null && n === lastNo + 1;
    const nextSection = headNo != null && n === headNo + 1;
    if (continues && !nextSection) return null;
    return nextSection && !continues ? 'hard' : 'soft';
  }
  return SOFT_END.test(text) ? 'soft' : null;
}

// ליקוי שכתוב על שורת הכותרת עצמה ("4. ליקויים שנמצאו: להחליף את הכבל").
// ⚠️ קודם הגוף התחיל בשורה *שאחרי* הכותרת: הליקוי נעלם, המקטע יצא ריק,
// והמסך הציע לאשר שהתסקיר נקי. רק מה שאחרי ":" שאחרי ההתאמה — ובלי המשך
// הכותרת עצמה ומשפט המועד; מה שנשאר ועדיין נגמר ב-":" הוא עוד כותרת.
function headingRemainder(headText, re) {
  const m = re.exec(headText);
  if (!m) return null;
  const rest = headText.slice(m.index + m[0].length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const body = rest.slice(colon + 1).replace(HEADING_TAIL, '').replace(DEADLINE_IN_PARENS, ' ');
  if (/:\s*$/.test(body)) return null;
  const t = body.replace(/^[\s:\-–—]+/, '').trim();
  return /[א-תA-Za-z0-9]/.test(t) ? t : null;
}

// מחזיר גם:
//   after   — השורות מסימן הסוף (כולל) ועד סוף אותו עמוד, באותה עמודה. אם
//             הסוף זוהה מוקדם מדי, *אלה* השורות שהיו אמורות להיכנס — ולכן הן
//             מה שהמעלה צריך לראות כדי לתפוס ליקוי חתוך.
//   raw     — הגוף בסדר קריאה: מחרוזות, ושורות שדולגו כ-{text, skipped:true}.
//   crossed — הגוף ממשיך מעבר לעמוד של הכותרת.
// ⚠️ מקטע שעובר עמוד אוסף גם את מה שהטופס מדפיס בראש העמוד הבא. כותרת עמוד
// שחוזרת על עצמה ("תסקיר בדיקת…", "מספר תסקיר: …", התאריכים) נדבקה כך לליקוי
// האחרון — בביטחון 'high'. לכן בראש כל עמוד המשך מדלגים על שורות שזהות
// לשורה מאזור הכותרת (לפני כותרת המקטע) או שנפתחות בתווית של כותרת, עד
// השורה הראשונה שאינה כזו; ומספור עמוד ("עמוד 2 מתוך 3") — בכל מקום.
function sectionLines(reportPages, sec) {
  const startLine = reportPages[sec.pi].lines[sec.li];
  const colLeft = columnLeftBound(startLine, sec.re);
  const textOf = (l) => {
    const items = l.items.filter(it => it.x + it.w > colLeft);
    if (!items.length) return null;
    return items.length === l.items.length ? l.text : joinRtl(items);
  };
  const headText = textOf(startLine) ?? startLine.text;
  const hn = ITEM_NO.exec(headText);
  const headNo = hn ? +hn[1] : null;
  const headerTexts = new Set();
  for (let pi = 0; pi <= sec.pi; pi++) {
    const ls = reportPages[pi].lines;
    for (let li = 0; li < (pi === sec.pi ? sec.li : ls.length); li++) headerTexts.add(ls[li].text);
  }
  // שורה עם תבליט היא ליקוי, גם אם מיד אחרי המקף כתוב "מתקן מס' 111"
  const isRunningHeader = (s) => headerTexts.has(s)
    || (!BULLET.test(s) && RUNNING_HEADER.some(re => re.exec(s)?.index === 0));

  const out = [];
  const raw = [];
  const after = [];
  const inline = headingRemainder(headText, sec.re);
  if (inline) { out.push({ text: inline, y: startLine.y, page: sec.pi }); raw.push(inline); }
  let lastNo = null;
  let crossed = false;
  let endKind = null;
  let endText = null;
  for (let pi = sec.pi; pi < reportPages.length && !endKind; pi++) {
    const lines = reportPages[pi].lines;
    let leading = pi > sec.pi;
    for (let li = pi === sec.pi ? sec.li + 1 : 0; li < lines.length; li++) {
      const l = lines[li];
      const text = textOf(l);
      if (text == null) continue;
      if (PAGE_MARK.test(l.text) || (leading && isRunningHeader(l.text))) {
        raw.push({ text: l.text, skipped: true });
        if (pi > sec.pi) crossed = true;
        continue;
      }
      leading = false;
      endKind = endKindOf(text, headNo, lastNo);
      if (endKind) {
        endText = text;
        for (let k = li; k < lines.length; k++) {
          const t = textOf(lines[k]);
          if (t != null) after.push({ text: t, end: k === li });
        }
        break;
      }
      if (pi > sec.pi) crossed = true;
      out.push({ text, y: l.y, page: pi });
      raw.push(text);
      const no = ITEM_NO.exec(text);
      if (no) lastNo = +no[1];
    }
  }
  return { lines: out, raw, crossed, ended: !!endKind, endKind, endText, after, colLeft };
}

// מקטע הליקויים של הבלוק האחרון נמצא ולא נסגר — הרשימה ממשיכה בעמוד הבא.
function sectionOpen(reportPages) {
  const blocks = splitBlocks(reportPages);
  const last = blocks[blocks.length - 1];
  const sec = findSection(last);
  return !!sec && !sectionLines(last, sec).ended;
}

function splitDefects(lines) {
  let deadlineDays = null;
  const body = [];
  for (const l of lines) {
    const b = BOILERPLATE.exec(l.text);
    if (b) { deadlineDays = +b[1]; continue; }
    body.push(l);
  }
  const negatives = body.filter(l => NONE_LINE.test(l.text));
  const content = body.filter(l => !NONE_LINE.test(l.text));
  const anyBullet = content.some(l => BULLET.test(l.text) && !TAIL_ONLY.test(l.text));
  const gaps = content.slice(1).map((l, i) => content[i].y - l.y).filter(g => g > 0).sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
  const items = [];
  content.forEach((l, i) => {
    const prev = content[i - 1];
    let starts;
    if (anyBullet) starts = BULLET.test(l.text) && !TAIL_ONLY.test(l.text);
    else starts = !prev || /[.;]\s*$/.test(prev.text) || (prev.page === l.page && prev.y - l.y > 1.6 * typical);
    if (starts || !items.length) items.push(anyBullet ? l.text.replace(BULLET, '') : l.text);
    else items[items.length - 1] += ' ' + l.text;
  });
  const defects = items
    .map(t => fixParens(t.replace(/\s+/g, ' ').trim()).replace(/[\s:,]+$/, '').trim())
    .filter(Boolean);
  return { defects, negatives: negatives.length, deadlineDays };
}

// ── 6. רמז לבדיקה חוזרת ─────────────────────────────────────────────────────

// ⚠️ רמז בלבד — לעולם לא בוחר את סוג התסקיר בעצמו. המנהל רואה "נראה כמו
// בדיקה חוזרת" ומחליט.
// ⚠️ שני התסקירים האמיתיים (שניהם תקופתיים!) מכילים את המילים: "לדווח
// לבודק לצורך בדיקה חוזרת" בנוסח הקבוע, ו"לתיקון הליקויים" בכותרת סעיף 10
// של נוסח א'. ביטוי תמים היה מסמן *כל* תסקיר כחוזר — רמז שתמיד דולק לא
// אומר כלום.
// ⚠️ לכן נקרא רק *אזור הכותרת* — מה שלפני כותרת מקטע הליקויים. מה שאחריה
// מדבר על העתיד: "מסקנה: אין התנגדות … לאחר תיקון הליקויים", "יש להזמין
// בדיקה חוזרת" — וזה כתוב כמעט בכל תסקיר תקופתי שיש בו ליקויים. ניסיון
// לסנן לפי המילה שלפני ("לאחר", "להזמין") נכשל על הכותרת "בדיקה לאחר תיקון
// ליקויים", שבה אותה מילה מתארת דווקא את הבדיקה הזו. המחיר: חוזרת שאומרת
// זאת רק במסקנות לא תסומן — רמז שחסר עדיף על רמז שדולק על כל תסקיר.
// בתוך אזור הכותרת עדיין: לא אחרי "לצורך"/"לשם", ולא צמוד לאות עברית (ל-, ש-).
// בלי מקטע — כל השורות (no_section ממילא קריטית).
// מה שלפני ההתאמה נבדק בקוד ולא ב-lookbehind (ראו DATE_RE — Safari < 16.4).
const FOLLOWUP_WORDS = /[בהו]{0,2}(?:בדיקה|ביקורת)\s+ה?חוזרת|[בהו]{0,2}תיקון\s+ה?ליקו(?:י)?ים/g;
const NOT_THIS_CHECK = /(?:לצורך|לשם)\s+$/;

function mentionsFollowup(text) {
  for (const m of text.matchAll(FOLLOWUP_WORDS)) {
    const before = text.slice(0, m.index);
    if (/[א-ת]$/.test(before) || NOT_THIS_CHECK.test(before)) continue;
    return true;
  }
  return false;
}

function followupHint(reportPages, sec) {
  const zone = sec
    ? reportPages.slice(0, sec.pi + 1).flatMap((p, pi) => (pi === sec.pi ? p.lines.slice(0, sec.li) : p.lines))
    : reportPages.flatMap(p => p.lines);
  return zone.some(l => mentionsFollowup(l.text)) ? 'followup' : null;
}

// ── 7. תסקיר אחד ────────────────────────────────────────────────────────────

const CRITICAL = ['no_text_layer', 'no_section', 'no_validity', 'no_inspected', 'no_report_page', 'multiple_reports'];
const SOFT = ['empty_section', 'section_unterminated', 'inspected_mismatch', 'valid_next_differ',
  'validity_before_inspection', 'none_and_defects', 'no_inspector', 'soft_section_end', 'section_spans_pages',
  // תאריך שהוצע בלי תווית — לעולם לא 'high', כדי שהבאנר יבקש לבדוק מול המסמך
  'validity_guessed'];
const severityOf = (code) => (CRITICAL.includes(code) ? 'critical' : SOFT.includes(code) ? 'warning' : 'info');

function parseBlock(reportPages, opts) {
  const notes = [];
  const note = (code, he) => notes.push({ code, he });
  const lines = reportPages.flatMap(p => p.lines);

  // תאריכים
  const inspected = findLabeledDate(lines, INSPECTED_LABELS);
  const confirmDay = findLabeledDate(lines, [INSPECTED_LABELS[1]]);
  // ⚠️ "תאריך הבחינה" של *כל* עמוד, לא רק הראשון: בלוק שלא פוצל (אותו מספר
  // תסקיר, או עמוד שאינו נראה כראש תסקיר) ובו שני תאריכי בחינה — אסור שייצא
  // 'high' עם התאריך של העמוד הראשון בלבד.
  const dates = [...new Set([
    ...reportPages.map(p => findLabeledDate(p.lines, [INSPECTED_LABELS[0]])?.iso),
    confirmDay?.iso,
  ].filter(Boolean))];
  if (inspected && dates.length > 1) {
    note('inspected_mismatch', `${dates.length === 2 ? 'שני ' : ''}תאריכי בדיקה שונים במסמך: ${dates.join(' מול ')}.`);
  }
  const valid = findLabeledDate(lines, [VALID_LABEL]);
  const next = findLabeledDate(lines, NEXT_LABELS);

  // ⚠️ 'document' ולא 'explicit': זה השם שהשרת מכיר (inspection_upload, D25 —
  // 'document' | 'next_inspection'). ערך שהשרת לא מכיר נרשם שם כ-'manual',
  // כלומר תאריך שנקרא מהמסמך היה מוצג כאילו הוקלד ביד.
  let validUntil = valid?.iso ?? null;
  let validitySource = valid ? 'document' : null;
  if (!validUntil && next) {
    validUntil = next.iso;
    validitySource = 'next_inspection';
    note('validity_from_next', 'אין "בתוקף עד" — התוקף נלקח מ"בדיקה הבאה".');
  }
  if (valid && next && valid.iso !== next.iso) {
    note('valid_next_differ', `"בתוקף עד" (${valid.iso}) שונה מ"בדיקה הבאה" (${next.iso}). נלקח המוקדם.`);
    if (next.iso < valid.iso) { validUntil = next.iso; validitySource = 'next_inspection'; }
  }
  // ⚠️ גיבוי — רק כשאין תווית בכלל. ההצעה נוסעת ב-validityGuess ולא ב-validUntil:
  // validUntil הוא "מה שהמסמך קבע", והשרת גוזר ממנו את מקור התוקף. ניחוש שהיה
  // נכנס לשם היה נרשם "מהמסמך"; כך הוא מגיע לשרת כתאריך שהמנהל אישר ("ידני").
  let validityGuess = null;
  if (!validUntil) {
    const g = guessValidity(lines, inspected?.iso);
    if (g?.iso) {
      validityGuess = g;
      note('validity_guessed', `לא נמצאה במסמך תווית "בדיקה הבאה" או "בתוקף עד". התאריך היחיד במסמך שאחרי תאריך הבדיקה הוא ${ilDate(g.iso)} — הוא הוצע כתאריך הבדיקה הבאה. לוודא מול המסמך.`);
    } else {
      note('no_validity', 'לא נמצא תאריך תוקף במסמך. חובה להזין ידנית — אין ברירת מחדל של שנה.');
      if (g) {
        validityGuess = g;
        note('validity_candidates', `במסמך כמה תאריכים אחרי תאריך הבדיקה (${g.candidates.map(ilDate).join(", ")}) — לבחור את הנכון.`);
      }
    }
  }
  if (!inspected) note('no_inspected', 'לא נמצא תאריך בדיקה.');
  if (inspected && validUntil && validUntil <= inspected.iso) {
    note('validity_before_inspection', 'תאריך התוקף אינו אחרי תאריך הבדיקה.');
  }
  let validityMonths = null;
  if (inspected && validUntil) {
    const [y1, m1] = inspected.iso.split('-').map(Number);
    const [y2, m2] = validUntil.split('-').map(Number);
    validityMonths = (y2 - y1) * 12 + (m2 - m1);
    if (validityMonths !== 12) note('validity_not_12', `תוקף של ${validityMonths} חודשים (לא שנה) — כך כתוב במסמך.`);
  }

  // מזהים
  const reportNumber = firstMatch(lines, REPORT_NO_RES);
  const machineNo = firstMatch(lines, MACHINE_NO_RES);
  const inspectorLicense = firstMatch(lines, [/מספר\s+רשיון(?:\s+ה?בודק)?\s*[:\-]?\s*(\d+)/]);
  const siteAddress = firstMatch(lines, [/(?:מקום\s+הבדיקה|(?:^|\s)הכתובת|כתובת\s+המתקן)\s*:?\s*(.+)$/]);

  let inspectorName = null;
  // "אני, ישראל דוגמה, מהנדס…" — הפסיק אחרי "אני" (כמו ב-SOFT_END); ו"הח"מ"
  // (החתום מטה) הוא תואר ולא שם, אחרת "אני, הח"מ, …" היה מחזיר את "הח"מ".
  for (const l of lines) {
    const m = /(?:^|\s)אני\s*[:,]?\s+(.+)$/.exec(l.text);
    if (!m) continue;
    let rest = m[1];
    let prevRest;
    do {
      prevRest = rest;
      rest = rest.replace(/^(?:ה?מהנדס(?:ת)?|אינג['׳]?|ד["״]ר|הח["״]מ|ה?בודק(?:ת)?\s+(?:ה)?מוסמכ(?:ת)?|ה?בודק(?:ת)?|מוסמך)[\s,]+/, '');
    } while (rest !== prevRest);
    rest = rest.split(/\s+[-–]\s+|\s+מס(?:פר|['׳])\s*רשיון|\s+רשיון|\s+ת\.?ז|\s+שכתובתי|,|\s+\d/)[0].trim();
    if (HEB.test(rest) && rest.split(' ').length <= 4) { inspectorName = rest; break; }
  }
  if (!inspectorName) note('no_inspector', 'שם הבודק לא זוהה.');

  // ליקויים
  const sec = findSection(reportPages);
  let defects = [];
  let defaultDeadlineDays = null;
  let noDefects = null;
  let section = null;
  if (!sec) {
    note('no_section', 'מקטע הליקויים לא נמצא. יש להזין ליקויים ידנית.');
  } else {
    const sl = sectionLines(reportPages, sec);
    const sp = splitDefects(sl.lines);
    defects = sp.defects;
    // בנוסח ב' המשפט "(תוך 45 יום אם לא צויין אחרת)" יושב בכותרת הסעיף עצמה, לא בשורת גוף
    const headDeadline = DEADLINE_PHRASE.exec(reportPages[sec.pi].lines[sec.li].text);
    defaultDeadlineDays = sp.deadlineDays ?? (headDeadline ? +headDeadline[1] : null);
    if (defects.length) noDefects = false;
    else if (sp.negatives) noDefects = true;
    else note('empty_section', 'מקטע הליקויים ריק — לא כתוב "אין". לאשר ידנית שהתסקיר נקי.');
    if (!sl.ended) note('section_unterminated', 'סוף מקטע הליקויים לא זוהה — ייתכן שנאספו שורות מיותרות.');
    if (sl.endKind === 'soft') {
      const head = sl.endText.length > 40 ? `${sl.endText.slice(0, 40)}…` : sl.endText;
      note('soft_section_end', `מקטע הליקויים נגמר ב"${head}" ולא בכותרת סעיף — לוודא שאף ליקוי לא נחתך ושלא נדבקה אליו הצהרה.`);
    }
    if (defects.length && sp.negatives) note('none_and_defects', 'במקטע יש גם "אין" וגם ליקויים.');
    // ליקוי שנחצה בין עמודים מחובר כאן לפי ניחוש, וכותרת עמוד שלא זוהתה
    // נדבקת אליו — לכן גם כשהכול נראה תקין, המעלה מתבקש להסתכל.
    if (sl.crossed) note('section_spans_pages', 'מקטע הליקויים נמשך ליותר מעמוד אחד — לוודא שליקוי שנחצה בין העמודים חובר נכון ושלא נדבקה אליו כותרת העמוד.');
    // ⚠️ שורות המקטע נשארות מחרוזות (כמו קודם); השורות שאחרי הסוף הן
    // אובייקטים {text, after:true}, ושורות כותרת-עמוד שדולגו — {text, skipped:true}.
    // צרכן ישן שמצפה למחרוזות לא נשבר על הגוף.
    section = { fmt: sec.fmt, page: reportPages[sec.pi].page, twoColumn: Number.isFinite(sl.colLeft),
      rawLines: opts.debug
        ? [...sl.raw, ...sl.after.map(a => (a.end ? { text: a.text, after: true, end: true } : { text: a.text, after: true }))]
        : undefined };
  }
  const defectsDetail = defects.map(text => ({ text, urgent: URGENT.test(text) }));

  return {
    notes,
    fields: {
      inspectedAt: inspected?.iso ?? null,
      validUntil,
      nextInspection: next?.iso ?? null,
      validitySource,
      // {iso, candidates} — רק כשאין תווית. iso רק כשיש מועמד יחיד.
      validityGuess,
      validityMonths,
      reportNumber,
      machineNo,
      inspectorName,
      inspectorLicense,
      siteAddress,
      defects,
      defectsDetail,
      defaultDeadlineDays,
      noDefects,
      section,
      kindHint: followupHint(reportPages, sec),
      reportPages: reportPages.map(p => p.page),
    },
  };
}

// ── 8. הראשית ───────────────────────────────────────────────────────────────

// ── כל התאריכים במסמך — בלי תוויות ──────────────────────────────────────────
// ⚠️ זה מה שטופס ההעלאה משתמש בו (05/10/2026). בעלת המוצר: "אני לא סומכת על
// כך, כיון שיתכנו ניסוחים רבים — אני רוצה שתחלץ רק תאריכים". חיפוש לפי תוויות
// ("בתוקף עד", "מאשר כי ביום"…) עובד רק על ניסוח שמישהו כבר ראה; תאריך הוא
// תאריך בכל ניסוח. כאן אין שום החלטה מה כל תאריך *אומר* — רק אילו תאריכים
// כתובים, וכמה פעמים. הבחירה מה הבדיקה הבאה ומה תאריך הבדיקה נעשית בטופס,
// כהצעה שאדם מאשר מול המסמך.
//
// אותה בניית שורות כמו בפענוח המלא (normItem + groupLines): בלעדיה תאריך
// שה-PDF פיצל לחתיכות ("16" "/" "03" "/" "20" "2" "7") לא היה נקרא כלל.
//
// opts.pages — רק העמודים האלה (בלוק אחד מתוך קובץ עם כמה תסקירים).
// מחזיר: { noText, dates: [{ iso, count }] } — מהמאוחר למוקדם.
export function extractDates(pages, opts = {}) {
  const want = opts.pages != null ? new Set([].concat(opts.pages).map(Number)) : null;
  const counts = new Map();
  let chars = 0;
  pages.forEach((p, i) => {
    if (want && !want.has(i + 1)) return;
    const lines = groupLines((p.items || []).map(normItem).filter(Boolean));
    for (const l of lines) {
      chars += l.text.replace(/\s/g, '').length;
      for (const m of l.text.matchAll(DATE_RE_G)) {
        const iso = parseDate(m[0]);
        if (iso) counts.set(iso, (counts.get(iso) ?? 0) + 1);
      }
    }
  });
  const dates = [...counts].map(([iso, count]) => ({ iso, count })).sort((a, b) => b.iso.localeCompare(a.iso));
  return { noText: chars < 30, dates };
}

// ── הצעה: איזה תאריך הוא הבדיקה הבאה ואיזה תאריך הבדיקה ──────────────────
// רק יחסים בין תאריכים, בלי מילה אחת מהמסמך:
//   1. זוג שבו המאוחר הוא **בדיוק** מספר שלם של חודשים (1–24) אחרי המוקדם —
//      תוקף של תסקיר הוא 6 או 12 חודשים מיום הבדיקה. מכמה זוגות כאלה — זה
//      שהמאוחר בו הכי מאוחר (זוג "בדיקה קודמת → בדיקה זו" נדחה מפני
//      "בדיקה זו → הבאה").
//   2. אין זוג כזה — המאוחר במסמך, והתאריך שלפניו.
// ⚠️ למה לא פשוט "המאוחר והשני": בנוסח א' כתובים תאריך הבדיקה וגם,
// שבוע אחריו, יום החתימה. השני-במאוחר היה יום החתימה — שבוע שגוי, שמזיז
// את מועד התיקון של כל ליקוי. הכלל של החודשים מצא את תאריך הבדיקה בשני המסמכים
// האמיתיים (6 חודשים בנוסח ב', 12 בנוסח א').
// ⚠️ זו הצעה בלבד: הטופס מציג את כל התאריכים כבחירה, ואדם מאשר.
// dates — [{iso}] או מחרוזות ISO, בכל סדר. מחזיר { next, inspected, rule } או null.
function addMonthsClamp(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
export function suggestInspectionDates(dates) {
  const list = [...new Set((dates || []).map((x) => (typeof x === 'string' ? x : x?.iso)).filter(Boolean))].sort().reverse();
  if (!list.length) return null;
  for (const later of list) {
    for (const earlier of list) {
      if (earlier >= later) continue;
      for (let k = 1; k <= 24; k++) {
        if (addMonthsClamp(earlier, k) === later) return { next: later, inspected: earlier, rule: 'months', months: k };
      }
    }
  }
  return { next: list[0], inspected: list[1] ?? null, rule: 'latest', months: null };
}

export function parseInspectionReport(pages, opts = {}) {
  const withSeverity = (list) => list.map(n => ({ ...n, severity: severityOf(n.code) }));

  const prepared = pages.map((p, i) => {
    const items = (p.items || []).map(normItem).filter(Boolean);
    const lines = groupLines(items);
    const text = lines.map(l => l.text).join('\n');
    return { page: i + 1, items, lines, text, cls: classifyPage(text) };
  });

  // בלוק נבחר (reports[i].pages). מספרי העמודים נשארים המקוריים — התצוגה
  // המקדימה מציירת את section.page מתוך הקובץ השלם.
  let chosen = prepared;
  if (opts.pages != null) {
    const want = new Set([].concat(opts.pages).map(Number));
    chosen = prepared.filter(p => want.has(p.page));
    if (!chosen.length) throw new RangeError(`opts.pages: אין אף עמוד קיים מתוך ${[...want].join(',')} (בקובץ ${pages.length} עמודים)`);
  }

  const chars = chosen.reduce((n, p) => n + p.text.replace(/\s/g, '').length, 0);
  if (chars < 30) {
    return { noText: true, pages: pages.length,
      notes: withSeverity([{ code: 'no_text_layer', he: 'לקובץ אין שכבת טקסט (סריקה). יש להזין תאריכים וליקויים ידנית.' }]) };
  }

  const notes = [];
  // ⚠️ עמוד שכולו המשך רשימת הליקויים אין בו סימני תסקיר (שניים נדרשים), ולכן
  // סווג 'not_a_report' ונזרק: המקטע קפץ מעמוד 1 לעמוד 3, והליקויים שבאמצע
  // נעלמו בביטחון 'high' — והמסך מציג מ-ignoredPages רק חשבוניות. עמוד כזה
  // שיושב *בין* עמודי תסקיר הוא חלק מהתסקיר. חשבונית — לא, גם באמצע.
  const reasonOf = (p) => (p.cls.inv > p.cls.r ? 'invoice' : 'not_a_report');
  let firstR = -1;
  let lastR = -1;
  chosen.forEach((p, i) => { if (p.cls.report) { if (firstR < 0) firstR = i; lastR = i; } });
  const inReport = chosen.map((p, i) => p.cls.report || (i > firstR && i < lastR && reasonOf(p) === 'not_a_report'));
  // ⚠️ ואותו דבר *אחרי* עמוד התסקיר האחרון, כל עוד מקטע הליקויים פתוח בסופו:
  // העמוד האחרון של רשימה ארוכה ("- לתקן את השער", "5. הערות") הוא בדיוק
  // עמוד כזה. רק עמוד בלי שום סימן חשבונית.
  for (let i = lastR + 1; lastR >= 0 && i < chosen.length && chosen[i].cls.inv === 0; i++) {
    if (!sectionOpen(chosen.filter((p, j) => inReport[j]))) break;
    inReport[i] = true;
  }
  let reportPages = chosen.filter((p, i) => inReport[i]);
  const ignoredPages = chosen.filter((p, i) => !inReport[i]).map(p => ({ page: p.page, reason: reasonOf(p) }));
  let skippedNote = null;
  if (!reportPages.length) {
    reportPages = chosen;
    ignoredPages.length = 0;
    notes.push({ code: 'no_report_page', he: 'לא זוהה עמוד תסקיר — הקובץ נסרק כולו. לבדוק שזה אכן תסקיר.' });
  } else {
    // מה שנשאר בחוץ (מכתב נלווה לפני, נספח אחרי) — נאמר במפורש, כדי שעמוד
    // שנזרק לא ייעלם בשקט. מידע בלבד: אינו מוריד את הביטחון.
    const skipped = ignoredPages.filter(x => x.reason === 'not_a_report').map(x => x.page);
    if (skipped.length) {
      skippedNote = { code: 'page_skipped', he: skipped.length > 1
        ? `עמודים ${skipped.join(', ')} לא זוהו כחלק מהתסקיר ולא נקראו — לוודא שאין בהם ליקויים.`
        : `עמוד ${skipped[0]} לא זוהה כחלק מהתסקיר ולא נקרא — לוודא שאין בו ליקויים.` };
    }
  }

  const blocks = splitBlocks(reportPages).map(b => parseBlock(b, opts));
  const reports = blocks.map(b => ({
    pages: b.fields.reportPages,
    machineNo: b.fields.machineNo,
    reportNumber: b.fields.reportNumber,
    inspectedAt: b.fields.inspectedAt,
    validUntil: b.fields.validUntil,
    kindHint: b.fields.kindHint,
  }));
  if (blocks.length > 1) {
    const list = reports.map((r, i) => `${i + 1}: מתקן ${r.machineNo ?? '?'}, עמודים ${r.pages.join(',')}`).join(' · ');
    notes.push({ code: 'multiple_reports',
      he: `הקובץ מכיל ${blocks.length} תסקירים (${list}) — יש להעלות כל אחד בנפרד. הפרטים שלמטה הם של הראשון בלבד.` });
  }

  // ⚠️ בקובץ עם כמה תסקירים, השדות העליונים הם של הבלוק *הראשון* — לא מיזוג.
  // מיזוג היה לוקח תאריך מאחד וליקויים משני, ונראה כמו תסקיר שלם. צרכן
  // שמתעלם מ-reports מקבל לפחות תסקיר אחד עקבי, ו-confidence 'low'.
  const main = blocks[0];
  notes.push(...main.notes);
  if (skippedNote) notes.push(skippedNote);
  const confidence = notes.some(n => CRITICAL.includes(n.code)) ? 'low'
    : notes.some(n => SOFT.includes(n.code)) ? 'medium' : 'high';

  const { kindHint, reportPages: mainPages, ...fields } = main.fields;
  return {
    noText: false,
    ...fields,
    kindHint,
    reportPages: mainPages,
    ignoredPages,
    reports,
    confidence,
    notes: withSeverity(notes),
    ...(opts.debug ? { lines: chosen.map(p => ({ page: p.page, lines: p.lines.map(l => `${l.y.toFixed(1)}  ${l.text}`) })) } : {}),
  };
}
