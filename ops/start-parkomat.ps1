# ops/start-parkomat.ps1 — הרמה מלאה של המערכת בלחיצה אחת.
#
# ============================================================
# למה זה קיים
# ============================================================
# ב-27/08/2026 DELL008 איבד חשמל ב-20:30. כל הקונטיינרים מוגדרים
# `restart: unless-stopped`, כלומר הם היו חוזרים לבד — אבל **Docker
# Desktop עצמו** רשום ב-HKCU\...\Run, מפתח ההפעלה של המשתמש, והוא עולה
# רק כשמישהו **מתחבר**. אף אחד לא נכנס, והמערכת הייתה למטה 2.5 ימים.
#
# ⚠️ **וכפתור בדשבורד לא היה עוזר**: הדשבורד מוגש על ידי Caddy, שרץ
# באותו Docker שנפל. מה שמפעיל את המערכת חייב לחיות מחוץ לה.
#
# ============================================================
# ⚠️ מה זה **לא** פותר, ויש לומר במפורש
# ============================================================
# Docker Desktop ב-Windows דורש סשן משתמש מחובר. הסקריפט הזה יכול
# להפעיל אותו — אבל רק אם מישהו כבר מחובר. מחשב שאותחל ואיש לא נכנס
# אליו יישאר למטה גם עם הסקריפט הזה מותקן.
#
# הפתרונות לזה הם החלטה נפרדת: כניסה אוטומטית (auto-logon), או העברת
# ה-master לשירות Windows שאינו תלוי ב-Docker כלל.

$ErrorActionPreference = "Stop"

# ⚠️ הנתיב נגזר ממיקום הסקריפט ולא מקובע. נתיב קשיח היה שובר את
# הסקריפט בכל מכונה אחרת — ובפועל כבר הנחתי נתיב שגוי פעם אחת.
$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $PSScriptRoot "start-parkomat.log"

function Say([string]$msg, [string]$color = "Gray") {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line -ForegroundColor $color
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

function DaemonUp {
    try { $v = docker version --format "{{.Server.Version}}" 2>$null; return [bool]$v }
    catch { return $false }
}

Say "=== הרמת Parkomat ===" "Cyan"
Say "תיקייה: $Root"

# ---------- 1. מנוע Docker ----------
if (DaemonUp) {
    Say "Docker כבר רץ." "Green"
} else {
    Say "Docker אינו רץ — מפעיל את Docker Desktop..." "Yellow"
    $exe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (-not (Test-Path $exe)) {
        Say "❌ לא נמצא: $exe" "Red"
        exit 1
    }
    Start-Process $exe

    # ⚠️ המתנה ארוכה בכוונה: Docker Desktop מרים מכונת WSL שלמה, ועל
    # מחשב עמוס זה לוקח יותר מדקה. פסק זמן קצר היה מדווח כישלון על
    # הפעלה שהצליחה — כלומר שולח מישהו לחפש תקלה שאינה קיימת.
    $until = (Get-Date).AddMinutes(4)
    while (-not (DaemonUp) -and (Get-Date) -lt $until) {
        Start-Sleep -Seconds 5
        Write-Host "." -NoNewline
    }
    Write-Host ""
    if (-not (DaemonUp)) {
        Say "❌ Docker לא עלה תוך 4 דקות." "Red"
        exit 1
    }
    Say "Docker עלה." "Green"
}

# ---------- 2. הקונטיינרים ----------
Push-Location $Root
try {
    Say "מרים את השירותים..."
    docker compose up -d 2>&1 | ForEach-Object { Say "  $_" }

    # ⚠️ המנהרה היא **profile** ולא שירות רגיל, ולכן `up -d` רגיל **אינו**
    # מרים אותה. בהתאוששות של 30/08 היא אכן לא חזרה — כלומר הדשבורד היה
    # נגיש מהשרת עצמו ולא מהאינטרנט, וזה כשל שקט: הכול "עובד", ורק אי
    # אפשר להגיע אליו מהטלפון.
    $envFile = Join-Path $Root ".env"
    $hasToken = (Test-Path $envFile) -and
                ((Get-Content $envFile -Raw) -match "CLOUDFLARE_TUNNEL_TOKEN\s*=\s*\S+")
    if ($hasToken) {
        Say "מרים גם את המנהרה (profile: tunnel)..."
        docker compose --profile tunnel up -d 2>&1 | ForEach-Object { Say "  $_" }
    } else {
        Say "⚠️ אין CLOUDFLARE_TUNNEL_TOKEN ב-.env — המנהרה לא הורמה, והדשבורד לא יהיה נגיש מבחוץ." "Yellow"
    }
} finally {
    Pop-Location
}

# ---------- 3. אימות ----------
Start-Sleep -Seconds 15
Say ""
Say "=== מצב ===" "Cyan"
$rows = docker ps --format "{{.Names}}|{{.Status}}"
foreach ($r in $rows) {
    $p = $r -split "\|"
    Say ("  {0,-20} {1}" -f $p[0], $p[1]) "Green"
}

# ⚠️ "הקונטיינר רץ" אינו "השרת עובד". הבדיקה האמיתית היא ש-/health עונה
# — קונטיינר שקורס בלולאה מופיע כ-Up בדיוק בין נפילה לנפילה.
try {
    $h = Invoke-WebRequest -Uri "http://127.0.0.1:4000/health" -TimeoutSec 10 -UseBasicParsing
    Say "✅ השרת עונה: HTTP $($h.StatusCode)" "Green"
} catch {
    Say "⚠️ /health לא ענה — ייתכן שהשרת עדיין עולה. בדקי: docker logs parkomat" "Yellow"
}

Say "=== סיום ===" "Cyan"
