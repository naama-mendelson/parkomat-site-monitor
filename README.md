# Parkomat — SiteMonitor

מערכת ניטור לחניונים אוטומטיים. עוקבת אחר מצב האתרים בזמן אמת, קולטת פעולות
חניה (כניסות/יציאות) מהבקר, ומציגה סטטיסטיקות ותקלות בדשבורד.

```
PLC ──Modbus──► Agent ──MQTT──► Mosquitto ──TLS──► HiveMQ ──► Master ──► PostgreSQL
                                                                 │         (Supabase)
                                                          REST + SSE
                                                                 │
                                                            Dashboard
```

## הרכיבים

| תיקייה | מה זה | טכנולוגיה |
|---|---|---|
| [`Parkomat.Agent/`](Parkomat.Agent) | רץ על מחשב **באתר**. קורא את ה-PLC ב-Modbus-TCP ומשדר את המצב ל-MQTT. | C# / .NET 10 (Windows Service + Tray) |
| [`master/`](master) | **השרת**. קולט את הטלמטריה מ-HiveMQ, שומר ב-PostgreSQL, ומגיש REST + SSE. | Node.js / Express / pg (Supabase) |
| [`dashboard/`](dashboard) | **הדשבורד**. ניטור חי, סטטיסטיקות, לוג פעילות. | React 19 / Vite |

## פריסה בשרת (Docker) — המסלול לפרודקשן

זו הדרך להריץ את המערכת על שרת always-on. **שירות אחד בלבד**: Postgres
(Supabase) ו-MQTT (HiveMQ) הם שירותים מנוהלים חיצוניים, ולכן אין כאן קונטיינר
של בסיס נתונים או ברוקר.

```sh
git clone https://github.com/naama-mendelson/parkomat-site-monitor.git
cd parkomat-site-monitor

cp .env.docker.example .env     # ← בשורש הריפו, ליד docker-compose.yml
#  מלא: DATABASE_URL, HIVEMQ_*, MASTER_USERNAME/PASSWORD

docker compose up -d --build
```

בדיקה שהעלייה הצליחה:

```sh
docker compose ps                     # STATUS צריך להגיע ל-(healthy) תוך ~40 שניות
curl -fsS localhost:4000/health       # {"status":"ok","db":"ready","mqtt":"connected",...}
docker compose logs -f parkomat       # מצפים ל-"session קודם שוחזר" ול-"listening to sites/+/..."
```

עצירה:

```sh
docker compose down                   # SIGTERM → סגירה מסודרת של MQTT, SSE, HTTP וה-pool
```

