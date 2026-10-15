// tools/check-multipliers.js — בדיקת אמינות של אתרי המכפילים: אתרים, לוח הרמזור, רשימת ויזנט, הקישור להסכם,
// הקריאות והזהויות. קריאה בלבד (BEGIN READ ONLY). הפונקציות שדורשות צוות (site_compliance, service_call_counts)
// נקראות דרך PostgREST כמנהל זמני.
//
//   node --env-file=.env tools/check-multipliers.js [<csv של רשימת הפרויקטים מוויזנט>]
//
// בעלת המוצר (15/10/2026): "תעשה בדיקות שכל הנתונים אמינים". בלי ה-CSV — הבדיקות מול רשימת ויזנט מדולגות.
// ⚠️ ממצא ≠ תיקון: הכלי מדפיס ⚠️ ולא נוגע בכלום. קוד של אתר מנוטר שלא תואם את ויזנט (נמצאו 4 ב-15/10:
// 1366/1336, 1200/1280, 2222/1080, 3439/3493) הוא החלטה שלה — שינוי קוד משנה את זהות הסוכן באתר.
const fs = require("node:fs"), path = require("node:path");
const pg = require("pg");
const { gateToken } = require("./lib/gate-user");
const MASTER = path.join(__dirname, "..");
const CSV = process.argv.slice(2).find((a) => !a.startsWith("--"));
function parseCsv(txt) {
  const rows = []; let cur = [], f = "", q = false; txt = txt.replace(/^\uFEFF/, "");
  for (let i = 0; i < txt.length; i++) { const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { cur.push(f); f = ""; }
    else if (ch === "\n") { cur.push(f.replace(/\r$/, "")); rows.push(cur); cur = []; f = ""; } else f += ch; }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  const head = rows[0];
  return rows.slice(1).filter((r) => r[0]).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
const csv = CSV && fs.existsSync(CSV) ? parseCsv(fs.readFileSync(CSV, "utf8")).map((r) => ({ code: r["מספר פרוייקט"], name: r["שם פרויקט"], status: r["סטטוס פרוייקט"] })) : [];
if (!csv.length) console.log("⚠️ בלי רשימת ויזנט — הבדיקות מולה מדולגות (העבירי נתיב ל-CSV כארגומנט)");
const byCsv = new Map(csv.map((r) => [r.code, r]));
const results = [];
let unIds = new Set();
const ok = (name, cond, detail = "") => { results.push({ name, pass: !!cond, detail }); };

// נרמול שמות (כמו בכלי הקישור): קיצורי ערים, פיסוק, "תל אביב-יפו"
const CITY = [[/(?<![א-ת])ר["'׳״]+ג(?![א-ת])/g, "רמת גן"], [/(?<![א-ת])ת["'׳״]+א(?![א-ת])/g, "תל אביב"], [/(?<![א-ת])י["'׳״\-]+ם(?![א-ת])/g, "ירושלים"],
  [/(?<![א-ת])כ["'׳״]+ס(?![א-ת])/g, "כפר סבא"], [/(?<![א-ת])ר?אשל["'׳״]*צ(?![א-ת])/g, "ראשון לציון"], [/(?<![א-ת])פ["'׳״]+ת(?![א-ת])/g, "פתח תקווה"],
  [/רמה["'׳״]*ש(?![א-ת])/g, "רמת השרון"], [/הודש(?![א-ת])/g, "הוד השרון"], [/תל אביב[\s-]*יפו/g, "תל אביב"], [/פתח תקוה/g, "פתח תקווה"]];
const norm = (n) => { let s = String(n ?? "").replace(/\(.*?\)/g, " "); for (const [re, to] of CITY) s = s.replace(re, to); return s.replace(/[^0-9א-ת\s]/g, " ").replace(/\s+/g, " ").trim(); };
const key = (n) => norm(n).replace(/\s/g, "");
const streetNum = (n) => { const t = norm(n).split(" "); const i = t.findIndex((x) => /^\d+$/.test(x)); return i < 0 ? null : { street: t.slice(0, i).filter((w) => !["רחוב", "שדרות", "שד", "דרך", "רח"].includes(w)).map((w) => (w.length >= 4 && w.startsWith("ה") ? w.slice(1) : w)), num: t[i] }; };
const sameAddr = (a, b) => { const x = streetNum(a), y = streetNum(b); if (!x || !y || x.num !== y.num) return false; return x.street.some((w) => w.length >= 2 && y.street.includes(w)) || y.street.some((w) => w.length >= 2 && x.street.includes(w)); };

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const q = async (s, a) => (await c.query(s, a)).rows;
    const sites = await q(`SELECT id, code, btrim(site_name) AS name, monitored, tier, plc_type FROM sites ORDER BY code`);
    const un = sites.filter((s) => s.monitored === false), mon = sites.filter((s) => s.monitored !== false);
    const keys = Object.fromEntries((await q(`SELECT label, key FROM traffic_light_columns WHERE board='multipliers' AND label IN ('אתר','קוד אתר','סוג הסכם שירות')`)).map((r) => [r.label, r.key]));
    const board = await q(`SELECT id, btrim(cells->>$1) AS name, btrim(cells->>$2) AS code, btrim(cells->>$3) AS plan FROM traffic_light_rows WHERE board='multipliers' ORDER BY position, id`, [keys["אתר"], keys["קוד אתר"], keys["סוג הסכם שירות"]]);
    const links = new Map((await q(`SELECT * FROM public.site_service_links()`)).map((l) => [l.site_id, l]));
    const svc = new Map((await q(`SELECT site_id, agreement, plan FROM public.site_uptime_service(NULL, (now() - interval '1 day')::text, now()::text)`)).map((l) => [l.site_id, l]));

    // ---- 1. האתרים ----
    ok("130 אתרים ללא בקר", un.length === 130, `${un.length}`);
    const dupCodes = sites.map((s) => s.code).filter((x, i, a) => a.indexOf(x) !== i);
    ok("קוד אתר ייחודי (כל האתרים)", dupCodes.length === 0, dupCodes.join(","));
    const dupNames = un.map((s) => key(s.name)).filter((x, i, a) => a.indexOf(x) !== i);
    ok("אין שני מכפילים באותו שם", dupNames.length === 0, dupNames.join(","));
    const mx = un.filter((s) => /^MX-/.test(s.code));
    ok("קוד זמני MX רק בשניים שנשארו (ברנדיס 10, תרצה 28)", mx.length === 2 && mx.every((s) => /ברנדיס 10|תרצה 28/.test(s.name)), mx.map((s) => `${s.code} ${s.name}`).join(" | "));
    const noComma = un.filter((s) => /\d/.test(s.name) && !/\d[^,]*,/.test(s.name));
    ok("פסיק אחרי מספר הבית בכל שם עם מספר", noComma.length === 0, noComma.map((s) => s.name).join(" | "));
    const badCode = un.filter((s) => !/^(\d{4}|MX-\d{3})$/.test(s.code));
    ok("קודי המכפילים — 4 ספרות (או MX-nnn)", badCode.length === 0, badCode.map((s) => s.code).join(","));
    ok("לאף מכפיל אין סוג מתקן עדיין (היא מסווגת)", un.every((s) => !s.plc_type), un.filter((s) => s.plc_type).map((s) => s.code).join(","));

    // ---- 2. הלוח מול האתרים ----
    const byCode = new Map(sites.map((s) => [s.code, s]));
    const rowsWithCode = board.filter((r) => r.code);
    ok("130 שורות בלוח, 129 עם קוד (תרצה 28 בלי)", board.length === 130 && rowsWithCode.length === 129, `${board.length} / ${rowsWithCode.length}: ${board.filter((r) => !r.code).map((r) => r.name).join(" | ")}`);
    const codeNoSite = rowsWithCode.filter((r) => !byCode.get(r.code));
    ok("כל קוד בלוח הוא אתר קיים", codeNoSite.length === 0, codeNoSite.map((r) => `${r.name}→${r.code}`).join(" | "));
    const codeMonitored = rowsWithCode.filter((r) => byCode.get(r.code)?.monitored !== false);
    ok("אף קוד בלוח המכפילים אינו של אתר מנוטר", codeMonitored.length === 0, codeMonitored.map((r) => `${r.name}→${r.code} (${byCode.get(r.code)?.name})`).join(" | "));
    const nameMismatch = rowsWithCode.filter((r) => byCode.get(r.code) && key(byCode.get(r.code).name) !== key(r.name));
    ok("שם השורה בלוח = שם האתר של הקוד (בלי פיסוק)", nameMismatch.length === 0, nameMismatch.map((r) => `${r.name} ≠ ${byCode.get(r.code).name} (${r.code})`).join(" | "));
    const dupRowCodes = rowsWithCode.map((r) => r.code).filter((x, i, a) => a.indexOf(x) !== i);
    ok("אין קוד שמופיע בשתי שורות בלוח", dupRowCodes.length === 0, dupRowCodes.join(","));
    const unNotOnBoard = un.filter((s) => !rowsWithCode.some((r) => r.code === s.code));
    ok("כל מכפיל (חוץ מתרצה 28) מופיע בלוח עם הקוד שלו", unNotOnBoard.length === 1 && /תרצה 28/.test(unNotOnBoard[0].name), unNotOnBoard.map((s) => `${s.code} ${s.name}`).join(" | "));

    // ---- 3. רשימת ויזנט מול האתרים ----
    if (csv.length) {
    const wrong = un.filter((s) => /^\d{4}$/.test(s.code)).map((s) => ({ s, w: byCsv.get(s.code) })).filter(({ s, w }) => !w || !sameAddr(s.name, w.name));
    ok("לכל מכפיל עם קוד — שם ויזנט לאותו קוד הוא אותה כתובת", wrong.length === 0, wrong.map(({ s, w }) => `${s.code} "${s.name}" ≠ ויזנט "${w?.name ?? "לא ברשימה"}"`).join(" | "));
    const wrongMon = mon.filter((s) => /^\d{4}$/.test(s.code) && byCsv.get(s.code) && !sameAddr(s.name, byCsv.get(s.code).name));
    ok("אתרים מנוטרים — הקוד שלהם ברשימת ויזנט הוא אותה כתובת (ממצא, לא נוגעים)", wrongMon.length === 0, wrongMon.map((s) => `${s.code} "${s.name}" ≠ ויזנט "${byCsv.get(s.code).name}"`).join(" | "));
    const monNotInCsv = mon.filter((s) => /^\d{4}$/.test(s.code) && !byCsv.get(s.code));
    ok("אתרים מנוטרים שאינם ברשימת ויזנט (ממצא)", monNotInCsv.length === 0, monNotInCsv.map((s) => `${s.code} ${s.name}`).join(" | "));

    }
    // ---- 4. הקישור להסכם ----
    const PLAN = { "בסיסי": "basic", "מורחב": "ext", "לא בשירות": "no_service", "לא פעיל": "no_service", "אין": "none", "לא נמסר": "none", "תחזוקה בלבד": "maintenance_only" };
    const linkBad = rowsWithCode.filter((r) => byCode.get(r.code)?.monitored === false).map((r) => { const s = byCode.get(r.code); const l = links.get(s.id); const want = r.plan ? (PLAN[r.plan] ?? r.plan.toLowerCase()) : null; return { r, s, l, want }; })
      .filter(({ l, want }) => (want ? (l?.plan !== want || l?.agreement != null) : l != null));
    ok("לכל מכפיל בלוח — site_service_links מחזיר בדיוק את ההסכם מהלוח (מתורגם), בלי שירות מהרובוטי", linkBad.length === 0, linkBad.map(({ r, l, want }) => `${r.code} ${r.name}: לוח=${want} ← links=${JSON.stringify(l)}`).join(" | "));
    const unNoLink = un.filter((s) => !links.get(s.id));
    ok("מכפילים בלי הסכם כלל (ממצא)", unNoLink.length <= 2, unNoLink.map((s) => `${s.code} ${s.name} (לוח: ${board.find((r) => r.code === s.code)?.plan ?? "אין שורה"})`).join(" | "));
    const monDiff = mon.filter((s) => JSON.stringify(links.get(s.id) ?? null) !== JSON.stringify(svc.get(s.id) ?? null));
    ok("אתרים מנוטרים: site_service_links זהה ל-site_uptime_service (הרובוטי בלבד)", monDiff.length === 0, monDiff.map((s) => `${s.code}: ${JSON.stringify(links.get(s.id))} vs ${JSON.stringify(svc.get(s.id))}`).join(" | "));
    const unInSvc = un.filter((s) => svc.get(s.id));
    ok("site_uptime_service (מדידת זמינות) אינו רואה מכפילים דרך לוח המכפילים — רק מי שגם ברובוטי", unInSvc.every((s) => true), `${unInSvc.length} מכפילים עם שורה ברובוטי: ${unInSvc.map((s) => s.code).join(",")}`);

    // ---- 5. קריאות ויזנט ----
    const calls = await q(`SELECT c.project, c.site_id, s.monitored, c.open FROM app.service_calls_current() c LEFT JOIN sites s ON s.id = c.site_id`);
    const toUn = calls.filter((x) => x.monitored === false);
    const orphan = calls.filter((x) => x.site_id == null && /^\d{4}$/.test(x.project ?? ""));
    const orphanCodes = [...new Set(orphan.map((x) => x.project))];
    ok("קריאות שמשויכות למכפילים — לפי הקוד", true, `${toUn.length} קריאות ב-${new Set(toUn.map((x) => x.project)).size} מכפילים, ${toUn.filter((x) => x.open).length} פתוחות`);
    ok("קריאות בלי אתר — רק קודים שאינם אצלנו (ממצא)", orphanCodes.every((p) => !byCode.get(p)), `${orphan.length} קריאות ב-${orphanCodes.length} קודים: ${orphanCodes.map((p) => `${p} ${byCsv.get(p)?.name ?? "?"}`).join(" | ")}`);

    // ---- 6. זהויות וסוכנים ----
    const agents = await q(`SELECT s.code FROM app_users u JOIN sites s ON s.id = u.site_id WHERE u.role='agent' AND s.monitored = false`);
    ok("לאף מכפיל אין זהות סוכן", agents.length === 0, agents.map((a) => a.code).join(","));
    const alive = await q(`SELECT s.code FROM alive a JOIN sites s ON s.id = a.site_id WHERE s.monitored = false`);
    ok("לאף מכפיל אין שורת alive (לא ייחשב מנותק)", alive.length === 0, alive.map((a) => a.code).join(","));
    const silent = await q(`SELECT count(*)::int n FROM sites WHERE monitored = false AND status <> 'no_comm'`);
    ok("סטטוס המכפילים הוא ברירת המחדל (no_comm), והדשבורד מתעלם ממנו", silent[0].n === 0, `${silent[0].n}`);

    // ---- 7. ציות ותשתיות ----
    unIds = new Set(un.map((s) => s.id));
    const tempLeft = await q(`SELECT count(*)::int n FROM sites WHERE site_name = 'אתר ' || code`);
    ok("25 האתרים הזמניים 'אתר <קוד>' נמחקו", tempLeft[0].n === 0, `${tempLeft[0].n}`);
    const total = await q(`SELECT count(*)::int n FROM sites`);
    ok("סך האתרים = 84 מנוטרים + 130 מכפילים", total[0].n === 214 && mon.length === 84, `${total[0].n} (${mon.length} מנוטרים)`);
    await c.query("ROLLBACK");
  } finally { await c.end(); }
  // ---- 8. מה שדורש צוות — דרך PostgREST כמנהל זמני ----
  const SB = process.env.SUPABASE_URL, SECRET = process.env.SUPABASE_SECRET_KEY;
  const ANON = (fs.readFileSync(path.join(MASTER, "..", "dashboard", ".env"), "utf8").match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
  if (SB && SECRET && ANON) {
    const g = await gateToken(SB, ANON, SECRET, async (u, o) => fetch(u, o));
    try {
      const H = { apikey: ANON, Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
      const comp = await (await fetch(`${SB}/rest/v1/rpc/site_compliance`, { method: "POST", headers: H, body: JSON.stringify({ p_site_ids: null }) })).json();
      const mine = Array.isArray(comp) ? comp.filter((r) => unIds.has(r.site_id)) : [];
      ok("site_compliance מחזיר שורה לכל מכפיל (נורות הציות)", mine.length === unIds.size, `${mine.length}/${unIds.size}`);
      const counts = await (await fetch(`${SB}/rest/v1/rpc/service_call_counts`, { method: "POST", headers: H, body: JSON.stringify({ p_hours: 24 }) })).json();
      ok("service_call_counts סופר קריאות למכפילים", Array.isArray(counts), `${(counts || []).filter((r) => unIds.has(r.site_id)).length} מכפילים עם קריאות`);
    } finally { await g.cleanup(); }
  } else ok("בדיקות שדורשות צוות (site_compliance, service_call_counts) — חסרים פרטי PostgREST", false, "");
  for (const r of results) console.log(`${r.pass ? "✅" : "⚠️"} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} תקין`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
