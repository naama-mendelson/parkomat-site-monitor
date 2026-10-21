// tests/tech-stats-ui.test.js — מה כרטיס הטכנאי מציג (utils/techStats.js, 21/10/2026): הקבוצה (באתר / בתנועה / חונה…),
// "איפה עכשיו", הסיכום של הצוות, ציר היום, עמודות השבוע, הביקורים, ו"צריכים טכנאי". ההחלטות במסד (vehicle-stats.test.js);
// כאן רק התרגום.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardGroup, groupCounts, groupLabel, sortCards, initials, hmText, hhmm, kmText, whereInfo, teamToday, timeline, minuteClock,
  weekBars, weekTotals, visitRows, alertRows, matchesCard,
} from "../../dashboard/src/utils/techStats.js";
import { durationLabel } from "../../dashboard/src/utils/vehicles.js";

const NOW = "2026-10-21T08:00:00Z";            // 11:00 בישראל (+3)
const ago = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const SITE = { site_id: 9, code: "1227", name: "הרצל 50, ת\"א", m: 40, approx: false };
const veh = (over = {}) => ({ plate: "1", name: "דני לוי 1", state: "parking", located_at: ago(2), lat: 32.07, lon: 34.79, near: [], ...over });

test("הקבוצה: עומד ליד אתר (חונה / מנוע דולק / השתתק) = באתר; נוסע — בתנועה; מנוע דולק — קבוצה משלו; השאר לפי המצב", () => {
  assert.equal(cardGroup(veh({ at_site: SITE }), NOW), "site");
  assert.equal(cardGroup(veh({ state: "idle", at_site: SITE }), NOW), "site");
  assert.equal(cardGroup(veh({ state: "silent", at_site: SITE }), NOW), "site");
  assert.equal(cardGroup(veh({ state: "driving", at_site: SITE }), NOW), "move", "המסד לא שולח at_site לנוסע — וגם אם כן, נוסע אינו באתר");
  assert.equal(cardGroup(veh({ state: "idle" }), NOW), "idle", "מנוע דולק אינו 'בתנועה' (בעלת המוצר, 21/10)");
  assert.equal(cardGroup(veh(), NOW), "park");
  assert.equal(cardGroup(veh({ state: "silent" }), NOW), "silent");
  assert.equal(cardGroup(veh({ state: "no_report" }), NOW), "stale");
  assert.equal(cardGroup(veh({ state: "weird" }), NOW), "unknown");
  const list = [veh({ plate: "a", name: "בני", state: "driving" }), veh({ plate: "b", name: "אבי", at_site: SITE }),
    veh({ plate: "c", name: "גל", state: "no_report" }), veh({ plate: "d", name: "דנה" }), veh({ plate: "e", name: "אורי", state: "driving" }),
    veh({ plate: "f", name: "זיו", state: "idle" })];
  assert.deepEqual(sortCards(list, NOW).map((v) => v.name), ["אבי", "אורי", "בני", "זיו", "דנה", "גל"], "מנוע דולק אחרי בתנועה, לפני חונים");
  assert.deepEqual(groupCounts(list, NOW), { site: 1, move: 2, idle: 1, park: 1, silent: 0, unknown: 0, stale: 1 });
  assert.deepEqual([groupLabel("idle", 1), groupLabel("idle", 3)], ["מנוע דולק", "עם מנוע דולק"]);
  assert.deepEqual([groupLabel("park", 1), groupLabel("park", 3), groupLabel("silent", 1), groupLabel("x", 2)], ["חונה", "חונים", "לא מתעדכן", ""]);
});

test("ראשי תיבות, משכים, ק\"מ", () => {
  assert.deepEqual([initials("דני לוי"), initials("ישראל"), initials("  "), initials("a b c")], ["דל", "י", "?", "AB"]);
  assert.deepEqual([hmText(0), hmText(2700), hmText(4500), hmText(-1), hmText("x")], ["0 דק׳", "45 דק׳", "1:15 שע׳", "—", "—"]);
  assert.deepEqual([hhmm(2700), hhmm(4500), hhmm(405_900), hhmm(null)], ["0:45", "1:15", "112:45", "—"]);
  assert.deepEqual([kmText(4.46), kmText(42.4), kmText(null), kmText(0)], ["4.5", "42", "—", "0"]);
  assert.deepEqual([durationLabel(ago(0.5), NOW), durationLabel(ago(35), NOW), durationLabel(ago(65), NOW), durationLabel(ago(60 * 26), NOW),
    durationLabel(ago(60 * 72), NOW), durationLabel(null, NOW)], ["פחות מדקה", "35 דק׳", "1:05 שע׳", "יום", "3 ימים", ""]);
});