אם `down` מדפיס משהו על *killing* — הכיבוי לא הספיק, והפתרון הוא להגדיל את
`stop_grace_period` ב-compose (ברירת המחדל שלנו 30 שניות, והכיבוי נמדד ב-~0.1ש').

### שני קובצי `.env` שונים — אל תתבלבל

| מסלול | הקובץ | התבנית |
|---|---|---|
| **Docker** (פרודקשן) | `.env` **בשורש** הריפו | `.env.docker.example` |
| **npm** (פיתוח מקומי) | `master/.env` | `master/.env.example` |

`docker-compose.yml` קורא `env_file: .env` מהשורש; `npm start` קורא
`master/.env`. אף אחד מהם אינו נכנס לגיט ואינו נכנס לתמונת ה-Docker
(ראה `.dockerignore`).

### מה שכדאי לדעת לפני שמפרסמים את הפורט לאינטרנט

- **מופע אחד בלבד.** אין להריץ `--scale` או שני מכולות: שתיהן יתחברו ל-HiveMQ
  עם אותו `MASTER_CLIENT_ID` וינתקו זו את זו בלולאה, ואף אחת לא תקלוט. בנוסף,
  הקליטה מסודרת בתור FIFO *בתוך התהליך* — עיבוד מקביל כבר השחית נתונים בעבר.
- **מומלץ מאחורי reverse proxy** (nginx/Caddy) עם TLS. אז עדיף לשנות את מיפוי
  הפורט ב-compose ל-`"127.0.0.1:4000:4000"`, כדי שהשרת לא יהיה חשוף ישירות.
- **קוד המנהל** (`x-admin-code`) הוא סוד משותף זמני עם ברירת מחדל חלשה, ומסלולי
  התחזוקה אינם מוגנים בו כלל. יש להסדיר זאת לפני חשיפה פומבית.
- **אזור זמן**: הקונטיינר מוגדר `TZ=Asia/Jerusalem`. הרצה *מחוץ* לקונטיינר על
  שרת Linux תיפול ל-UTC, וכל סטטיסטיקת השעות וגבולות החודש יזוזו ב-2-3 שעות.

## הרצה מקומית (פיתוח)

### 1. השרת (master)

```sh
cd master
npm install
cp .env.example .env     # מלא את פרטי ה-HiveMQ
npm start                # http://localhost:4000
npm test                 # 114 בדיקות יחידה
```

השרת **נעצר במכוון** אם חסרים פרטי HiveMQ — שרת שרץ בלי קליטה נראה תקין
בזמן שהוא לא שומע כלום.

### 2. הדשבורד

```sh
cd dashboard
npm install
npm run dev              # http://localhost:5173
```

הדשבורד מדבר עם השרת דרך proxy (`/api` → `localhost:4000`).

### 3. הסוכן (רץ באתר, לא במחשב הפיתוח)

```sh
cd Parkomat.Agent
dotnet build Parkomat.Agent.slnx
dotnet test  Parkomat.Agent.slnx      # 127 בדיקות יחידה
```

ההתקנה באתר נעשית דרך `installer.iss` (Inno Setup).

#### הכנת מכונת build שמייצרת installer עובד — קובץ אחד, ערך אחד

clone טרי **נבנה ועובר בדיקות כמו שהוא**, אבל ה-installer שייצא ממנו יעלה
בלי סיסמת HiveMQ. כדי לייצר installer לשיגור צריך צעד אחד:

```sh
cd Parkomat.Agent
cp agent-defaults.password.example agent-defaults.password
#  ערוך את agent-defaults.password: שורה אחת, הסיסמה בלבד, בלי מרכאות
dotnet build Parkomat.Agent.slnx -t:Rebuild
```

זה הכל. ה-build צורב את הערך לבינארי (`Parkomat.Agent.Core.csproj` → target
`GenerateBuildDefaults` → `obj\BuildDefaults.g.cs`), ולכן ההתקנה באתר אינה
דורשת הקלדת סיסמה.

| | |
|---|---|
| **הערך** | `Parkomat.Agent/agent-defaults.password` — **מוחרג מגיט** |
| **התבנית** | `Parkomat.Agent/agent-defaults.password.example` — בגיט, בלי סוד |
| **בלי הקובץ** | ה-build מצליח, ברירת המחדל `""` — תקין לפיתוח ול-CI, לא לשיגור |

> אחרי שינוי הקובץ צריך `-t:Rebuild`. build רגיל לא בהכרח יצרוב מחדש.

## רישום אתר — השער לקליטה

**השרת דוחה כל הודעה מאתר שאינו רשום.** אתר מתחיל להיקלט רק אחרי שרושמים אותו:

```sh
# מהדשבורד: כפתור "הוסף אתר"
# או מהשורה:
cd master && npm run add-site -- 1234 "אילת 4"
```

**קוד האתר חייב להיות זהה ל-`SiteId` שמוגדר בסוכן שרץ באתר** — הוא ה-`{code}`
בנתיב `sites/{code}/state`. קוד שונה = כל ההודעות מהאתר יידחו.

## החוזה בין הרכיבים

- **נושאי MQTT:** `sites/{code}/state` · `sites/{code}/operation` · `sites/{code}/bridge`
- **חותמי זמן:** unix **שניות** (לא מילישניות)
- **מצבים:** `ready` · `operating` · `error` · `maintenance` · `no_comm`
- **`no_comm` מגיע מ-LWT בשתי שכבות** — הסוכן מול Mosquitto (קריסת תהליך), והגשר מול
  HiveMQ (נפילת חשמל באתר). אין watchdog בשרת. הוא *לא* מעדכן `last_seen`
- **מפתח dedup:** `(site_id, reported_at, start_end, entry_exit, card_number)` —
  QoS 1 הוא at-least-once, כפילויות הן התנהגות תקינה. המפתח בנוי על
  `reported_at` (החותם **כפי שהסוכן שלח**, שאינו משתנה לעולם) ולא על
  `occurred_at` — כי `occurred_at` מיושר כשהשעון באתר סוטה, כלומר תלוי ברגע
  הקליטה, ומסירה חוזרת הייתה מקבלת ערך אחר ונכנסת כשורה שנייה

פירוט מלא: [`master/CLAUDE.md`](master/CLAUDE.md) ו-[`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md).

## אבטחה

- הסודות (`master/.env`, `master/.env.test`, `Parkomat.Agent/agent-defaults.password`)
  **מוחרגים מגיט**. הריפו הזה **ציבורי**.
- **סיסמת ה-HiveMQ של הסוכן נצרבת לבינארי בזמן build** (ראה "הכנת מכונת build"
  למעלה), כדי שהתקנה באתר לא תדרוש הקלדה. המשמעות: הסיסמה **חילוצית מכל
  installer משוגר** במחרוזות. זו ההתנהגות מאז 1.0.4, וההחרגה מגיט מגינה על
  המאגר הציבורי — לא על הבינארי. סיבוב הסיסמה הוא לכן פעולה שדורשת גם build
  חדש וגם עדכון האתרים, ולא רק שינוי ב-HiveMQ.
- אל תדביקו את הסיסמה ב-`SiteConfig.cs`. היא נמחקה משם פעם אחת לפני commit;
  הסיבה שהיא הגיעה לשם — איפוס שמחק אותה בכל שדרוג — תוקנה, ופרטי ההזדהות
  שורדים עכשיו איפוס כמו ה-`SiteId`.
- הרשאת ה-Master מול HiveMQ היא **האזנה בלבד** — הוא לעולם לא מפרסם.
- **TLS מול HiveMQ הוא חובה ואי אפשר לכבות אותו.** היה בסוכן checkbox שאִפשר זאת; הוא הוסר.
  הגשר מעביר שם משתמש וסיסמה דרך האינטרנט הפתוח — בלי TLS הם נוסעים בטקסט גלוי.
- **רוב** נתיבי הכתיבה ב-API מוגנים ב-`requireAdmin` (כותרת `x-admin-code`, נאכף
  **בשרת**): רישום אתר, עדכון, מחיקה, ושינוי קוד המנהל. זהו סוד משותף, לא אימות
  אמיתי — הוא זמני עד שיוטמע Supabase Auth.
- **`POST`/`DELETE /api/sites/:code/maintenance` מוגנים ב-`requireAdmin`.** הם היו
  פתוחים לחלוטין, וזה היה החור החמור ביותר: תחזוקה אינה תווית — היא מדכאת רישום
  תקלות לחלוטין (הודעת `error` בזמן תחזוקה נזרקת ואינה נרשמת ב-`status_history`,
  אינה נספרת ואינה מתריעה) ומוחרגת ממכנה הזמינות. כלומר כל מי שהגיע ל-API יכול
  היה להשתיק אתר אמיתי עד 30 יום בקריאה אחת, והמערכת הייתה מציגה אותו כתקין.
  הדשבורד שולח את קוד המנהל בקריאות האלה; מי שלא במצב ניהול יקבל 401.
- **`POST /api/admin/verify` מוגבל בקצב** — 10 ניסיונות ל-5 דקות לכל IP, עם
  `Retry-After` ו-429. זה מייקר ניחוש עיוור, ואינו תחליף לאימות: תוקף עם כמה
  כתובות עוקף אותו.
- ⚠️ **ברירת המחדל של קוד המנהל היא `admin123`, ובבסיס הנתונים הנוכחי היא לא
  שונתה.** זה עדיין הפער המשמעותי שנשאר: הקוד שומר בין השאר על
  `DELETE /api/sites/:code`, שמוחק בקסקייד את כל ההיסטוריה של האתר. **החליפו
  אותו** (`POST /api/admin/code`) לפני חשיפה פומבית.
- שכבת האימות האמיתית מונחת אך אינה נאכפת עדיין: `master/auth/provider.js` עם שני
  ספקים (Supabase Auth ועצמי), ו-RLS עם מדיניות קריאה למאומתים. אין עדיין
  משתמשים, ולכן שום נתיב אינו דורש אסימון. ראה `master/CLAUDE.md`.
