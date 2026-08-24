// ניהול אתרים מקצה לקצה: נעול → קוד → הוספה → מחיקה → נעול שוב.
const _pw = await import("file:///C:/Users/%D7%A0%D7%A2%D7%9E%D7%94%D7%9E%D7%A0%D7%93%D7%9C%D7%A1%D7%95%D7%9F/Documents/parkomatProjects/dashboard/node_modules/playwright/index.js");
const chromium = (_pw.default ?? _pw).chromium;
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { gateToken } = require("./tools/lib/gate-user");
const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = (fs.readFileSync("../dashboard/.env", "utf8")
  .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1].trim();
const APP = process.argv[2] || "http://localhost:5173";
const CODE = "admin123";
const NEW_CODE = "zz-uitest-" + Date.now().toString().slice(-6);

const db = require("./db/db");
await db.init();
const { email, password, cleanup } = await gateToken(SB, ANON, SECRET);

const browser = await chromium.launch();
const page = await browser.newPage({ viewportSize: { width: 1400, height: 950 } });
const results = [];
const add = (n, got, want) => results.push([n, got, want]);
let ready = false;

const openPanel = async () => {
  await page.locator("button.add-site-btn").first().click();
  await page.waitForSelector(".adm-overlay", { timeout: 15000 });
};
const state = async () => {
  if (await page.locator(".adm-lock").count() === 0) return "פתוח";
  const t = await page.locator(".adm-lock").innerText();
  return t.includes("התפקיד שלך") ? "מסך-תפקיד" : "טופס-קוד";
};

try {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator("button.login-submit").click();
  await page.waitForSelector(".site-card", { timeout: 40000 });
  await page.locator("button.rs-tab").nth(1).click();
  await page.waitForTimeout(2000);
  ready = true;

  // ---- 1. ⚠️ נעול כבר בפתיחה הראשונה ----
  await openPanel();
  add("⚠️ נעול כבר בפתיחה הראשונה", await state(), "טופס-קוד");
  add("⚠️ אין כפתור 'נעל'", await page.locator('button:has-text("נעל")').count(), 0);

  // ---- 2. קוד שגוי נדחה ----
  await page.locator('.adm-lock input[type="password"]').fill("not-the-code");
  await page.locator('.adm-lock button[type="submit"]').click();
  await page.waitForTimeout(2500);
  add("קוד שגוי — עדיין נעול", await state(), "טופס-קוד");

  // ---- 3. admin123 פותח ----
  await page.locator('.adm-lock input[type="password"]').fill(CODE);
  await page.locator('.adm-lock button[type="submit"]').click();
  await page.waitForTimeout(3000);
  add("admin123 פותח", await state(), "פתוח");

  // ---- 4. הוספת אתר ----
  const before = (await db.prepare("SELECT COUNT(*)::int AS n FROM sites").get()).n;
  const inputs = page.locator(".adm-overlay input[type='text']");
  await inputs.nth(0).fill(NEW_CODE);
  await inputs.nth(1).fill("אתר בדיקת ממשק");
  await page.locator('.adm-overlay button:has-text("הוסף")').first().click();
  await page.waitForTimeout(4000);
  const after = (await db.prepare("SELECT COUNT(*)::int AS n FROM sites").get()).n;
  add("⚠️ הוספת אתר — נוצר במסד", after, before + 1);

  // ---- 5. מחיקת אותו אתר ----
  page.on("dialog", (d) => d.accept());   // confirm של המחיקה
  const row = page.locator(`.adm-overlay :text("${NEW_CODE}")`).first();
  if (await row.count()) {
    const del = page.locator('.adm-overlay button:has-text("מחק")');
    if (await del.count()) { await del.last().click(); await page.waitForTimeout(4000); }
  }
  const afterDel = (await db.prepare("SELECT COUNT(*)::int AS n FROM sites WHERE code = ?").get(NEW_CODE)).n;
  add("⚠️ מחיקת אתר — נמחק מהמסד", afterDel, 0);

  // ---- 6. סגירה ופתיחה מחדש → נעול שוב ----
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator(".adm-overlay").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(1200);
  if (await page.locator(".adm-overlay").count() === 0) {
    await openPanel();
    add("⚠️ פתיחה מחדש — נעול שוב", await state(), "טופס-קוד");
  }
} catch (e) {
  console.error("שגיאה:", e.message);
  await page.screenshot({ path: "admin-flow-fail.png" }).catch(() => {});
} finally {
  await browser.close();
  await cleanup();
  // ניקוי ביטחון: אם המחיקה במסך נכשלה, האתר לא נשאר
  await db.prepare("DELETE FROM sites WHERE code = ?").run(NEW_CODE).catch(() => {});
}

console.log("\n" + "=".repeat(54));
if (!ready || results.length === 0) { console.log("❌ הבדיקה לא הגיעה למצב תקין — אין ידיעה"); process.exit(2); }
let bad = 0;
for (const [n, got, want] of results) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${n.padEnd(34)} ${got}`);
}
console.log("=".repeat(54));
console.log(bad ? `❌ ${bad} כשלים` : "✅ ניהול האתרים מתנהג כמבוקש");
process.exit(bad ? 1 : 0);
