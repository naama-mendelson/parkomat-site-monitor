# syntax=docker/dockerfile:1
# ============================================================
# Parkomat — שרת (master) + דשבורד, בקונטיינר אחד
# ============================================================
# מה *לא* נמצא כאן, ובכוונה:
#   • בסיס נתונים — Postgres מנוהל ב-Supabase (חיצוני, דרך DATABASE_URL).
#   • ברוקר MQTT  — HiveMQ Cloud (חיצוני).
#   • הסוכן        — אפליקציית Windows שמותקנת ידנית באתרי החניה.
# ולכן זהו שירות אחד בלבד, בלי תלויות מקומיות.

# ------------------------------------------------------------
# שלב 1 — בניית הדשבורד (Vite → קבצים סטטיים)
# ------------------------------------------------------------
FROM node:22-alpine AS dashboard

WORKDIR /build

# מעתיקים קודם את קבצי התלויות בלבד: כל עוד הם לא משתנים, שכבת ה-npm ci
# נשלפת מהמטמון ובנייה חוזרת לוקחת שניות במקום דקות.
COPY dashboard/package*.json ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build          # → /build/dist

# ------------------------------------------------------------
# שלב 2 — שרת ה-Master + הדשבורד הבנוי
# ------------------------------------------------------------
FROM node:22-alpine

ENV NODE_ENV=production

# ============================================================
# אזור זמן — לא קוסמטיקה
# ============================================================
# חישובי "פעילות לפי שעה ביום", "לפי יום בשבוע" וגבולות היום/החודש מחושבים
# ב-JS עם getHours()/getDay()/getDate(), כלומר לפי **השעון המקומי של השרת**.
# קונטיינר עולה כברירת מחדל ב-UTC, ולכן בלי ההגדרה הזו כל סטטיסטיקת השעות
# תיסוג ב-3 שעות (וקיץ/חורף), ופעולה ב-01:00 בלילה תיפול ליום הקודם.
# tzdata נדרש ב-alpine כדי ש-TZ בכלל ייקלט.
ENV TZ=Asia/Jerusalem
RUN apk add --no-cache tzdata

WORKDIR /app

# רק תלויות פרודקשן. better-sqlite3 הוא מודול native (דורש python + gcc)
# ומשמש אך ורק כלי מיגרציה/בדיקה — לכן הוא ב-devDependencies ואינו מותקן
# כאן. בזכות זה התמונה נשארת alpine נקייה, בלי שרשרת כלי-בנייה.
COPY master/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY master/ ./

# הדשבורד מוגש מאותו origin כמו ה-API. זה לא רק חיסכון בקונטיינר: הלקוח
# קורא ל-API בנתיב *יחסי* ("/api"), ולכן same-origin מייתר גם CORS וגם
# הגדרת כתובת-שרת בלקוח. routes.js מגיש את התיקייה אם היא קיימת.
COPY --from=dashboard /build/dist ./public

EXPOSE 4000

# לא רץ כ-root
USER node

# בדיקת חיות: מבקש את דף הדשבורד (סטטי — לא נוגע ב-DB ולא עולה כסף).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "master.js"]
