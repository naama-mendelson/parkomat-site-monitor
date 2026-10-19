// tests/service-calls-ui.test.js — קריאות ויזנט בדשבורד: הפונקציות הטהורות, והכלל "כבוי עד שהרשימות נטענות".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const U = pathToFileURL(path.join(__dirname, "../../dashboard/src/utils/serviceCalls.js")).href;
const P = pathToFileURL(path.join(__dirname, "../../dashboard/src/utils/sitePatch.js")).href;

// ⚠️ 14/10/2026: הרשימות נטענו, עשרה סטטוסים סומנו כסגורים וויזנט הדליקו את השליחה — ההצגה דולקת
// כברירת מחדל. ⚠️ 15/10/2026: גם העדכון **חזרה** דולק — דרך הממסר (מחשבי אתרים בישראל), אחרי בדיקה חיה.
// Pages בונה בלי משתני סביבה, ולכן ברירת המחדל היא מה שרץ באתר החי — והיא נבדקת כאן.
test("⚠️ ברירות המחדל: ההצגה דולקת, והעדכון לוויזנט דולק (דרך הממסר)", async () => {
  const { SERVICE_CALLS_ENABLED, SERVICE_CALLS_WRITE } = await import(U);
  assert.equal(SERVICE_CALLS_ENABLED, true);
  assert.equal(SERVICE_CALLS_WRITE, true);
});

test("countsBySite — לפי site_id, מחבר שורות, מתעלם משורה בלי אתר", async () => {
  const { countsBySite } = await import(U);
  assert.deepEqual(countsBySite([{ site_id: 7, open: 2, recent: 2 }, { site_id: 9, open: "1", recent: "3" },
    { site_id: null, open: 5, recent: 5 }, { site_id: 7, open: 1, recent: 4 }]),
    { 7: { open: 3, recent: 6, oldestOpen: null, age: 0, ageHours: 0 }, 9: { open: 1, recent: 3, oldestOpen: null, age: 0, ageHours: 0 } });
  // ⚠️ מסד ישן אינו מחזיר recent/oldest_open — הכרטיס חוזר להתנהגות הקודמת ולא נשבר
  assert.deepEqual(countsBySite([{ site_id: 7, open: 2 }]), { 7: { open: 2, recent: 0, oldestOpen: null, age: 0, ageHours: 0 } });
  // ⚠️ הסטופר מתחיל מהוותיקה ביותר, גם כששתי שורות הגיעו לאותו אתר
  assert.equal(countsBySite([{ site_id: 7, open: 1, oldest_open: "2026-10-14T09:00:00Z" },
    { site_id: 7, open: 1, oldest_open: "2026-10-14T05:00:00Z" }])[7].oldestOpen, "2026-10-14T05:00:00Z");
  assert.equal(countsBySite([{ site_id: 7, open: 1, oldest_open: "2026-10-14T09:00:00Z" },
    { site_id: 7, open: 0, oldest_open: null }])[7].oldestOpen, "2026-10-14T09:00:00Z", "NULL אינו מוחק זמן קיים");
  assert.deepEqual(countsBySite(null), {});
});

// ⚠️ ויזנט שולחים שעון ישראל עם סיומת Z (נמדד 14/10/2026: updated_at שנייה לפני ההגעה אלינו, ומסומן
// שלוש שעות קדימה). המרה הציגה שעה שעוד לא הגיעה.
test("⚠️ זמן מוויזנט מוצג כמו שנכתב; זמן שלנו מומר לשעון ישראל", async () => {
  const { openedLabel, wizenetLabel, israelLabel } = await import(U);
  assert.equal(wizenetLabel("2026-10-14T12:40:46Z"), "14/10 12:40", "בלי להוסיף שלוש שעות");
  assert.equal(openedLabel({ opened_at: "2026-10-14T12:40:46Z", received_at: "2026-10-14T09:40:47.000Z" }), "14/10 12:40");
  assert.equal(openedLabel({ received_at: "2026-10-14T09:40:47.000Z" }), "14/10 12:40", "בלי opened_at — שעת ההגעה שלנו, מומרת");
  assert.equal(israelLabel("2026-10-14T09:40:47.000Z"), "14/10 12:40");
  assert.equal(wizenetLabel("לא תאריך"), "לא תאריך");
  assert.equal(wizenetLabel(null), "");
});

