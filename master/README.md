# Master — צד השרת של Parkomat

קולט טלמטריה מהאתרים דרך MQTT, שומר ב-PostgreSQL (Supabase), ומגיש REST API + SSE לדשבורד.

```
PLC → Agent → Mosquitto → (גשר TLS) → HiveMQ → [ Master ] → PostgreSQL → API/SSE → דשבורד
```

## התקנה והרצה

```sh
cd master
npm install
npm start          # מריץ master.js: MQTT + ingestion + API על פורט 4000
```

הגדרות סביבה — **חובה**, בלעדיהן ה-Master נעצר מיד עם הודעה מפורשת:

| משתנה | תיאור |
|---|---|
| `HIVEMQ_HOST` | כתובת ה-Broker |
| `HIVEMQ_PORT` | פורט (8883 ל-TLS) |
| `MASTER_USERNAME` | שם משתמש ב-HiveMQ |
| `MASTER_PASSWORD` | סיסמה |
| `MASTER_CLIENT_ID` | אופציונלי. ברירת מחדל `master` |
| `DASHBOARD_ORIGIN` | אופציונלי. ברירת מחדל `http://localhost:5173` |

## רישום אתרים

**הרישום הוא השער לקליטה.** ה-dispatcher דוחה כל הודעה מקוד אתר שאינו רשום —
המידע מהאתר מתחיל להישמר רק אחרי שרשמו אותו.

```sh
# דרך ה-API (plc_type / plc_ip / site_ip אופציונליים)
curl -X POST http://localhost:4000/api/sites \
  -H "Content-Type: application/json" \
  -d '{"code":"rothschild-01","site_name":"רחוב רוטשילד","plc_type":"S7-300"}'

# או מהשורה (בלי שהשרת רץ)
npm run add-site -- rothschild-01 "רחוב רוטשילד"
```

**קוד האתר חייב להיות זהה ל-`SiteId` שמוגדר בסוכן שרץ באתר** — הוא ה-`{code}` בנתיב
`sites/{code}/state`. קוד שונה פירושו שכל הודעה מהאתר תידחה כ"אתר לא רשום".

קוד האתר נכנס כמות שהוא לנתיב ה-MQTT, ולכן מוגבל ל-`^[A-Za-z0-9_-]{1,64}$` —
`/`, `+` ו-`#` נדחים, אחרת אתר אחד יוכל להאזין לנושאים של אחר.

## API

| שיטה | נתיב | תיאור |
|---|---|---|
| `POST` | `/api/sites` | רישום אתר: `{ code, site_name, plc_type?, plc_ip?, site_ip? }` → 201 / 409 / 400 |
| `GET` | `/api/sites` | כל האתרים + מצב, אחוז כשל, פעולות, זמינות (7 ימים) |
| `GET` | `/api/sites/:code` | אתר בודד + פעולות, היסטוריית מצב ותחזוקה |
| `GET` | `/api/sites/:code/stats` | מדדים לטווח `?from=&to=` |
| `POST` | `/api/sites/:code/maintenance` | הפעלת חלון תחזוקה |
| `DELETE` | `/api/sites/:code/maintenance` | ביטול תחזוקה פעילה |
| `GET` | `/api/events` | פעולות מסוננות: `?site_code=&from=&to=&limit=` |
| `GET` | `/api/stats/system` | סיכום מערכתי |
| `GET` | `/api/stream` | SSE — עדכונים בזמן אמת |

אירועי ה-SSE: `state`, `operation`, `registered`.

## החוזה מול הסוכן (קל לשבור בשוגג)

- **נושאים:** `sites/{code}/state`, `sites/{code}/operation`, `sites/{code}/bridge`.
- **חותמי זמן הם unix-*שניות*,** לא מילישניות. הודעה עם זמן לפני 2020 נדחית.
- **מצבים חוקיים:** `ready`, `operating`, `error`, `maintenance`, `no_comm`.
- **`no_comm` מגיע מ-LWT — בשתי שכבות, ולא אחת.** אין watchdog ואין heartbeat בשרת;
  "כלל 90 השניות" הוא **1.5 × keepalive של 60 שניות**, ומי שאוכף אותו הוא הברוקר.
  1. *הסוכן מול Mosquitto המקומי* — JSON `{"timestamp":0,"state":"no_comm"}` על `state`.
     מכסה: תהליך הסוכן קרס והמחשב חי.
  2. *הגשר מול HiveMQ* — `"1"`/`"0"` על `bridge`. מכסה: **המחשב כולו מת** (נפילת חשמל) —
     אז Mosquitto מת עם הסוכן ואין מי שישדר את שכבה 1.
