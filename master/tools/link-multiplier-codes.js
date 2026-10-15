// tools/link-multiplier-codes.js — קודי פרויקט לאתרי המכפילים, מרשימת הפרויקטים של ויזנט.
//
//   node --env-file=.env tools/link-multiplier-codes.js <csv>            ← הרצה יבשה: מה יזוהה, מה לא
//   node --env-file=.env tools/link-multiplier-codes.js <csv> --apply    ← כתיבה
//
// ============================================================
// ⚠️ למה
// ============================================================
// בעלת המוצר (15/10/2026): "בהורדות יש מסמך EXCEL בשם רשימת פרויקטים וייזנט — משם תיקח את הקודים לאתרים
// שאין להם ותוסיף". אתרי המכפילים נוצרו מלוח "מכפילים" ברמזור בקוד זמני MX-nnn; הקוד האמיתי הוא מה שמחבר
// אליהם את הקריאות מוויזנט (לפי project code) ואת תג ההסכם (site_service_links לפי "קוד אתר" בלוח).
//
// שני מקורות לקוד, לפי הסדר:
//   1. **התא "קוד אתר" בלוח** — מה שהיא הקלידה ביד (57 שורות ב-15/10). הוא גובר על כל ניחוש.
//   2. **רשימת הפרויקטים** (CSV מוויזנט: מספר פרויקט, שם פרויקט, סטטוס…) — התאמה לפי **שם**: רחוב + מספר בית
//      + עיר, אחרי נרמול: קיצורי ערים (ר"ג, ת"א, י-ם, כ"ס, רשל"צ, פ"ת, ב"ב…), גרשיים בכל הצורות, פיסוק,
//      "תל אביב-יפו" → "תל אביב". מספר הבית חייב להיות זהה; הרחוב — חפיפה של מילה בת 3+ אותיות; עיר — כשיש
//      בשני הצדדים, חייבת להתאים. התאמה **יחידה** בלבד: שני מועמדים = "לא ברור", ונשאר לה.
//
// מה נכתב ב---apply, לכל שורה שזוהה לה קוד:
//   - sites.code של אתר המכפיל (שם זהה לשם בלוח) → הקוד (update_site p_new_code, מנהל זמני דרך PostgREST,
//     כמו ניהול אתרים). ⚠️ קוד שכבר תפוס על ידי אתר אחר — לא נוגעים, ומדווחים: זה כנראה אתר מנוטר שכבר קיים,
//     ואז השורה בלוח צריכה להצביע עליו ולא על המכפיל (החלטה שלה).
//   - התא "קוד אתר" בלוח → הקוד (tl_set_cell), כשהוא ריק או MX-….
// ⚠️ אידמפוטנטי: שורה שהתא והאתר שלה כבר על הקוד — "✓ כבר". הרצה חוזרת משלימה רק את החסר.
const fs = require("node:fs");
const path = require("node:path");
const pg = require("pg");
const { gateToken } = require("./lib/gate-user");

const MASTER = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const CSV = process.argv.slice(2).find((a) => !a.startsWith("--"));