// ניקוי הטקסט שוויזנט שולחים: HTML, ישויות, והטלפון שחוזר בתוך ההערות
test("cleanText / callText — בלי תגיות, בלי כפילות הטלפון, בלי 'ללא נושא'", async () => {
  const { cleanText, callText, parkingDetail, callsSummary } = await import(U);
  assert.equal(cleanText("0547721538<br />\r\n&nbsp;"), "0547721538");
  assert.equal(cleanText("א<br>ב<br />ג"), "א · ב · ג");
  assert.deepEqual(callText({ phone: "0547721538", complaint: "מבקשת עדכון", notes: "0547721538<br />\r\n&nbsp;" }),
    ["מבקשת עדכון"], "ההערות היו רק הטלפון — יורדות");
  assert.deepEqual(callText({ phone: "0532431800", complaint: "המתקן לא מגיב", notes: "0532431800<br />\r\nהחניה לא נפתחת" }),
    ["המתקן לא מגיב", "החניה לא נפתחת"]);
  assert.deepEqual(callText({ phone: "0547888542", complaint: "3461", notes: "0547888542~~~3461" }), [],
    "קוד וטלפון בלבד — אין מה להציג");
  assert.deepEqual(callText({ complaint: "ללא נושא", notes: "ישנה בעייה שחוזרת<br />\r\n0522327090", phone: "0522327090" }),
    ["ישנה בעייה שחוזרת"]);
  assert.equal(parkingDetail({ parking_code: "3452" }), "", "קוד הפרויקט לבדו — כבר כתוב כקוד האתר");
  assert.equal(parkingDetail({ parking_code: "1226-1-02" }), "1226-1-02");
  assert.equal(callsSummary([{ open: true }]), "קריאה אחת · פתוחה אחת");
  assert.equal(callsSummary([{ open: false }, { open: false }]), "2 קריאות · אין פתוחות");
  assert.equal(callsSummary([{ open: true }, { open: false }, { open: false }]), "3 קריאות · פתוחה אחת");
  // ⚠️ 15/10/2026: פתוחה ישנה (in_window = false) נספרת ב"פתוחות" ולא ב"קריאות" — כמו המספרים על האריח
  assert.equal(callsSummary([{ open: true, in_window: false }, { open: true }, { open: false }]), "2 קריאות · 2 פתוחות");
  assert.equal(callsSummary([{ open: true, in_window: false }]), "אין קריאות · פתוחה אחת", "בוקר שקט, פתוחה מאתמול");
  assert.equal(callsSummary([{ open: false, in_window: true }, { open: true, in_window: true }]), "2 קריאות · פתוחה אחת");
  assert.equal(callsSummary([]), "אין קריאות · אין פתוחות");
});

// ⚠️ 15/10/2026: מהכרטיס — פתוחות בלבד, ו"להיסטוריה" — אלה שנסגרו. הכותרת אומרת על איזו רשימה מסתכלים.
test("siteCallsSummary — פתוחות סופרות את הרשימה; היסטוריה סופרת את הכול (total), לא רק מה שהוצג", async () => {
  const { siteCallsSummary } = await import(U);
  assert.equal(siteCallsSummary("open", []), "אין קריאות פתוחות");
  assert.equal(siteCallsSummary("open", [{}]), "קריאה פתוחה אחת");
  assert.equal(siteCallsSummary("open", [{}, {}, {}]), "3 קריאות פתוחות");
  assert.equal(siteCallsSummary("history", [], 0), "אין קריאות שנסגרו");
  assert.equal(siteCallsSummary("history", [{}], 1), "קריאה אחת שנסגרה");
  assert.equal(siteCallsSummary("history", new Array(100).fill({}), 240), "240 קריאות שנסגרו",
    "100 מוצגות מתוך 240 — הכותרת אומרת 240");
  assert.equal(siteCallsSummary("history", [{}, {}], null), "2 קריאות שנסגרו", "בלי total — לפי הרשימה");
});