- **`no_comm` אינו מעדכן `last_seen`** — ניתוק אינו "צפייה". אחרת אתר מת נראה "נצפה זה עתה".
- **`user` (מספר כרטיס) חייב להיות `""` ולא `null`** — הוא חלק ממפתח ה-dedup.
  אם בכל זאת מגיע `null`, ה-dispatcher מנרמל ל-`""` במקום לאבד את הפעולה.
- **מפתח ה-dedup:** `(site_id, occurred_at, start_end, entry_exit, card_number)`.
  QoS 1 הוא *at-least-once* — מסירה כפולה היא התנהגות תקינה, לא שגיאה.
- **מונה הסייקלים:** הסוכן שולח את הערך הגולמי המצטבר מהבקר; ה-Master מחשב delta
  ומזהה `reset` (המונה ירד) ו-`backfill` (הודעה שהגיעה מאוחר). רק הודעת `end` מקדמת אותו.

## חיבור ה-MQTT

`clientId` קבוע יחד עם `clean: false` — כך ה-Broker שומר את הודעות ה-QoS 1 בזמן
שה-Master למטה ומוסר אותן בהתחברות הבאה. **רק מופע אחד** של ה-Master יכול לרוץ עם
אותו `MASTER_CLIENT_ID`; שני מופעים ינתקו זה את זה.

## מדדים נגזרים

- **`uptime`** — אחוז הזמן ב-7 הימים האחרונים שבו האתר *לא* היה ב-`error` או `no_comm`,
  מחושב מ-`status_history`. `null` כשאין היסטוריה (אתר שנרשם ומעולם לא דיווח) — כדי
  שהדשבורד יציג `—` ולא `0%` מטעה. הזמן שקדם לרישום האתר אינו נספר.
- **`failureRate`** — אחוז התקלות מתוך הפעולות. תקלות שהתרחשו בתוך חלון תחזוקה מוחרגות.

## מסד הנתונים

**PostgreSQL, מתארח ב-Supabase.** החיבור נקבע ב-`DATABASE_URL` (חובה — השרת לא עולה בלעדיו),
ועובר דרך ה-**pooler** במצב טרנזקציה (פורט 6543). *לא* דרך `db.<ref>.supabase.co` — הוא IPv6
בלבד ולא ייפתר.

הסכמה ב-`db/schema.postgres.sql`, נטענת בכל עלייה (`CREATE TABLE IF NOT EXISTS`). היא רצה
דרך חיבור **session** חד-פעמי (5432), כי ה-pooler הטרנזקציוני דוחה סקריפט DDL מרובה-פקודות.

> `db/schema.sql` ו-`better-sqlite3` הם שרידים מתים מהתקופה שלפני ההגירה. אף אחד לא קורא אותם.

תחזוקה יומית אוטומטית (מ-`master.js`): גיבוי → סיכום חודשי → ניקוי raw מעל שנה.

> ⚠️ `tools/backup-db.js` **אינו מגבה** — הוא מדפיס שהוא דילג. Supabase מגבה אוטומטית
> **רק בתוכנית Pro ומעלה** (יומי, שמירה 7 ימים); בתוכנית החינמית **אין גיבוי כלל**.
> `tools/inspect-db.js` עדיין קורא את קובץ ה-SQLite המת ולכן **מציג נתונים שגויים**.

## מסד בדיקות

פרויקט Supabase נפרד. הגדרות ב-`master/.env.test` (מוחרג מגיט; תבנית ב-`.env.test.example`).

```sh
npm run test:db:init     # סכמה + סימון המסד כמסד בדיקות
npm run test:db:seed     # נתונים סינתטיים דטרמיניסטיים
npm run test:db:reset    # ריקון
```

ההגנה היא **סימון חיובי בתוך המסד** (`settings['environment'] = 'test'`), לא רשימה שחורה של
כתובות. סקריפט הרסני דורש לראות את הסימון ומסרב בלעדיו — ולפרודקשן אין סימון. ראה
`db/test-guard.js`.