test("איפה עכשיו: באתר מאיזו שעה וכמה זמן; משוער; אין קליטה; בנסיעה עם מהירות וליד; חונה — כמה רחוק מהאתר", () => {
  const visit = { code: "1227", name: SITE.name, since: ago(35), approx: false, no_signal: false };
  const s = whereInfo(veh({ at_site: SITE, stats: { visit } }), NOW);
  assert.deepEqual([s.group, s.title, s.code, s.sub], ["site", "באתר הרצל 50", "1227", ["מ-10:25 · 35 דק׳"]]);
  assert.equal(whereInfo(veh({ at_site: { ...SITE, approx: true } }), NOW).approx, true);
  // ביקור של אתר אחר (הסנכרון הבא עוד לא סגר אותו) — בלי "מ-"
  assert.deepEqual(whereInfo(veh({ at_site: SITE, stats: { visit: { ...visit, code: "999" } } }), NOW).sub, []);
  const silent = whereInfo(veh({ state: "silent", at_site: SITE, located_at: ago(20), stats: { visit } }), NOW);
  assert.ok(silent.noSignal && silent.sub.includes("אין קליטה מאז 10:40"), silent.sub);
  assert.deepEqual(whereInfo(veh({ state: "idle", at_site: SITE }), NOW).sub, ["מנוע דולק"]);
  const near = [{ code: "1227", name: SITE.name, m: 118, approx: false }];
  const d = whereInfo(veh({ state: "driving", speed: 54, address: "דרך בגין, תל אביב", near }), NOW);
  assert.deepEqual([d.title, d.sub], ["בנסיעה · 54 קמ\"ש", ["דרך בגין, תל אביב", "ליד הרצל 50 · 120 מ׳"]]);
  assert.equal(whereInfo(veh({ state: "driving", speed: 0 }), NOW).title, "בנסיעה", "מהירות 0 — בלי מספר");
  const p = whereInfo(veh({ state_since: ago(90), address: "הירקון 12, תל אביב", near: [{ ...near[0], m: 640, approx: true }] }), NOW);
  assert.deepEqual([p.title, p.sub], ["חונה מאז 09:30", ["הירקון 12, תל אביב", "כ-640 מ׳ מהרצל 50"]]);
  const st = whereInfo(veh({ state: "silent", located_at: ago(120), address: "חניון", near }), NOW);
  assert.deepEqual(st.sub, ["כתובת אחרונה: חניון", "ליד הרצל 50 · 120 מ׳"]);
});

test("הצוות היום: ק\"מ, זמן נסיעה, ביקורים, אתרים שונים, היציאה הראשונה; בלי נתונים — '—' ולא 0", () => {
  const t = (km, drive, first, codes) => ({ stats: { today: { km, drive_s: drive, first_move: first }, visits: codes.map((code) => ({ code })) } });
  const r = teamToday([t(12.6, 3600, ago(200), ["1", "2"]), t(30, 1800, ago(240), ["2"]), t(null, 0, null, []), {}]);
  assert.deepEqual(r, { km: 43, driveS: 5400, visits: 3, sites: 2, moved: 2, firstMove: ago(240) });
  assert.deepEqual(teamToday([{}]), { km: null, driveS: 0, visits: 0, sites: 0, moved: 0, firstMove: null });
});