// ⚠️ שורה שנעלמת אחרי שינוי — נאמרת. ובשורה מאוחדת לא נאמר "עברה להיסטוריה": השינוי נשלח על מספר אחד בלבד.
test("movedNote — לאן הקריאה עברה; בשורה מאוחדת רק 'נסגרה'", async () => {
  const { movedNote } = await import(U);
  assert.equal(movedNote({ ticket: "77", dup_n: 1 }, "open"), "קריאה 77 נסגרה ועברה להיסטוריה");
  assert.equal(movedNote({ ticket: "77" }, "open"), "קריאה 77 נסגרה ועברה להיסטוריה", "מסד ישן בלי dup_n");
  assert.equal(movedNote({ ticket: "77", dup_n: 3 }, "open"), "קריאה 77 נסגרה");
  assert.equal(movedNote({ ticket: "77", dup_n: "3" }, "open"), "קריאה 77 נסגרה", "מגיע כמחרוזת מ-jsonb");
  assert.equal(movedNote({ ticket: "77", dup_n: 3 }, "history"), "קריאה 77 נפתחה מחדש ועברה לקריאות הפתוחות");
  assert.match(movedNote({ ticket: "77" }, "recent"), /^קריאה 77 נסגרה ויצאה מהרשימה/);
  assert.equal(movedNote({ ticket: "77", dup_n: 2 }, "recent"), "קריאה 77 נסגרה");
});

test("callerName / openedLabel — שם מלא או '—'; זמן בשעון ישראל; טקסט שאינו תאריך — כמו שהוא; בלי — שעת ההגעה", async () => {
  const { callerName, openedLabel } = await import(U);
  assert.equal(callerName({ first_name: " דנה ", last_name: "כהן" }), "דנה כהן");
  assert.equal(callerName({ first_name: "", last_name: null }), "—");
  // ⚠️ מאז 14/10/2026 זמן מוויזנט מוצג כמו שנכתב — הם שולחים שעון ישראל עם סיומת Z
  assert.equal(openedLabel({ opened_at: "2026-10-13T06:42:00.000Z" }), "13/10 06:42");
  assert.equal(openedLabel({ opened_at: "13/10/2026 09:42" }), "13/10/2026 09:42");
  assert.equal(openedLabel({ received_at: "2026-01-15T10:05:00.000Z" }), "15/01 12:05");   // חורף, UTC+2
  assert.equal(openedLabel({}), "");
});

test("⚠️ optionsFor — הערך הנוכחי תמיד בבורר, גם כשאינו ברשימה (אחרת הבורר מציג את הראשון כאילו הוא הנוכחי)", async () => {
  const { optionsFor } = await import(U);
  const list = [{ id: 148, name: "פתוחה" }, { id: "151", name: "בטיפול" }];
  assert.deepEqual(optionsFor(list, "151", "בטיפול"), [{ id: "148", name: "פתוחה" }, { id: "151", name: "בטיפול" }]);
  assert.deepEqual(optionsFor(list, "777", null)[0], { id: "777", name: "לא מוכר (777)" });
  assert.deepEqual(optionsFor(list, "777", "שם מהמסד")[0], { id: "777", name: "שם מהמסד" });
  assert.equal(optionsFor(list, null).length, 2);
  assert.deepEqual(optionsFor([], "5", null), [{ id: "5", name: "לא מוכר (5)" }]);
});

test("אירוע service_calls אינו טוען מחדש את רשימת האתרים (App מרענן את הסימון והחלון בלבד)", async () => {
  const { needsRefetch } = await import(P);
  assert.equal(needsRefetch({ type: "service_calls", code: "1307", action: "received" }), false);
});

// ⚠️ האיחוד עצמו ב-SQL (S11/S12). כאן רק מה שהשורה אומרת — ושהיא **אומרת** ולא מעלימה בשקט.
test("dupInfo — שורה מאוחדת אומרת כמה; קריאה בודדת שקטה", async () => {
  const { dupInfo } = await import(U);
  assert.equal(dupInfo({ dup_n: 1 }), null);
  assert.equal(dupInfo({}), null, "מסד ישן בלי dup_n — בלי סימון");
  assert.equal(dupInfo({ dup_n: 0 }), null);
  assert.equal(dupInfo(null), null);
  const d = dupInfo({ dup_n: 8 });
  assert.equal(d.n, 8);
  assert.equal(d.mark, "×8");
  assert.match(d.title, /^8 קריאות זהות/);
  assert.equal(dupInfo({ dup_n: "4" }).mark, "×4", "מגיע כמחרוזת מ-jsonb");
});