// ---------------- נרמול שמות ----------------
const CITY = [
  [/\b(?<![א-ת])ר["'׳״]+ג\b/g, "רמת גן"], [/\b(?<![א-ת])ת["'׳״]+א\b/g, "תל אביב"], [/\b(?<![א-ת])י["'׳״\-]+ם\b/g, "ירושלים"],
  [/\b(?<![א-ת])כ["'׳״]+ס\b/g, "כפר סבא"], [/\b(?<![א-ת])ר?אשל["'׳״]+צ\b/g, "ראשון לציון"], [/\b(?<![א-ת])פ["'׳״]+ת\b/g, "פתח תקווה"],
  [/\b(?<![א-ת])ב["'׳״]+ב\b/g, "בני ברק"], [/\b(?<![א-ת])ק["'׳״]+א\b/g, "קרית אונו"], [/\b(?<![א-ת])ג["'׳״]+ת\b/g, "גבעתיים"],
  [/\b(?<![א-ת])רמה["'׳״]+ש\b/g, "רמת השרון"], [/\b(?<![א-ת])הוד ה["'׳״]+ש\b/g, "הוד השרון"],
  [/תל אביב[\s-]*יפו/g, "תל אביב"], [/פתח תקוה/g, "פתח תקווה"], [/ראשל["'׳״]*צ/g, "ראשון לציון"],
];
const STOP = new Set(["רחוב", "רח", "שדרות", "שד", "פינת", "דרך"]);
function norm(name) {
  let s = String(name ?? "").replace(/\(.*?\)/g, " ");
  for (const [re, to] of CITY) s = s.replace(re, to);
  s = s.replace(/[^0-9א-ת\s]/g, " ").replace(/\s+/g, " ").trim();
  const toks = s.split(" ").filter((t) => t && !STOP.has(t));
  const nums = toks.filter((t) => /^\d+$/.test(t));
  const words = toks.filter((t) => !/^\d+$/.test(t));
  return { nums, words, text: toks.join(" ") };
}
const CITIES = ["תל אביב", "רמת גן", "ירושלים", "כפר סבא", "ראשון לציון", "פתח תקווה", "בני ברק", "קרית אונו", "גבעתיים",
  "רמת השרון", "הוד השרון", "הרצליה", "רעננה", "חולון", "בת ים", "נתניה", "חיפה", "רחובות", "נס ציונה", "מודיעין", "רמלה", "לוד",
  "אשדוד", "אשקלון", "באר שבע", "יהוד", "אור יהודה", "קרית גת", "חדרה", "נתיבות", "קריית אונו", "גבעת שמואל", "ראש העין", "שוהם"];
// ⚠️ העיר — רק בסוף השם. "שדרות ירושלים 92, רמת גן" מכיל "ירושלים" והיא הרחוב, לא העיר.
function cityOf(text) { return CITIES.filter((c) => text.endsWith(c)).sort((a, b) => b.length - a.length)[0] ?? null; }
// ה' הידיעה בראש רחוב מושמטת ("הפלמח" / "פלמח" הם אותו רחוב), רק במילה של 4+ אותיות
const bare = (w) => (w.length >= 4 && w.startsWith("ה") ? w.slice(1) : w);
function streetWords(n) { const city = cityOf(n.text); const cw = new Set((city ?? "").split(" ")); return n.words.filter((w) => !cw.has(w) && w.length >= 2).map(bare); }

/** ציון התאמה; null = לא מתאים */
function score(boardName, csvName) {
  const a = norm(boardName), b = norm(csvName);
  // מספר הבית — חובה: הראשון זהה, או (בשני מספרים בכל צד) אותה קבוצה — "מכבי 15/הגליל 16" מול "הגליל 16/מכבי 15"
  const sameSet = a.nums.length > 1 && b.nums.length > 1 && [...a.nums].sort().join() === [...b.nums].sort().join();
  if (!a.nums.length || !b.nums.length || (a.nums[0] !== b.nums[0] && !sameSet)) return null;
  const ca = cityOf(a.text), cb = cityOf(b.text);
  if (ca && cb && ca !== cb) return null;
  const sa = streetWords(a), sb = new Set(streetWords(b));
  // חפיפה של מילה בת 3+ אותיות — או של **כל** מילות הרחוב כשהן קצרות ("חד נס", "תל חי")
  const common = sa.filter((w) => sb.has(w));
  if (!common.some((w) => w.length >= 3) && !(sa.length && common.length === sa.length)) return null;
  return common.length * 10 + (ca && cb ? 5 : 0) + (a.nums.length > 1 && a.nums[1] === b.nums[1] ? 2 : 0);
}

function parseCsv(txt) {
  const rows = []; let cur = [], f = "", q = false;
  txt = txt.replace(/^﻿/, "");
  for (let i = 0; i < txt.length; i++) { const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { cur.push(f); f = ""; }
    else if (ch === "\n") { cur.push(f.replace(/\r$/, "")); rows.push(cur); cur = []; f = ""; } else f += ch; }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  const head = rows[0];
  return rows.slice(1).filter((r) => r[0]).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

(async () => {
  if (!CSV || !fs.existsSync(CSV)) { console.error("נתיב ל-CSV של רשימת הפרויקטים חסר או לא קיים"); process.exit(1); }
  const SB = process.env.SUPABASE_URL, SECRET = process.env.SUPABASE_SECRET_KEY;
  const ANON = (fs.readFileSync(path.join(MASTER, "..", "dashboard", ".env"), "utf8").match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
  if (!process.env.DATABASE_URL || !SB || !SECRET || !ANON) { console.error("חסרים פרטי חיבור"); process.exit(1); }

  const projects = parseCsv(fs.readFileSync(CSV, "utf8")).map((r) => ({ code: r["מספר פרוייקט"], name: r["שם פרויקט"], status: r["סטטוס פרוייקט"] }))
    .filter((p) => /^\d{3,5}$/.test(p.code));
  console.log(`רשימת הפרויקטים: ${projects.length} פרויקטים`);

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let sites, board, codeKey;
  try {
    await db.query("BEGIN READ ONLY");
    sites = (await db.query(`SELECT id, code, btrim(site_name) AS name, monitored FROM sites`)).rows;
    codeKey = (await db.query(`SELECT key FROM traffic_light_columns WHERE board='multipliers' AND label='קוד אתר' ORDER BY position, id LIMIT 1`)).rows[0]?.key;
    const nameKey = (await db.query(`SELECT key FROM traffic_light_columns WHERE board='multipliers' AND label='אתר' ORDER BY position, id LIMIT 1`)).rows[0]?.key;
    if (!codeKey || !nameKey) throw new Error("בלוח המכפילים חסרה עמודת 'קוד אתר' או 'אתר'");
    board = (await db.query(`SELECT id, btrim(cells->>$1) AS name, btrim(cells->>$2) AS code FROM traffic_light_rows WHERE board='multipliers' ORDER BY position, id`, [nameKey, codeKey])).rows;
    await db.query("ROLLBACK");
  } finally { await db.end(); }
  const byCode = new Map(sites.map((s) => [s.code, s]));
  // ⚠️ בלי פיסוק: לאתרים נוסף פסיק אחרי מספר הבית (rename-multiplier-sites), והלוח נשאר בלעדיו
  const nameKeyOf = (n) => String(n ?? "").replace(/[^0-9א-תA-Za-z]+/g, " ").replace(/s+/g, " ").trim();
  const byName = new Map(sites.filter((s) => s.monitored === false).map((s) => [nameKeyOf(s.name), s]));

  // ---------------- התוכנית ----------------
  const plan = [];   // { row, name, site, code, source, action, note }
  const taken = new Set();
  for (const r of board) {
    if (!r.name) continue;
    const site = byName.get(nameKeyOf(r.name)) ?? null;
    let code = null, source = null, note = "";
    if (r.code && !/^MX-/i.test(r.code)) { code = r.code; source = "תא"; }
    else {
      const cands = projects.map((p) => ({ p, s: score(r.name, p.name) })).filter((x) => x.s != null).sort((a, b) => b.s - a.s);
      if (cands.length === 1 || (cands.length > 1 && cands[0].s > cands[1].s)) { code = cands[0].p.code; source = `רשימה: "${cands[0].p.name}" (${cands[0].p.status})`; }
      else if (cands.length > 1) note = `לא ברור — ${cands.slice(0, 3).map((x) => `${x.p.code} "${x.p.name}"`).join(" / ")}`;
      else note = "לא נמצא ברשימה";
    }
    if (!code) { plan.push({ row: r, name: r.name, site, code: null, action: "skip", note }); continue; }
    const holder = byCode.get(code);
    if (holder && (!site || holder.id !== site.id)) {
      plan.push({ row: r, name: r.name, site, code, source, action: "conflict", note: `הקוד ${code} כבר של "${holder.name}"${holder.monitored === false ? " (ללא בקר)" : " (אתר מנוטר)"}` });
      continue;
    }
    if (taken.has(code)) { plan.push({ row: r, name: r.name, site, code, source, action: "conflict", note: `הקוד ${code} זוהה גם לשורה אחרת` }); continue; }
    taken.add(code);
    const needSite = site && site.code !== code, needCell = r.code !== code;
    if (!site) plan.push({ row: r, name: r.name, site, code, source, action: needCell ? "cell" : "done", note: "אין אתר מכפיל בשם הזה — רק התא" });
    else plan.push({ row: r, name: r.name, site, code, source, action: !needSite && !needCell ? "done" : needSite && needCell ? "both" : needSite ? "site" : "cell", note: "" });
  }

  const by = (a) => plan.filter((p) => p.action === a);
  console.log(`\n=== ${board.length} שורות בלוח ===`);
  for (const p of plan) {
    const mark = { done: "✓", both: "+", site: "+", cell: "+", conflict: "⚠️", skip: "?" }[p.action];
    const what = { done: "כבר מחובר", both: `אתר ${p.site.code} → ${p.code}, ותא`, site: `אתר ${p.site.code} → ${p.code}`, cell: `תא → ${p.code}`, conflict: p.note, skip: p.note }[p.action];
    console.log(`  ${mark} ${p.name.padEnd(28)} ${(p.code ?? "").padEnd(6)} ${what}${p.source && p.action !== "done" && p.action !== "conflict" ? `  [${p.source}]` : ""}`);
  }
  console.log(`\nלכתוב: ${by("both").length + by("site").length + by("cell").length} · כבר מחובר: ${by("done").length} · התנגשות: ${by("conflict").length} · לא זוהה: ${by("skip").length}`);
  if (!APPLY) { console.log("\nהרצה יבשה. לכתיבה:  node --env-file=.env tools/link-multiplier-codes.js <csv> --apply"); return; }

  // ---------------- כתיבה ----------------
  const retry = async (url, opt) => { let last; for (let i = 0; i < 5; i++) { try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); } } throw last; };
  const g = await gateToken(SB, ANON, SECRET, retry);
  let ok = 0, failed = 0;
  try {
    const H = { apikey: ANON, Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
    const rpc = (fn, body) => retry(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(body) });
    for (const p of plan) {
      if (!["both", "site", "cell"].includes(p.action)) continue;
      try {
        if (p.action === "both" || p.action === "site") {
          const r = await rpc("update_site", { p_code: p.site.code, p_new_code: p.code });
          if (!r.ok) throw new Error(`update_site ${r.status}: ${(await r.text()).slice(0, 140)}`);
        }
        if (p.action === "both" || p.action === "cell") {
          const r = await rpc("tl_set_cell", { p_row: p.row.id, p_key: codeKey, p_value: p.code });
          if (!r.ok) throw new Error(`tl_set_cell ${r.status}: ${(await r.text()).slice(0, 140)}`);
        }
        ok++; console.log(`  ✅ ${p.name} → ${p.code}`);
      } catch (e) { failed++; console.log(`  ❌ ${p.name}: ${e.message}`); }
    }
  } finally { await g.cleanup(); }
  console.log(`\nנכתבו ${ok}, נכשלו ${failed}.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("link-multiplier-codes:", e.message); process.exit(1); });