test("ציר היום: חלון 06–22 שמתרחב לפעילות; חניה מחצות לא מותחת אותו; אחוזים, עכשיו, שעות", () => {
  const stats = (segments, now_min = 600, day_minutes = 1440) => ({ today: { segments }, day_start: "2026-10-20T21:00:00Z", day_minutes, now_min });
  const a = timeline(stats([["park", 0, 420, null], ["drive", 420, 480, null], ["site", 480, 540, "1227"], ["park", 540, 600, null]]));
  assert.deepEqual([a.from, a.to], [360, 1320], "06:00–22:00 — החניה מחצות לא נחשבת");
  const site = a.blocks.find((b) => b.kind === "site");
  assert.ok(Math.abs(site.left - 12.5) < 1e-9 && Math.abs(site.width - 6.25) < 1e-9, site);
  assert.equal(site.title, "באתר 1227 · 08:00–09:00");
  assert.ok(Math.abs(a.now - 25) < 1e-9);
  assert.deepEqual(a.ticks.map((x) => x.label), ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"]);
  const early = timeline(stats([["drive", 290, 330, null], ["drive", 1330, 1350, null]]));
  assert.deepEqual([early.from, early.to], [240, 1380], "פעילות ב-04:50 וב-22:30 — מ-04:00 עד 23:00");
  assert.equal(timeline({ today: { segments: [] } }), null);
  assert.equal(timeline(null), null);
  // 25/10 — 25 שעות: ב-02:00 בקיץ חוזרים ל-01:00. שעתיים אחרי חצות = 01:00 בפעם השנייה, שלוש = 02:00 (חורף)
  assert.equal(minuteClock("2026-10-24T21:00:00Z", 60), "01:00");
  assert.equal(minuteClock("2026-10-24T21:00:00Z", 120), "01:00", "השעה 01:00 פעמיים");
  assert.equal(minuteClock("2026-10-24T21:00:00Z", 180), "02:00");
});

test("השבוע: עמודה לכל יום, היום האחרון מסומן, יום שלא נאסף — ריק; הסיכום רק מימים שנאספו", () => {
  const week = [
    { day: "2026-10-15", km: null, drive_s: 0, visits: 0, sites: 0, tracked: false },
    { day: "2026-10-20", km: 40, drive_s: 3600, visits: 3, sites: 2, tracked: true },
    { day: "2026-10-21", km: 10, drive_s: 1800, visits: 1, sites: 1, tracked: true },
  ];
  const bars = weekBars({ week });
  assert.deepEqual(bars.map((b) => [b.label, b.h, b.today, b.tracked]), [["ה׳", 0, false, false], ["ג׳", 100, false, true], ["ד׳", 25, true, true]]);
  assert.deepEqual(weekTotals({ week }), { km: 50, visits: 4, days: 2 });
  assert.deepEqual(weekTotals({}), { km: null, visits: 0, days: 0 });
});

test("הביקורים: שם האתר בלי העיר, משעה עד שעה ומשך; הפתוח — עד עכשיו", () => {
  const rows = visitRows({ visits: [
    { code: "1206", name: "מתיתיהו הכהן הגדול 9, ת\"א", from: ago(180), to: ago(120), open: false },
    { code: "1227", name: SITE.name, from: ago(35), to: ago(1), open: true, approx: true },
  ] }, NOW);
  assert.deepEqual(rows.map((r) => [r.label, r.from, r.to, r.open, r.dur]), [
    ["מתיתיהו הכהן הגדול 9", "08:00", "09:00", false, "1:00 שע׳"], ["הרצל 50", "10:25", "", true, "35 דק׳"]]);
});

test("צריכים טכנאי: מי כבר שם (בשמו), והקרובים בלי מי שכבר שם; מרחק משוער עם 'כ-'", () => {
  const vehicles = [veh({ plate: "A", name: "אבי A", state: "driving" }), veh({ plate: "B", name: "בני B" })];
  const [x] = alertRows([{ code: "1227", name: SITE.name, fault: true, calls: 2, located: true, approx: true, on_site: ["B"],
    nearest: [{ plate: "B", m: 30, state: "parking" }, { plate: "A", m: 412, state: "driving" }, { plate: "Z", m: 900, state: "parking" }] }], vehicles, NOW);
  assert.deepEqual([x.label, x.fault, x.calls, x.onSite], ["הרצל 50", true, 2, [{ plate: "B", name: "בני" }]]);
  assert.deepEqual(x.nearest.map((n) => [n.name, n.dist, n.state]), [["אבי", "כ-410 מ׳", "בנסיעה"], ["Z", "כ-900 מ׳", ""]]);
  assert.deepEqual(alertRows(undefined, vehicles, NOW), []);
});

test("חיפוש בכרטיסים: שם, מספר, כתובת, האתר שהוא בו, והאתרים שביקר בהם היום", () => {
  const v = veh({ address: "הירקון 12", at_site: SITE, stats: { visits: [{ code: "1206", name: "מתיתיהו 9" }] } });
  for (const q of ["דני", "1", "הירקון", "הרצל", "1227", "1206", "מתיתיהו", "", "  "]) assert.ok(matchesCard(v, q), q);
  assert.equal(matchesCard(v, "אין כזה"), false);
});

test("שם הטכנאי מלוח הרכז — בחיפוש, במיון וב'צריכים טכנאי'; והכינוי באיתוראן עדיין נמצא בחיפוש (21/10)", () => {
  const a = veh({ plate: "7", name: "טנדר 12 7", tech: "דני כהן" });
  assert.ok(matchesCard(a, "דני"), "חיפוש לפי שם הטכנאי");
  assert.ok(matchesCard(a, "טנדר"), "והכינוי באיתוראן — עדיין");
  const b = veh({ plate: "8", name: "אבי 8" });
  assert.deepEqual(sortCards([a, b], NOW).map((x) => x.plate), ["8", "7"], "המיון לפי השם שמוצג (אבי לפני דני)");
  const rows = alertRows([{ code: "1227", name: "הרצל 50", fault: true, calls: 0, on_site: [], nearest: [{ plate: "7", m: 300, state: "parking" }] }], [a, b], NOW);
  assert.match(JSON.stringify(rows), /דני כהן/, "'הכי קרוב' בשם הטכנאי");
});
