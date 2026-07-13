# Master — צד השרת של Parkomat

קולט טלמטריה מהאתרים דרך MQTT, שומר ב-SQLite, ומגיש REST API + SSE לדשבורד.

```
PLC → Agent → Mosquitto → (גשר TLS) → HiveMQ → [ Master ] → SQLite → API/SSE → דשבורד
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

- **נושאים:** `sites/{code}/state` ו-`sites/{code}/operation`.
- **חותמי זמן הם unix-*שניות*,** לא מילישניות. הודעה עם זמן לפני 2020 נדחית.
- **מצבים חוקיים:** `ready`, `operating`, `error`, `maintenance`, `no_comm`.
- **`no_comm` מגיע מה-LWT** — ה-Broker משדר אותו *בשם* הסוכן כשהוא מתנתק, עם
  `timestamp: 0`. לכן הוא **אינו מעדכן `last_seen`**: ניתוק אינו "צפייה". אם
  יעדכן, אתר מת ייראה "נצפה זה עתה" וכלל 90 השניות של ה-PRD לא יתפוס אותו.
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

`sitemonitor.db` (SQLite, WAL). הסכמה ב-`db/schema.sql` נטענת בכל עלייה
(`CREATE TABLE IF NOT EXISTS`), כך שהקובץ נוצר לבד בהרצה הראשונה.

**עמודה חדשה לא נוצרת במסד קיים** דרך `CREATE TABLE IF NOT EXISTS`. לכן `db/db.js`
מריץ `ALTER TABLE` idempotent (`addMissingColumns`) — כשמוסיפים עמודה ל-`schema.sql`,
צריך להוסיף אותה גם שם.

תחזוקה יומית אוטומטית (מ-`master.js`): גיבוי → סיכום חודשי → ניקוי raw מעל שנה.

כלים: `tools/inspect-db.js`, `tools/backup-db.js`, `tools/monthly-summary.js`,
`tools/cleanup-old-data.js`.