test("קריאות פתוחות בכותרת (18/10/2026): לא לחוץ כברירת מחדל — הכול עובר; לחוץ — רק אתרים עם קריאה פתוחה", async () => {
  const { DEFAULT_SHOW_OPEN_CALLS, sanitizeShowOpenCalls, matchesOpenCallsView, countSitesWithOpenCalls } = await import(U);
  assert.equal(DEFAULT_SHOW_OPEN_CALLS, false);
  assert.equal(matchesOpenCallsView(undefined, false), true);
  assert.equal(matchesOpenCallsView({ open: 0, recent: 3 }, false), true);
  assert.equal(matchesOpenCallsView(undefined, true), false);
  assert.equal(matchesOpenCallsView({ open: 0, recent: 3 }, true), false);   // נסגרו היום — לא "פתוחה"
  assert.equal(matchesOpenCallsView({ open: 2, recent: 2 }, true), true);
  // רק true מפורש לוחץ — ערך שבור לא משאיר לוח מסונן
  assert.equal(sanitizeShowOpenCalls(true), true);
  assert.equal(sanitizeShowOpenCalls("true"), true);
  for (const v of [false, null, 1, "yes", {}]) assert.equal(sanitizeShowOpenCalls(v), false, String(v));
  const sites = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const bySite = { 1: { open: 2 }, 2: { open: 0, recent: 1 }, 9: { open: 4 } };   // 9 — לא בלוח
  assert.equal(countSitesWithOpenCalls(sites, bySite), 1);
  assert.equal(countSitesWithOpenCalls([], null), 0);
});

// ============================================================
// החמרה של קריאה פתוחה (19/10/2026) — השלב מה-SQL, כאן רק התרגום
// ============================================================
test("⚠️ החמרה: השלב מגיע מהמסד; הגבוה מבין השורות; ערך שבור — 0; לבן (0) בלי מחלקה", async () => {
  const { countsBySite, callAge, callAgeClass, callAgeText, CALL_AGE_MAX, CALL_AGE_LABEL } = await import(U);
  assert.equal(CALL_AGE_MAX, 4);
  assert.deepEqual(CALL_AGE_LABEL.slice(1), ["צהוב", "כתום", "אדום", "אדום כהה"]);
  const by = countsBySite([{ site_id: 7, open: 1, age: 3, age_hours: 3.2 }, { site_id: 7, open: 1, age: 1, age_hours: 1.5 }, { site_id: 9, open: 1 }]);   // הגבוה ראשון — כדי ש"האחרונה קובעת" לא תעבור במקרה
  assert.equal(by[7].age, 3, "הגבוה");
  assert.equal(by[7].ageHours, 3.2);
  assert.equal(by[9].age, 0, "מסד ישן בלי age — בלי צבע");
  for (const [v, want] of [[2, 2], ["3", 3], [9, 4], [-1, 0], [null, 0], [undefined, 0], ["x", 0], [2.9, 2]]) assert.equal(callAge(v), want, String(v));
  assert.equal(callAgeClass(0), "");
  assert.equal(callAgeClass(1), " call-age-1");
  assert.equal(callAgeClass(4), " call-age-4");
  assert.equal(callAgeClass(7), " call-age-4");
  assert.equal(callAgeText({ open: 1, ageHours: 3.2 }), "פתוחה 3.2 שעות שירות");
  assert.equal(callAgeText({ open: 1, ageHours: 2 }), "פתוחה 2 שעות שירות");
  assert.equal(callAgeText({ open: 1, ageHours: 37.6 }), "פתוחה 38 שעות שירות");
  assert.equal(callAgeText({ open: 1, ageHours: 0 }), "לא עברו שעות שירות מאז שנפתחה");
  assert.equal(callAgeText({ open: 0, ageHours: 5 }), "", "בלי פתוחה — בלי טקסט");
});

test("⚠️ החמרה בכרטיס: רק כש'קריאות פתוחות' לחוץ, ובשלושת סוגי הכרטיס", () => {
  const src = require("node:fs").readFileSync(path.join(__dirname, "../../dashboard/src/components/SiteCard/SiteCard.jsx"), "utf8");
  assert.match(src, /const ageCls = markOpen \? callAgeClass\(/, "הצבע אינו מותנה ב-markOpen (הלחיצה על האריח)");
  assert.equal((src.match(/has-open-call" : ""\}\$\{ageCls\}/g) || []).length, 3, "לא בכל שלושת הכרטיסים (מכווץ, פרוש, ללא בקר)");
});
