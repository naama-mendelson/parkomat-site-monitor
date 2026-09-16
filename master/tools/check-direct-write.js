// מי כותב ישירות ל-Supabase, ומי לא — והאם בכלל יש לו מסלול אחר.
//
//   node --env-file=.env tools/check-direct-write.js
//
// ============================================================
// ⚠️ למה `alive` ולא קונפיגורציה, ולא גרסה, ולא זהות
// ============================================================
// `alive` נכתב במקום **אחד בלבד** בכל המערכת: `public.ingest_batch`, שנגישה
// רק דרך PostgREST עם הזהות של האתר עצמו. `master` אינו כותב לה ואינו יכול.
//
// כלומר שורה ב-`alive` אינה עדות נסיבתית — היא **הוכחה שהמסלול הישיר רץ**,
// ושעת ה-`seen_at` היא הפעם האחרונה שהוא רץ.
//
// ⚠️ וכל שאר הסימנים שנראים כמו תשובה אינם תשובה:
//   קונפיגורציה  — יושבת במחשב שבאתר, ואיננו רואים אותה מכאן.
//   זהות פעילה   — קיימת ב-21 אתרים שמעולם לא כתבו בה מילה.
//   `agent_version` — מגיע **דרך** הפעימה, כלומר אינו מקור עצמאי.
//
// ============================================================
// ⚠️ וארבעה מצבים ולא שניים
// ============================================================
// "כותב / לא כותב" מוחק את ההבחנה היחידה שקובעת מה לעשות: אתר שכתב ונשבר
// הוא **רגרסיה** — משהו עבד והפסיק; אתר שמעולם לא כתב הוא התקנה שלא הושלמה.
// שניהם מוצגים היום באותה צורה בדשבורד, ובשניהם הכרטיס נראה תקין.
//
// ⚠️ ולכל אתר שאינו כותב ישירות נשאלת שאלה שנייה, והיא הדחופה: **האם MQTT
// מוסר במקומו.** אתר על MQTT הוא אתר שמדווח — הפסד הוא זיהוי הנתק בלבד.
// אתר שגם MQTT כבוי בו הוא אתר **חשוך**, ואת זה אי אפשר לראות בשום מסך.
import pg from "pg";

pg.types.setTypeParser(20, (v) => parseInt(v, 10));

// ⚠️ אותו סף בדיוק כמו `app.mark_silent_agents(3)` וכמו `SYSTEMS_STALE_MS`
// בדשבורד. סף שלישי כאן היה מייצר "פועם" לאתר שהשרת כבר מחשיב שותק.
const FRESH_MIN = 3;

// ⚠️ MQTT נמדד אחרת לגמרי, ובכוונה. הסוכן משודר-לפי-שינוי, ופערים של 61–68
// שעות בין הודעות הם שגרה מדודה — ולכן "שקט" אינו סימן. הסף כאן רחב מאוד
// ומודד דבר אחד: האם הגיעה הודעה אמיתית **מאז** שהפעימה נעצרה.
const MQTT_QUIET_H = 12;

