// shared/insights.mjs — התובנות המעמיקות. **קוד משותף לשרת ולדשבורד.**
//
// ============================================================
// אותו שיקול כמו shared/timeline.mjs
// ============================================================
// computeInsights אינה הגדרת מדד אלא **הצגה**: ספי תצוגה, דירוג כרטיסים,
// דליים לפי שעה ולפי יום, וניסוח של מה שנחשב חריג. זה משתנה לפי מה שצריך
// לראות על המסך, ולכן הוא נשאר JS — ורץ עכשיו בדפדפן כשהוא קורא ישירות
// מ-Supabase.
//
// ⚠️ אבל **קיפול הריצוד אינו תצוגה** — הוא חלק מהגדרת התקלה: `X → no_comm → X`
// הוא אירוע אחד ולא שלושה. יש לו כבר פורט ל-SQL (public.site_segments_collapsed)
// שמאומת ב-tools/parity.js, והעותק כאן חייב להישאר זהה לו. הוא יושב כאן כי
// computeInsights אינה יכולה לספור תקלות בלעדיו — לא כדי להחליף את ה-SQL.
//
// ============================================================
// למה .mjs
// ============================================================
// הדשבורד ESM והשרת CommonJS. מ-Node 22.12 `require()` טוען ESM סינכרונית,
// ולכן master/db/queries.js עושה require לקובץ הזה, ו-Vite מייבא אותו כרגיל.
// מקור אמת אחד, שני זמני ריצה. נבדק על Node v24.18.0.

