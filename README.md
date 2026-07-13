# Parkomat — SiteMonitor

מערכת ניטור לחניונים אוטומטיים. עוקבת אחר מצב האתרים בזמן אמת, קולטת פעולות
חניה (כניסות/יציאות) מהבקר, ומציגה סטטיסטיקות ותקלות בדשבורד.

```
PLC ──Modbus──► Agent ──MQTT──► Mosquitto ──TLS──► HiveMQ ──► Master ──► SQLite
                                                                 │
                                                          REST + SSE
                                                                 │
                                                            Dashboard
```

## הרכיבים

| תיקייה | מה זה | טכנולוגיה |
|---|---|---|
| [`Parkomat.Agent/`](Parkomat.Agent) | רץ על מחשב **באתר**. קורא את ה-PLC ב-Modbus-TCP ומשדר את המצב ל-MQTT. | C# / .NET 10 (Windows Service + Tray) |
| [`master/`](master) | **השרת**. קולט את הטלמטריה מ-HiveMQ, שומר ב-SQLite, ומגיש REST + SSE. | Node.js / Express / better-sqlite3 |
| [`dashboard/`](dashboard) | **הדשבורד**. ניטור חי, סטטיסטיקות, לוג פעילות. | React 19 / Vite |

## הרצה

### 1. השרת (master)

```sh
cd master
npm install
cp .env.example .env     # מלא את פרטי ה-HiveMQ
npm start                # http://localhost:4000
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
dotnet test  Parkomat.Agent.slnx
```

ההתקנה באתר נעשית דרך `installer.iss` (Inno Setup).

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

- **נושאי MQTT:** `sites/{code}/state` ו-`sites/{code}/operation`
- **חותמי זמן:** unix **שניות** (לא מילישניות)
- **מצבים:** `ready` · `operating` · `error` · `maintenance` · `no_comm`
- **`no_comm` מגיע מה-LWT** של הברוקר כשהסוכן מתנתק — ולכן הוא *לא* מעדכן `last_seen`
- **מפתח dedup:** `(site_id, occurred_at, start_end, entry_exit, card_number)` —
  QoS 1 הוא at-least-once, כפילויות הן התנהגות תקינה

פירוט מלא: [`master/CLAUDE.md`](master/CLAUDE.md) ו-[`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md).

## אבטחה

- הסודות (`master/.env`) ומסד הנתונים (`sitemonitor.db`) **מוחרגים מגיט**.
- הרשאת ה-Master מול HiveMQ היא **האזנה בלבד** — הוא לעולם לא מפרסם.