const agoMin = (t) => (t ? (Date.now() - new Date(t)) / 60000 : null);
const human = (m) =>
  m === null ? "מעולם" : m < 90 ? `לפני ${Math.round(m)} דק׳` : m < 2880 ? `לפני ${Math.round(m / 60)} שעות` : `לפני ${Math.round(m / 1440)} ימים`;

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT s.code, s.site_name, s.status, s.last_seen,
            (u.id IS NOT NULL)  AS has_identity,
            a.seen_at           AS last_beat,
            a.beats, a.agent_version,
            -- צוואת ה-broker: 1 = גשר Mosquitto מחובר, כלומר המחשב באתר חי.
            s.bridge_connected,
            au.last_sign_in_at
       FROM sites s
       LEFT JOIN app_users u   ON u.site_id = s.id AND u.role = 'agent' AND u.is_active
       LEFT JOIN alive a       ON a.site_id = s.id
       LEFT JOIN auth.users au ON au.id = u.supabase_uid
      ORDER BY s.code`);
  await pool.end();

  const live = [], broken = [], never = [], noIdentity = [];
  for (const r of rows) {
    const beat = agoMin(r.last_beat);
    if (beat !== null && beat <= FRESH_MIN) live.push(r);
    else if (r.last_beat) broken.push(r);
    else if (r.has_identity) never.push(r);
    else noIdentity.push(r);
  }

  // ============================================================
  // ⚠️ "MQTT מוסר" אינו סף-שעון — והגרסה הראשונה כאן טעתה בדיוק בזה
  // ============================================================
  // היא בדקה רק ש-`last_seen` טרי, וזקפה ל-2438 "MQTT מוסר (לפני 7 שעות)".
  // ההודעה ההיא הייתה **הפעימה עצמה** של 06:06 — `ingest_batch` מעדכן גם את
  // `last_seen` — כלומר הכלי זקף למסלול אחד את ההישג של השני, ודיווח שאתר
  // חשוך מדווח היטב. זו בדיוק התקלה שהכלי קיים כדי למצוא.
  //
  // הכלל הנכון הוא זה שכבר יושב ב-`app.mark_silent_agents`: **הגיעה הודעה
  // אמיתית אחרי שהפעימה נעצרה.** אתר שלא כתב מעולם — כל הודעה שלו היא MQTT
  // בהגדרה, ושם הסף הרחב כן מתאים (פערים של 61–68 שעות בין הודעות הם שגרה).
  //
  // ⚠️ ו-`last_seen` הוא המדד הנכון כי `no_comm` **אינו** מעדכן אותו (ראה
  // `ingest_state`) — הוא "מתי הגיעה הודעה אמיתית", ולא "מתי נגענו בשורה".
  const mqttAlive = (r) => {
    // ============================================================
    // ⚠️ הגשר גובר על השעון — והגרסה הקודמת כאן צעקה זאב
    // ============================================================
    // היא קבעה "האתר חשוך" לאתר שלא פעם ושלא שלח הודעה 12 שעות. זה סותר
    // מדידה שכתובה בפרויקט עצמו: **הסוכן משדר רק על שינוי MODE, ופערים של
    // 61–68 שעות בין הודעות הם שגרה.** שתיקה מעולם לא הייתה סימן.
    //
    // נמדד ב-16/09/2026: מסריק 1 (3439) דווח "חשוך" אחרי 18 שעות שקט, בזמן
    // ש-`bridge_connected = 1` — כלומר Mosquitto מחובר ל-HiveMQ והמחשב באתר
    // חי לגמרי. התראת שווא כזו מלמדת להתעלם מהכלי, וזה גרוע מאין כלי.
    //
    // ⚠️ **הצוואה היא הסימן הנכון**, וזו בדיוק הסיבה שהיא קיימת: HiveMQ
    // מפרסם אותה כשהחיבור נופל, ולא כשהאתר שותק.
    if (r.bridge_connected === 1 || r.bridge_connected === true) return true;

    const seen = r.last_seen ? new Date(r.last_seen).getTime() : null;
    if (seen === null) return false;
    // אתר שפעם בעבר: השאלה היא אם הגיעה הודעה **אחרי** שהפעימה נעצרה.
    if (r.last_beat) return seen > new Date(r.last_beat).getTime();
    // ⚠️ ואתר שמעולם לא פעם וגשרו נפל — הסף הרחב הוא הקו האחרון בלבד.
    return Date.now() - seen <= MQTT_QUIET_H * 60 * 60 * 1000;
  };

  const line = (r, extra) =>
    `   ${String(r.code).padEnd(6)} ${String(r.site_name).slice(0, 24).padEnd(26)} ${extra}`;

  console.log(`\n=== כתיבה ישירה ל-Supabase — ${rows.length} אתרים ===\n`);

  console.log(`✅ כותבים ישירות עכשיו: ${live.length}`);
  console.log(`⚠️  כתבו ונשברו:        ${broken.length}`);
  console.log(`❌ מעולם לא כתבו:       ${never.length}`);
  if (noIdentity.length) console.log(`❌ בלי זהות בכלל:       ${noIdentity.length}`);

  if (broken.length) {
    console.log(`\n⚠️  כתבו ישירות בעבר ונשברו (${broken.length}) — רגרסיה, לא התקנה חסרה:\n`);
    for (const r of broken)
      console.log(
        line(r, `פעימה אחרונה ${human(agoMin(r.last_beat))}  ·  ${r.beats} פעימות  ·  ${r.agent_version ?? "—"}  ·  ` +
          (mqttAlive(r) ? `MQTT מוסר (${human(agoMin(r.last_seen))})` : `⛔ גם MQTT שותק — האתר חשוך`))
      );
  }

  if (never.length) {
    console.log(`\n❌ מעולם לא כתבו ישירות (${never.length}) — יש זהות, הסיסמה לא הוזנה בטריי שבאתר:\n`);
    for (const r of never)
      console.log(
        line(r, (r.last_sign_in_at ? `התחבר ${human(agoMin(r.last_sign_in_at))} ואינו פועם  ·  ` : `מעולם לא התחבר  ·  `) +
          (mqttAlive(r) ? `MQTT מוסר (${human(agoMin(r.last_seen))})` : `⛔ גם MQTT שותק — האתר חשוך`))
      );
  }

  if (noIdentity.length) {
    console.log(`\n❌ אין זהות סוכן (${noIdentity.length}) — אי אפשר להפעיל בהם כתיבה ישירה כלל:\n`);
    for (const r of noIdentity) console.log(line(r, mqttAlive(r) ? `MQTT מוסר` : `⛔ גם MQTT שותק`));
  }

  if (live.length) {
    console.log(`\n✅ כותבים ישירות (${live.length}): ${live.map((r) => r.code).join(", ")}`);
    // ⚠️ פיזור הגרסאות מוצג כאן ולא במקום נפרד: הוא מגיע **דרך** הפעימה,
    // ולכן הוא ידוע רק על האתרים שבטור הזה. הצגתו כ"מצב הצי" הייתה טענה על
    // 35 אתרים שנמדדה על חלקם.
    const byVer = new Map();
    for (const r of live) byVer.set(r.agent_version ?? "—", (byVer.get(r.agent_version ?? "—") ?? 0) + 1);
    console.log(`   גרסאות: ${[...byVer].sort().map(([v, n]) => `${v} ×${n}`).join(" · ")}`);
  }

  // ⚠️ אתר חשוך הוא היחיד שאינו "פחות טוב" אלא **הפסד נתונים**: הוא אינו
  // מדווח בשום מסלול, והמסך מציג את המצב שקפא. לכן הוא נמנה בנפרד ובראש.
  const dark = [...broken, ...never, ...noIdentity].filter((r) => !mqttAlive(r));
  if (dark.length) {
    console.log(`\n⛔ אתרים חשוכים — לא מדווחים בשום מסלול (${dark.length}):\n`);
    for (const r of dark)
      console.log(line(r, `מצב מוצג: ${r.status}  ·  הודעה אחרונה ${human(agoMin(r.last_seen))}`));
  }

  process.exit(dark.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