export const WEEKDAY_LABELS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// חישוב טהור — מקבל שורות שכבר נשלפו, ולכן משרת גם אתר בודד וגם מצרף כלל-אתרי.
export function computeInsights({ ops: opsIn, errorRows, maintRows, windows, from, to, siteNames, allRows }) {
  let ops = opsIn;

  // ⚠️ גבולות הטווח מוגדרים כאן ולא למטה: coverBySite נבנה מיד אחריהם
  // ומשתמש בהם. בסדר הקודם זו הייתה שגיאת TDZ שהייתה מתפוצצת רק כשיש
  // חלון תחזוקה בטווח — כלומר בדיוק במקרה שהקוד נכתב בשבילו.
  const nowMs = Date.now();
  const windowStart = Date.parse(from);
  const windowEnd = Math.min(Date.parse(to), nowMs);

  // ============================================================
  // ⚠️ כיסוי חלונות התחזוקה — נבנה **ראשון**, כי הפעולות תלויות בו
  // ============================================================
  // הגוש הזה ישב פעם למטה, ליד חישוב זמן ההשבתה. משנוסף עליו גם סינון
  // הפעולות הוא היה חייב לעלות: לולאת הספירה (כרטיסים, שעות, ימים)
  // רצה הרבה לפניו, ולכן הסינון היה מגיע **אחרי** שהכול כבר נספר —
  // כלומר לא עושה כלום, בשקט, ובלי שאף בדיקה תיפול.
  const coverBySite = new Map();
  for (const w of windows) {
    if (w.excluded_at) continue;
    if (!coverBySite.has(w.site_id)) coverBySite.set(w.site_id, []);
    coverBySite.get(w.site_id).push(w);
  }
  for (const [id, list] of coverBySite) {
    coverBySite.set(id, mergedWindows(
      list.map((w) => ({
        started_at: w.started_at,
        cancelled_at: w.cancelled_at,
        // חלונות מגיעים לכאן עם duration_hours ולא עם expires_at.
        expires_at: new Date(
          Date.parse(w.started_at) + (Number(w.duration_hours) || 0) * 3600000,
        ).toISOString(),
      })),
      windowStart, windowEnd,
    ));
  }

  // ⚠️ **ופעולה בתוך חלון אינה נספרת כלל** — כמו תחזוקה מהבקר, שבה ה-MODE
  // הוא 0 ולכן הסוכן אינו מייצר פעולות מלכתחילה. אותו כלל בדיוק כמו
  // `opsOf` ב-executive.mjs ו-`servedOps` בציר; שלושתם חייבים להסכים,
  // אחרת 'סך הפעולות' בכרטיס, בצ'יפ ובלוח התובנות ייתנו שלושה מספרים.
  const opCovered = (ts, siteId) => {
    const cover = coverBySite.get(siteId);
    return cover ? coveredMs(cover, Date.parse(ts), Date.parse(ts) + 1) > 0 : false;
  };
  ops = ops.filter((o) => !opCovered(o.occurred_at, o.site_id));

  // ⚠️ מפה של id → שם אתר, אופציונלית. במצב אתר בודד היא מיותרת (כל השורות
  // מאותו אתר) ולכן היא לא נדרשת — אבל במצרפת בלעדיה "כרטיס 4" מופיע חמש
  // פעמים בלי שום דרך להבדיל בין המופעים.
  const nameOf = (id) => (siteNames && siteNames.get(id)) || null;
  // ===== מונים בסיסיים =====
  let entries = 0, exits = 0, anomalies = 0, withCard = 0, withoutCard = 0;

  const byHour = Array.from({ length: 24 }, () => 0);
  const byWeekday = Array.from({ length: 7 }, () => 0);
  const byDay = new Map();     // "2026-07-12" → מספר פעולות
  // ==========================================================
  // זהות הכרטיס היא (אתר, מספר) — ולא המספר לבדו
  // ==========================================================
  // ⚠️ **מספרי הכרטיסים מקומיים לאתר.** נמדד בייצור: 33 מספרים ייחודיים
  // בסך הכל, 79% מהם מופיעים ביותר מאתר אחד, ו-"4" מופיע ב-11 אתרים. אלה
  // מספרים סידוריים לכל אתר, לא זהויות.
  //
  // קיבוץ לפי המספר לבדו מיזג 11 כרטיסים פיזיים של 11 אנשים שונים לשורה
  // אחת בטבלת "המשתמשים הפעילים ביותר" — ודירג אותה ראשונה, כי הסכום שלה
  // הוא סכום של אחת-עשרה. **התוצאה נראית סבירה לגמרי**, ולכן היא שרדה.
  //
  // באתר בודד אין הבדל (המספרים ייחודיים שם), ולכן זה נשבר רק במצרפת —
  // המסך היחיד שאיש לא השווה מול המקור.
  const cardKey = (o) => `${o.site_id}|${o.card_number}`;

  // "site|card" → { card, siteId, total, entries, exits, faultsOnEntry, faultsOnExit, lastAt }
  const cards = new Map();

  // חותמי הפתיחה של מקטעי התקלה, לזיהוי פעולה שנקטעה (ראה הלולאה למטה).
  //
  // ⚠️ errorRows כאן הן כבר **המסוננות** — תקלות שקרו בתחזוקה הוסרו לפני
  // הקריאה (ראה counted ב-getInsights). כלומר תקלה שהתרחשה בזמן תחזוקה לא
  // תיזקף לכרטיס, וזה נכון: היא ממילא אינה נספרת כתקלה בשום מדד אחר.
  const errorStartSet = new Set(errorRows.map((e) => e.started_at));

  // שיוך start↔end לחישוב משך פעולה. מפתח: אתר+כיוון+כרטיס (site_id חיוני
  // למצב המצרף — בלעדיו כרטיס זהה בשני אתרים היה משתייך בטעות).
  // ============================================================
  // המשכים נאספים **בנפרד לכל כיוון**
  // ============================================================
  // כניסה ויציאה אינן אותה פעולה מכנית: במגדל חניה הכנסת רכב היא חיפוש תא
  // פנוי והנחה, והוצאה היא איתור תא ידוע ומשיכה. ממוצע אחד לשתיהן מטשטש
  // בדיוק את ההבדל שמעניין — ואם אחת מהן מאטה, היא נבלעת בשנייה.
  //
  // durations הכולל נשמר גם הוא, כי המסך מציג "משך פעולה" אחד בראש.
  const openStarts = new Map();
  const durations = [];
  const durationsBy = { entry: [], exit: [] };
  // מספר כרטיס → { entry: [שניות], exit: [שניות] }
  const perCard = new Map();

  for (const op of ops) {
    const when = new Date(op.occurred_at);
    const key = `${op.site_id}|${op.entry_exit}|${op.card_number}`;

    if (op.start_end === "start") {
      openStarts.set(key, when.getTime());
      continue;   // רק end נחשב "פעולה שהושלמה"
    }

    // --- מכאן: הודעת end ---
    const start = openStarts.get(key);
    if (start !== undefined) {
      const seconds = (when.getTime() - start) / 1000;
      // מסננים משכים לא-סבירים (שיוך שגוי / הודעה שאבדה): מעל 4 שעות
      if (seconds > 0 && seconds < 4 * 3600) {
        durations.push(seconds);
        // ⚠️ נאסף גם על פעולה שאוחדה (superseded_by) ועל אנומליה, בדיוק כמו
        // durations הכולל: זה **משך מכני** ולא ספירת פעולות חניה. הסינון
        // היחיד הוא הסבירות (מעל 4 שעות = שיוך שגוי).
        if (durationsBy[op.entry_exit]) durationsBy[op.entry_exit].push(seconds);

        // ...ואותו משך גם לכרטיס עצמו, כדי שאפשר יהיה לפתוח שורה בטבלה
        // ולראות **מי** איטי — ולא רק שהאתר איטי בממוצע.
        if (op.card_number) {
          const per = perCard.get(cardKey(op))
            || { entry: [], exit: [] };
          if (per[op.entry_exit]) per[op.entry_exit].push(seconds);
          perCard.set(cardKey(op), per);
        }
      }
      openStarts.delete(key);
    }

    if (op.is_anomaly) {
      anomalies++;
      continue;   // אנומליה אינה פעולת חניה תקינה — לא נספרת במדדים
    }

    // ==========================================================
    // ניסיון שהוחלף: **הספירה יורדת, הייחוס נשאר**
    // ==========================================================
    // רכב שנתקע בתקלה וניסה שוב עבר פעם אחת, ולכן הוא אינו שתי כניסות. זה
    // בדיוק המקור למאזן הבלתי אפשרי לכרטיס בודד — 9 כניסות מול יציאה אחת.
    //
    // ⚠️ אבל הייחוס של התקלה לכרטיס **חייב** לשרוד: הניסיון הראשון הוא זה
    // שבגללו קרתה התקלה. `continue` פשוט כאן היה מוחק בדיוק את המידע שהעמודות
    // "תקלות בכניסה/ביציאה" נועדו להראות — ומשאיר תקלה בלי מי שהיה בפנים.
    const merged = Boolean(op.superseded_by);

    if (merged) {
      if (op.card_number && errorStartSet.has(op.occurred_at)) {
        const c = cards.get(cardKey(op))
          || { card: op.card_number, siteId: op.site_id, total: 0, entries: 0, exits: 0,
               faultsOnEntry: 0, faultsOnExit: 0, lastAt: null };
        if (op.entry_exit === "entry") c.faultsOnEntry++; else c.faultsOnExit++;
        cards.set(cardKey(op), c);
      }
      continue;
    }

    if (op.entry_exit === "entry") entries++;
    else if (op.entry_exit === "exit") exits++;

    byHour[when.getHours()]++;
    byWeekday[when.getDay()]++;

    const dayKey = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
    byDay.set(dayKey, (byDay.get(dayKey) || 0) + 1);

    if (op.card_number) {
      withCard++;
      const c = cards.get(cardKey(op))
        || { card: op.card_number, siteId: op.site_id, total: 0, entries: 0, exits: 0,
             faultsOnEntry: 0, faultsOnExit: 0, lastAt: null };
      c.total++;
      if (op.entry_exit === "entry") c.entries++; else c.exits++;

      // ==========================================================
      // תקלה שקרתה *בזמן* שהכרטיס הזה עבר
      // ==========================================================
      // הסוכן סוגר את הפעולה ופותח את מקטע התקלה באותו סבב דגימה ועם אותו
      // חותם, ולכן `end.occurred_at === error.started_at` מזהה זאת חד-משמעית
      // (אותו כלל בדיוק כמו ב-buildActivityLog).
      //
      // ⚠️ נספר רק על end. פתיחה לעולם אינה נקטעת, וספירה עליה הייתה מכפילה
      // כל תקלה.
      //
      // למה זה שווה: במדגם של 35 קטיעות נמצאו שלושה כרטיסים שכל אחד היה נוכח
      // ב-3 תקלות, שניים מהם באותו אתר. זה כבר לא רעש — זה מצביע על כרטיס
      // שהקורא מתקשה בו או על רכב שמפעיל את החיישן בעייתי. שניהם פתירים,
      // ואי אפשר לראות אותם בלי הקישור הזה.
      if (op.start_end === "end" && errorStartSet.has(op.occurred_at)) {
        if (op.entry_exit === "entry") c.faultsOnEntry++; else c.faultsOnExit++;
      }

      if (!c.lastAt || op.occurred_at > c.lastAt) c.lastAt = op.occurred_at;
      cards.set(cardKey(op), c);
    } else {
      withoutCard++;
    }
  }

  const operations = entries + exits;

  // ===== שיאים =====
  // ==========================================================
  // ⚠️ היום העמוס ביותר — ורק הוא. שוויון מחזיר את **כולם**
  // ==========================================================
  // כאן היו שני הימים העליונים, בנימוק שהשני נותן קנה מידה: 17 פעולות הוא
  // סיפור אחר כשהשני הוא 16 מאשר כשהוא 7.
  //
  // ⚠️ **וזה יצר בדיוק את הסתירה שהקוד הזה כבר תיקן פעם אחת אצל השעות.**
  // "השני בעומסו" הוצג בכרטיס משלו — 4 פעולות מול 3 — וקורא סביר הבין
  // ששניהם ימי שיא. הם לא: יום אחד הוא השיא, והשני פשוט הבא בתור.
  //
  // הכלל עכשיו זהה לזה של `busiestHours` למטה, ומאותו טעם בדיוק: מדגישים
  // לפי **ערך**, לא לפי מיקום בדירוג. יום נכנס אם ורק אם מספר הפעולות בו
  // שווה למקסימום.
  //
  // ⚠️ ומוחזר מערך ולא ערך יחיד: שוויון של שלושה ימים אפשרי לגמרי בטווח
  // קצר, וקיצוב קשיח היה מחזיר את אותה סתירה — רק נדירה יותר.
  //
  // ⚠️ המיון לפי **תאריך מוקדם** נשאר. שני ימים עם אותו מספר היו מתחלפים
  // בין ריצות לפי סדר ההגעה של השורות, ומספר שמשתנה בלי שהנתונים השתנו
  // הוא בדיוק מה שגורם לאבד אמון במסך.
  const dayLabel = (date) => {
    const d = new Date(`${date}T12:00:00`);
    return `${d.getDate()}.${d.getMonth() + 1} (${WEEKDAY_LABELS[d.getDay()]})`;
  };
  const peakDayValue = Math.max(0, ...byDay.values());
  const busiestDays = peakDayValue > 0
    ? [...byDay]
        .filter(([, operations]) => operations === peakDayValue)
        .map(([date, operations]) => ({ date, operations, label: dayLabel(date) }))
        .sort((a, b) => (a.date < b.date ? -1 : 1))
    : [];

  // נשמר לתאימות: הצרכנים הקיימים (וגם זרוע השרת) קוראים busiestDay.
  const busiestDay = busiestDays[0] || null;

  // ==========================================================
  // שוויון בשיא — **כל** השעות השוות, לא הראשונה שנמצאה
  // ==========================================================
  // ⚠️ נתפס על המסך, וזו סתירה בתוך אותו כרטיס: הגרף מדגיש בירוק כל עמודה
  // שערכה שווה למקסימום, ולכן הופיעו **שתי** עמודות ירוקות — 7:00 ו-16:00,
  // 7 פעולות כל אחת. הכיתוב מתחתיו אמר "השעה העמוסה ביותר: 7:00", כי
  // indexOf מחזיר את הראשונה בלבד.
  //
  // מי שקורא רואה שני שיאים בגרף ושם אחד בטקסט, ואז שואל איזה מהם נכון.
  // ההדגשה נגזרת מהערך; הכיתוב חייב להיגזר מאותו כלל בדיוק.
  //
  // ⚠️ ומוחזר מערך ולא "שתיים": שוויון של שלוש שעות אפשרי לגמרי בטווח קצר,
  // וקיצוב קשיח לשתיים היה מחזיר את אותה סתירה בדיוק, רק נדירה יותר.
  const peakHourValue = Math.max(...byHour);
  const busiestHours = peakHourValue > 0
    ? byHour
        .map((operations, hour) => ({ hour, operations }))
        .filter((h) => h.operations === peakHourValue)
    : [];

  // נשמר לתאימות: הצרכנים הקיימים קוראים busiestHour.
  const busiestHour = busiestHours[0] || null;

  const activeDays = byDay.size;
  const dailyAverage = activeDays > 0
    ? Math.round((operations / activeDays) * 10) / 10
    : 0;

  // ===== משכי פעולה =====
  //
  // ⚠️ החציון על מדגם **זוגי** לוקח את האיבר העליון ולא את ממוצע השניים
  // האמצעיים. זו הגדרה מקלה, אבל היא חייבת להיות **זהה בכל שלושת החישובים**
  // (כולל, כניסה, יציאה) — אחרת "חציון כניסה" ו"חציון כולל" מחושבים אחרת
  // ואי אפשר להשוות ביניהם. לכן פונקציה אחת, לא שלושה עותקים.
  const statsOf = (list) => {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    return {
      samples: s.length,
      averageSeconds: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
      medianSeconds: Math.round(s[Math.floor(s.length / 2)]),
      longestSeconds: Math.round(s[s.length - 1]),
      shortestSeconds: Math.round(s[0]),
    };
  };

  const durationStats = statsOf(durations);
  const durationsByDirection = {
    entry: statsOf(durationsBy.entry),
    exit: statsOf(durationsBy.exit),
  };

  // ============================================================
  // סיכום הכרטיסים — מי המהיר, מי האיטי, מי הפעיל, מי הבעייתי
  // ============================================================
  // ⚠️ **סף של 3 מדגמים** על המהיר/האיטי. בלעדיו "הכי מהיר" הוא תמיד כרטיס
  // שנמדד פעם אחת במקרה — מספר שנראה מדויק ואינו אומר כלום. "הכי פעיל"
  // ו"הכי הרבה תקלות" אינם צריכים סף: הם ספירות, לא ממוצעים.
  const MIN_SAMPLES = 3;

  // ⚠️ **המהיר נמדד לכל כיוון בנפרד.** ממוצע על שני הכיוונים יחד היה מערבב
  // שתי פעולות מכניות שונות — נמדד שכניסה ארוכה מיציאה ב-31% בממוצע המערכת,
  // ובאתר אחד הכיוון אף מתהפך. "הכרטיס המהיר" בלי כיוון הוא בעיקר הכרטיס
  // שבמקרה יצא יותר משנכנס.
  const fastestIn = (dir) => {
    const timed = [...perCard.entries()]
      // ⚠️ המפתח הוא "אתר|כרטיס", ולכן מפצלים חזרה לשני שדות. בלי זה
      // "הכרטיס המהיר" היה מוצג על המסך כ-"3|12".
      .map(([key, p]) => {
        const [siteId, card] = key.split("|");
        const list = p[dir];
        return list.length >= MIN_SAMPLES
          ? { card, siteId: Number(siteId), samples: list.length,
              averageSeconds: Math.round(list.reduce((a, b) => a + b, 0) / list.length) }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.averageSeconds - b.averageSeconds);
    return { best: timed[0] ?? null, count: timed.length };
  };

  const fEntry = fastestIn("entry");
  const fExit = fastestIn("exit");

  const allCards = [...cards.values()];
  const pickMax = (list, key) =>
    list.length ? list.reduce((best, c) => (c[key] > best[key] ? c : best)) : null;

  const faulty = allCards
    .map((c) => ({ card: c.card, faults: c.faultsOnEntry + c.faultsOnExit }))
    .filter((c) => c.faults > 0);

  const cardsSummary = {
    minSamples: MIN_SAMPLES,
    // null כשאין אף כרטיס שעבר את הסף — המסך אומר זאת במפורש ולא מציג "—".
    fastestEntry: fEntry.best,
    fastestExit: fExit.best,
    timedEntry: fEntry.count,
    timedExit: fExit.count,
    mostActive: pickMax(allCards, "total"),
    mostFaults: pickMax(faulty, "faults"),
  };

  // ===== השבתות (מקטעי error בטווח) — errorRows נשלף למעלה במקביל =====

  // ============================================================
  // השבתה שהסתיימה בטיפול אינה כמו השבתה שנפתרה מעצמה
  // ============================================================
  // שתיהן "אירוע השבתה" באותה טבלה, והן שני דברים שונים לגמרי מבחינה
  // תפעולית:
  //
  //   **טופלה** — מיד כשהתקלה נגמרה נפתח מקטע תחזוקה. מישהו הגיע לאתר.
  //     ⚠️ **מה שאיננו יודעים לא נאמר:** אין בנתונים דבר שמבחין בין
  //     טיפול מרחוק להגעה פיזית. הסימן היחיד הוא שנפתח מקטע תחזוקה.
  //   **התאוששה מעצמה** — האתר חזר ל'מוכן' או ל'בפעולה' בלי התערבות.
  //     לרוב ריצוד או תקלה רגעית שהמכונה ניקתה בעצמה.
  //
  // אתר עם 5 השבתות שכולן נפתרו לבד הוא סיפור אחר לגמרי מאתר עם 5 השבתות
  // שכולן הצריכו טיפול — ובכרטיס אחד הם נראים זהים.
  //
  // ⚠️ אותו כלל זיהוי בדיוק כמו פילוח התחזוקה:
  //     error.ended_at === maintenance.started_at
  // הסוכן סוגר מקטע ופותח את הבא באותו סבב דגימה, ולכן החותם משותף.
  // שני העותקים חייבים להישאר זהים — אחרת אותו אירוע ייספר כ"טופל" בכרטיס
  // אחד וכ"התאושש" באחר.
  //
  // ⚠️ הסכומים נשמרים: טופלו + התאוששו = אירועי השבתה, תמיד. זה פילוח ולא
  // מדד חדש, ו-totalDownMs אינו זז.
  // ============================================================
  // ⚠️ הספירה מקופלת, המשך **אינו** אירוע חדש — אבל הזמן שלו קיים
  // ============================================================
  // errorRows/maintRows שמגיעים לכאן עברו collapseNoCommFlicker, שמפילה
  // המשכים: ב-`error → no_comm → error` השני נעלם, כי זו אותה השבתה ולא
  // שתיים. לספירת אירועים זה **נכון**.
  //
  // ⚠️ אבל הסכומים רצו על אותה רשימה מקוצצת, ולכן כל דקה של כל מקטע
  // המשך פשוט **נמחקה מהמדד**. נמדד באתר אמיתי: 'זמן השבתה' הראה 0.50
  // שעות, בעוד uptimeFromData().errorHours על אותו אתר ואותה תקופה נתן
  // 1.92 — **אותו מסך, שני מספרים שונים לאותו דבר**, וזה שנראה טוב יותר
  // הוא זה שהיה שגוי.
  //
  // הפתרון: מקבצים כל מקטע המשך אל האירוע שהוא ממשיך. המונה נשאר מספר
  // האירועים המקופלים; המשך נספר בזמן, לא באירועים.
  const rawOf = (status) => (allRows
    ? allRows.filter((r) => r.status === status)
    : (status === "error" ? errorRows : maintRows));

  // כל מקטע גולמי מקבל את העוגן (המקטע המקופל) שהוא שייך לו: העוגן
  // האחרון **באותו אתר** שהתחיל לא אחריו. אתר חיוני — במצרפת המקטעים של
  // כל האתרים מעורבים ברשימה אחת.
  const incidentsOf = (kept, all) => {
    const anchorsBySite = new Map();
    for (const k of kept) {
      if (!anchorsBySite.has(k.site_id)) anchorsBySite.set(k.site_id, []);
      anchorsBySite.get(k.site_id).push(k);
    }
    for (const list of anchorsBySite.values()) {
      list.sort((x, y) => (x.started_at < y.started_at ? -1 : 1));
    }

    const groups = new Map();          // עוגן → מקטעים גולמיים
    for (const k of kept) groups.set(k, []);

    for (const row of all) {
      const list = anchorsBySite.get(row.site_id);
      if (!list) continue;             // מקטע שאין לו עוגן כלל — סונן לפני
      let anchor = null;
      for (const k of list) {
        if (k.started_at <= row.started_at) anchor = k; else break;
      }
      if (anchor) groups.get(anchor).push(row);
    }
    return groups;
  };

  // ============================================================
  // ⚠️ אותם שני כללים שהזמינות כבר מחילה — לא הגדרה חדשה
  // ============================================================
  // 'זמן השבתה' כאן סכם כל שנייה של כל מקטע error, בעוד
  // uptimeFromData().errorHours מחיל שני חריגים שכבר הוכרעו:
  //
  //   1. **מקטע שסומן כניסוי** (excluded_at) אינו נמדד כלל — לא במונה
  //      ולא במכנה. מישהו קבע שהוא לא קרה.
  //   2. **חלון תחזוקה ידני מכסה** את מה שנפל בתוכו: הזמן הזה הוא
  //      תחזוקה, לא השבתה. זו בדיוק הסיבה שהחלון קיים.
  //
  // ⚠️ בלי שניהם אותו מסך הראה שני מספרים לאותו דבר. נמדד: ז'בוטינסקי
  // 35.01 מול 29.84, אוסישקין 12.25 מול 10.00, נמל דולי 8.18 מול 7.00.
  // וזה גרוע ממספר שגוי אחד — שני מספרים סבירים סותרים זה את זה, ואין
  // דרך לדעת במי להאמין.
  //
  // ⚠️ הכיסוי נבנה **לכל אתר בנפרד**: במצרפת חלון באתר א' אינו מכסה
  // דבר באתר ב'. חלון שסומן כניסוי אינו מכסה כלום — אותו כלל כמו שם.

  // המשך של מקטע = הזמן שלו **בניכוי** מה שכוסה ומה שהוצא.
  const clipped = (row) => {
    if (row.excluded_at) return 0;
    const s = Math.max(Date.parse(row.started_at), windowStart);
    const e = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
    if (!(e > s)) return 0;
    const cover = coverBySite.get(row.site_id);
    return (e - s) - (cover ? coveredMs(cover, s, e) : 0);
  };

  const rawErrors = rawOf("error");
  const rawMaint = rawOf("maintenance");

  // ⚠️ החותמים נלקחים מהמקטעים ה**גולמיים**: התחזוקה שבאה לתקן נפתחת
  // בדיוק כשהמקטע האחרון של האירוע נסגר — וזה בדרך כלל מקטע המשך, שלא
  // היה ברשימה המקופלת. הזיהוי "תפעול תקלה" פספס בגללו אירועים שלמים.
  const maintStartSet = new Set(rawMaint.map((m) => m.started_at));

  const errIncidents = incidentsOf(errorRows, rawErrors);

  let totalDownMs = 0, longestMs = 0, longestAt = null;
  let handledCount = 0, handledMs = 0;
  for (const [anchor, rows] of errIncidents) {
    let span = 0;
    for (const r of rows) span += clipped(r);
    if (span <= 0) continue;
    totalDownMs += span;
    if (span > longestMs) {
      longestMs = span;
      longestAt = anchor.started_at;
    }
    // סוף האירוע הוא סוף המקטע האחרון שלו, לא של העוגן.
    const last = rows.reduce((a, b) => (a && a.started_at > b.started_at ? a : b), null);
    const row = { ended_at: last ? last.ended_at : anchor.ended_at };
    // ⚠️ רק תקלה שנגמרה יכולה להיות "טופלה". תקלה פתוחה עדיין רצה, ואין
    // לה ended_at שאפשר להתאים אליו — היא תיספר כ"התאוששה" בטעות אם לא
    // נשמור על התנאי הזה.
    if (row.ended_at && maintStartSet.has(row.ended_at)) {
      handledCount++;
      handledMs += span;
    }
  }

  const hrs = (ms) => Math.round((ms / 3600000) * 100) / 100;
  const incidents = errorRows.length;

  // ===== תחזוקה — מתוכננת, ולכן נמדדת בנפרד מהשבתות =====
  // שני מקורות: מצב תחזוקה שמדווח מה-PLC (maintRows), וחלונות תחזוקה ידניים
  // שהופעלו מהדשבורד (windows). שניהם נשלפו למעלה במקביל.
  // ============================================================
  // תחזוקה שבאה אחרי תקלה היא **תפעול תקלה**, לא תחזוקה מתוכננת
  // ============================================================
  // שתיהן נראות זהות בטבלה — מקטע `maintenance` — אבל הן שני דברים הפוכים:
  //
  //   **מתוכננת** — מישהו בחר להוריד את האתר. זו החלטה, והיא סימן טוב.
  //   **תפעול תקלה** — האתר נפל, ומישהו בא לתקן. זו תוצאה, והיא זמן השבתה
  //     לכל דבר מבחינת מי שרצה לחנות.
  //
  // ערבוב שלהן מייפה את התמונה: אתר שנופל שלוש פעמים בשבוע ומתוקן בכל פעם
  // נראה כמו אתר שעובר תחזוקה שוטפת מסודרת. נמדד: **18 מתוך 141 (13%)**
  // ממקטעי התחזוקה מתחילים בדיוק כשתקלה נגמרת.
  //
  // ⚠️ הזיהוי חד-משמעי ואינו הערכה: `error.ended_at === maintenance.started_at`.
  // הסוכן סוגר מקטע ופותח את הבא באותו סבב דגימה, ולכן החותם משותף בדיוק.
  //
  // ⚠️ **הזמן עצמו לא זז בין המדדים.** תפעול תקלה נשאר תחזוקה לצורך חישוב
  // הזמינות — הוא עדיין מוחרג מהמכנה, בדיוק כמו קודם. מה שהשתנה הוא רק
  // ה**סיווג** בתצוגה. שינוי הזמינות היה דורש parity חדש, וזו לא הבקשה.
  const errorEnds = new Set(rawErrors.map((e) => e.ended_at).filter(Boolean));
  const isRepair = (row) => errorEnds.has(row.started_at);

  let maintMs = 0, longestMaintMs = 0;
  let repairMs = 0, repairCount = 0;
  // ⚠️ **הארוך ביותר נמדד בנפרד לכל קטגוריה.** מדד אחד לשתיהן היה מוצג תחת
  // הכותרת "תחזוקה" גם כשהערך הגיע דווקא מתפעול תקלה — מספר נכון תחת שם
  // שגוי, וזה גרוע ממספר חסר.
  let longestRepairMs = 0, longestPlannedMs = 0;
  const maintIncidents = incidentsOf(maintRows, rawMaint);
  for (const [anchor, rows] of maintIncidents) {
    let span = 0;
    for (const r of rows) span += clipped(r);
    if (span <= 0) continue;
    maintMs += span;
    if (span > longestMaintMs) longestMaintMs = span;

    if (isRepair(anchor)) {
      repairMs += span; repairCount++;
      if (span > longestRepairMs) longestRepairMs = span;
    } else if (span > longestPlannedMs) {
      longestPlannedMs = span;
    }
  }

  // ספירות "שהתחילו בתקופה" — לפילוח הפעילות (כניסות/יציאות/תקלות/תחזוקה)
  // היחידה חייבת להיות אחידה: אירועים שקרו בתקופה. זה עקבי עם *גרף המגמה*
  // (getPeriodBreakdown סופר כניסה למצב בתוך [from,to)), בשונה מ-
  // downtime.incidents / maintenance.plcEntries שסופרים *חפיפה* (מקטע שהתחיל
  // לפני התקופה ונמשך לתוכה).
  //
  // הערה: 'errors' כאן סופר את *כל* התקלות שהתחילו בתקופה, כולל כאלה שקרו בזמן
  // תחזוקה. זה שונה מ-analytics.stats.errors (הכרטיס), שמחריג בכוונה תקלות
  // שקרו בחלון תחזוקה — כי לא מענישים על תקלה בהשבתה מתוכננת. לפילוח "כמה
  // אירועים קרו" הספירה המלאה נכונה; אחוז הכשל הוא מדד אחר.
  //
  // errorRows/maintRows כבר מסוננים ל-started_at < to, ולכן די בסינון >= from.
  //
  // תקלה שהתחילה בזמן/בגבול תחזוקה (בתוך מקטע maintenance מהבקר) אינה נספרת —
  // "תחזוקה גוברת", עקבי עם statsFromData ועם גרף המגמה. חלונות ידניים כבר
  // נחסמים בקליטה (state-handler); כאן בדיקת ה-PLC מכסה את המקרה ההיסטורי השכיח.
  // חפיפה לתחזוקה *של אותו אתר* (site_id) — כדי שבמצב המצרף תקלה באתר א' לא
  // תושתק בגלל תחזוקה באתר ב'. לאתר בודד זה זהה להתנהגות הקודמת (הכול אותו אתר).
  const inMaint = (ts, siteId) =>
    maintRows.some((s) => s.site_id === siteId && s.started_at <= ts && (s.ended_at === null || s.ended_at >= ts));
  const errorsStarted = errorRows.filter(
    (r) => r.started_at >= from && !inMaint(r.started_at, r.site_id)
  ).length;
  const maintenanceEvents =
    maintRows.filter((r) => r.started_at >= from).length + windows.length;

  return {
    totals: {
      operations,
      entries,
      exits,
      anomalies,
      activeDays,
      errors: errorsStarted,           // כל התקלות שהתחילו בתקופה (כמו גרף המגמה)
      maintenanceEvents,               // כניסות לתחזוקה (PLC) + חלונות ידניים, שהתחילו בתקופה
    },
    cards: {
      uniqueCards: cards.size,
      withCard,
      withoutCard,
      // ⚠️ המשכים מוצמדים **רק לעשרה שמוצגים**, ולא לכל הכרטיסים. אתר עם 40
      // כרטיסים היה שולח 40 אובייקטי סטטיסטיקה שאיש לא רואה — ובמצב הישיר
      // הכל עובר ברשת אל הדפדפן.
      top: [...cards.values()]
        .sort((a, b) => b.total - a.total || (a.card < b.card ? -1 : 1))
        .slice(0, 10)
        .map((c) => {
          // ⚠️ המפתח המורכב, ולא c.card בלבד: אחרת המשכים של כרטיס 4
          // באתר אחד היו מוצמדים לכרטיס 4 של אתר אחר.
          const p = perCard.get(`${c.siteId}|${c.card}`);
          return {
            ...c,
            // ⚠️ **בלי השם, התיקון גרוע מהבאג.** במקום שורה אחת שגויה
            // ("כרטיס 4 — 169 פעולות") היו חמש שורות נכונות שנראות זהות
            // ("כרטיס 4" חמש פעמים), ואי אפשר לדעת מי מהן איזה אתר.
            siteName: nameOf(c.siteId),
            // ⚠️ **לכל כיוון בנפרד, בלי סיכום משותף.** היה כאן גם
            // longestSeconds/shortestSeconds על שני הכיוונים יחד, והוסרו:
            // הקיצון כמעט תמיד שייך לכיוון אחד, ובלי לדעת לאיזה אי אפשר
            // לעשות איתו כלום — כרטיס עם יציאה של 30 דקות נראה בדיוק כמו
            // כרטיס עם כניסה של 30. statsOf כבר מחזירה longest/shortest
            // לכל צד.
            durations: p
              ? { entry: statsOf(p.entry), exit: statsOf(p.exit) }
              : null,
          };
        }),

      // ============================================================
      // סיכום — על **כל** הכרטיסים, לא רק העשרה המוצגים
      // ============================================================
      // הטבלה עונה "מי הכי פעיל". השאלה שנשאלת מיד אחריה היא "ומי הכי איטי",
      // והתשובה עלולה להיות כרטיס שכלל אינו בעשירייה — כרטיס עם 4 פעולות
      // איטיות במיוחד לא ייכנס לדירוג הפעילות אבל הוא בדיוק מה שמחפשים.
      //
      // ⚠️ סף של 3 מדגמים, וזה לא זהירות יתר: בלעדיו "הכי מהיר" הוא תמיד
      // כרטיס שנמדד פעם אחת במקרה, והמספר חסר משמעות. נמדד שיש כרטיסים עם
      // מדגם בודד כמעט בכל אתר.
      summary: cardsSummary,
    },
    activity: {
      byHour: byHour.map((operations, hour) => ({ hour, operations })),
      byWeekday: byWeekday.map((operations, i) => ({
        weekday: i,
        label: WEEKDAY_LABELS[i],
        operations,
      })),
      busiestDay,
      busiestDays,
      busiestHour,
      busiestHours,
      dailyAverage,
    },
    durations: durationStats,
    // כניסה ויציאה בנפרד. כל צד null אם לא היו מספיק זוגות start↔end בכיוון.
    durationsByDirection,
    downtime: {
      incidents,
      totalHours: hrs(totalDownMs),
      longestHours: hrs(longestMs),
      averageHours: incidents > 0 ? hrs(totalDownMs / incidents) : 0,
      longestAt,
      // ---- הפילוח: טופלה מול התאוששה מעצמה ----
      // handledIncidents + recoveredIncidents === incidents, תמיד.
      handledIncidents: handledCount,
      handledHours: hrs(handledMs),
      recoveredIncidents: incidents - handledCount,
      recoveredHours: hrs(totalDownMs - handledMs),
    },
    maintenance: {
      plcEntries: maintRows.length,                // כמה פעמים האתר נכנס למצב תחזוקה
      totalHours: hrs(maintMs),                    // סך הזמן בתחזוקה
      longestHours: hrs(longestMaintMs),

      // ---- הפילוח: תפעול תקלה מול מתוכננת ----
      // repairEntries + plannedEntries === plcEntries, תמיד.
      repairEntries: repairCount,
      repairHours: hrs(repairMs),
      longestRepairHours: hrs(longestRepairMs),
      plannedEntries: maintRows.length - repairCount,
      plannedHours: hrs(maintMs - repairMs),
      longestPlannedHours: hrs(longestPlannedMs),
      manualWindows: windows.length,               // חלונות שהופעלו ידנית מהדשבורד
      cancelledWindows: windows.filter((w) => w.cancelled_at).length,
      // ============================================================
      // ⚠️ ממיינים כאן ולא סומכים על הקורא
      // ============================================================
      // `slice(0,5)` לקח את סדר הקורא — ושתי הזרועות ממיינות הפוך:
      // השרת ב-`ORDER BY started_at DESC`, והזרוע הישירה ב-ascending.
      // כלומר במצב הישיר, שהוא מה שרץ היום, הפאנל "חלונות תחזוקה
      // אחרונים" הציג את החמישה **הישנים ביותר**.
      //
      // ⚠️ ו-parity-insights לא יכול לתפוס את זה: שתי זרועותיו שולפות
      // חלונות בלי ORDER BY בכלל, כך שהן הסכימו על סדר שרירותי.
      recentWindows: [...windows]
        .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
        .slice(0, 5).map((w) => ({
        setBy: w.set_by_name,
        reason: w.reason,
        startedAt: w.started_at,
        durationHours: w.duration_hours,
        cancelled: Boolean(w.cancelled_at),
        siteName: w.site_name ?? null,   // מוצג רק במצב "כל האתרים"
      })),
    },
  };
}

export function mergedWindows(windows, windowStart, windowEnd) {
  const spans = [];
  for (const w of windows) {
    const s = Math.max(Date.parse(w.started_at), windowStart);
    const e = Math.min(Date.parse(w.cancelled_at || w.expires_at), windowEnd);
    if (e > s) spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

export function coveredMs(merged, start, end) {
  let total = 0;
  for (const [s, e] of merged) {
    if (e <= start) continue;
    if (s >= end) break;              // ממוינים — אין טעם להמשיך
    total += Math.min(e, end) - Math.max(s, start);
  }
  return total;
}

export function collapseNoCommFlicker(segments) {
  const out = [];
  let lastObserved = null;   // המצב האחרון שאינו no_comm

  for (const s of segments) {
    // נתק נשמר תמיד — הוא לא "מאפס" את המצב שקדם לו, רק מסתיר אותו.
    if (s.status === "no_comm") {
      out.push(s);
      continue;
    }
    // חזרה לאותו מצב בדיוק = המשך, לא אירוע חדש.
    if (s.status === lastObserved) continue;

    out.push(s);
    lastObserved = s.status;
  }
  return out;
}

export function collapseSegmentsBySite(segments) {
  const bySite = new Map();
  for (const s of segments) {
    if (!bySite.has(s.site_id)) bySite.set(s.site_id, []);
    bySite.get(s.site_id).push(s);
  }
  const kept = new Set();
  for (const segs of bySite.values()) {
    for (const s of collapseNoCommFlicker(segs)) kept.add(s);
  }
  return segments.filter((s) => kept.has(s));
}
