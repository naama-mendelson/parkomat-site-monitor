param(
    # ⚠️ המתג הזה מפריד בין שני קוראים שונים לגמרי:
    #   • המשימה המתוזמנת — רצה חבויה כל 5 דקות, ואסור לה לעצור ולחכות.
    #   • הכפתור על שולחן העבודה — אדם לחץ, והוא רוצה לקרוא מה קרה.
    # בלי ההפרדה, המתנה ל-Enter בסוף הייתה מקפיאה את המשימה המתוזמנת.
    [switch]$Interactive
)

# ops/start-parkomat.ps1 — מרים את Parkomat, ואומר למה הוא נפל.
#
# ============================================================
# למה זה קיים
# ============================================================
# ב-27/08/2026 DELL008 איבד חשמל ב-20:30. כל הקונטיינרים מוגדרים
# `restart: unless-stopped`, כלומר הם היו חוזרים לבד — אבל **Docker
# Desktop עצמו** רשום ב-HKCU\...\Run, מפתח ההפעלה של המשתמש, והוא עולה
# רק כשמישהו **מתחבר**. אף אחד לא נכנס, והמערכת הייתה למטה 2.5 ימים.
#
# ⚠️ **וכפתור בדשבורד אינו הפתרון.** הדשבורד רץ על Cloudflare Pages —
# לא על המכונה הזו — ומי שלוחץ עליו אינו בהכרח לידה. הכפתור צריך להיות
# **כאן**, על שולחן העבודה של המכונה שבה יושבים master ו-Docker.

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $PSScriptRoot "start-parkomat.log"

function Say([string]$msg, [string]$color = "Gray") {
    $line = "{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    Write-Host $line -ForegroundColor $color
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}
function Title([string]$t) {
    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor DarkCyan
    Write-Host ("  " + $t) -ForegroundColor Cyan
    Write-Host ("=" * 60) -ForegroundColor DarkCyan
}
function DaemonUp {
    try { $v = docker version --format "{{.Server.Version}}" 2>$null; return [bool]$v }
    catch { return $false }
}

Write-Host ""
Write-Host "   P A R K O M A T   —   הפעלה מחדש" -ForegroundColor Yellow
Write-Host ""

# ============================================================
#  שלב 1 — מה קרה
# ============================================================
# ⚠️ **האבחון קודם להפעלה, ובכוונה.** הפעלה מחדש מוחקת ראיות: `docker
# inspect` מאבד את קוד היציאה, והלוג של הקונטיינר מתחיל מאפס. מי שרוצה
# לדעת למה זה קרה חייב לשאול **לפני** שהוא מתקן.
Title "1. מה קרה"
$found = $false

try {
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    Say ("המחשב עלה ב-{0}  (לפני {1} ימים)" -f $boot, [math]::Round(((Get-Date) - $boot).TotalDays, 1))

    # אירוע 6008 נרשם **בהדלקה** ומתאר את הכיבוי הקודם — ובגוף ההודעה
    # יש את השעה המדויקת. זה מה שחשף את נפילת 27/08.
    $ev = Get-WinEvent -FilterHashtable @{LogName='System'; Id=6008} -MaxEvents 1 -ErrorAction SilentlyContinue
    if ($ev -and $ev.TimeCreated -gt (Get-Date).AddDays(-14)) {
        Say ("⚠  כיבוי לא צפוי: " + ($ev.Message -replace "`r`n", " ")) "Yellow"
        Say "    זה נראה כמו הפסקת חשמל. אל-פסק (UPS) היה מונע את זה." "Yellow"
        $found = $true
    }
} catch { }

if (DaemonUp) {
    Say "Docker Desktop רץ." "Green"
} else {
    Say "⚠  Docker Desktop אינו רץ — זו הסיבה שהמערכת למטה." "Yellow"
    Say "    הוא עולה רק כשמישהו מתחבר למשתמש; אתחול בלי התחברות משאיר אותו כבוי." "Yellow"
    $found = $true
}

if (DaemonUp) {
    # ============================================================
    # ⚠️ רק הקונטיינרים שלנו
    # ============================================================
    # על המכונה הזו רצים גם קונטיינרים של צוותים אחרים —
    # `ubuntu-ssh-bridged` יצא לפני חמישה חודשים, ו-`aps-postgres` שייך
    # למישהו אחר. בלי הסינון הזה הכפתור מדווח עליהם **בכל לחיצה**,
    # לנצח.
    #
    # ⚠️ ואזהרה שמופיעה תמיד היא אזהרה שמפסיקים לקרוא — ואז גם האמיתית
    # תיבלע בתוכה. זו אותה מחלה בדיוק שבגללה השערים דיווחו "נכשל" על
    # שרת שאינו רץ, ובגללה deploy.ps1 מסיים ב-"1 בדיקות לא עברו" תמיד.
    foreach ($n in (docker ps -a --format "{{.Names}}" 2>$null | Where-Object { $_ -like "parkomat*" })) {
        $i = docker inspect $n --format "{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}" 2>$null
        if (-not $i) { continue }
        $p = $i -split "\|"
        if ($p[0] -ne "running") {
            Say ("⚠  {0}: {1} · קוד יציאה {2}" -f $n, $p[0], $p[1]) "Yellow"; $found = $true
        }
        # ⚠️ OOM הוא סיבה שונה לגמרי, והתיקון שלה אחר: תקרת הזיכרון
        # ב-docker-compose.yml, לא הפעלה מחדש.
        if ($p[2] -eq "true")  { Say ("⛔ {0} נהרג בגלל חוסר זיכרון" -f $n) "Red"; $found = $true }
        if ([int]$p[3] -gt 3)  { Say ("⚠  {0} הופעל מחדש {1} פעמים — הוא קורס בלולאה" -f $n, $p[3]) "Yellow"; $found = $true }
    }
}

$freeGB = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
if ($freeGB -lt 5) { Say ("⛔ נותרו רק {0}GB בדיסק C — זה מפיל קונטיינרים" -f $freeGB) "Red"; $found = $true }
else { Say ("דיסק C: {0}GB פנויים." -f $freeGB) }

if (-not $found) { Say "לא נמצאה סיבה ברורה — ייתכן שהכול תקין וצריך רק רענון." "Green" }

# ============================================================
#  שלב 2 — מרים
# ============================================================
Title "2. מרים את המערכת"

if (-not (DaemonUp)) {
    Say "מפעיל את Docker Desktop..." "Yellow"
    $exe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $exe) {
        Start-Process $exe
        # ⚠️ המתנה ארוכה בכוונה: Docker Desktop מרים מכונת WSL שלמה, ועל
        # מחשב עמוס זה לוקח יותר מדקה. פסק זמן קצר היה מדווח כישלון על
        # הפעלה שהצליחה — כלומר שולח מישהו לחפש תקלה שאינה קיימת.
        $until = (Get-Date).AddMinutes(4)
        while (-not (DaemonUp) -and (Get-Date) -lt $until) {
            Start-Sleep -Seconds 5
            Write-Host "." -NoNewline -ForegroundColor DarkGray
        }
        Write-Host ""
    } else { Say "❌ Docker Desktop לא מותקן בנתיב הצפוי." "Red" }
}

if (-not (DaemonUp)) {
    Say "❌ Docker לא עלה. נסי להפעיל אותו ידנית מתפריט התחל, ואז ללחוץ שוב." "Red"
} else {
    Say "Docker פעיל." "Green"
    Push-Location $Root
    try {
        Say "מרים את השירותים..."
        docker compose up -d 2>&1 | ForEach-Object { Say ("  " + $_) }

        # ⚠️ המנהרה היא **profile** ולא שירות רגיל, ולכן `up -d` רגיל אינו
        # מרים אותה. בהתאוששות של 30/08 היא אכן לא חזרה — הדשבורד עבד
        # מהשרת ולא מהאינטרנט, וזה כשל שקט: הכול "ירוק" ורק אי אפשר להגיע.
        $envFile = Join-Path $Root ".env"
        $hasToken = (Test-Path $envFile) -and
                    ((Get-Content $envFile -Raw) -match "CLOUDFLARE_TUNNEL_TOKEN\s*=\s*\S+")
        if ($hasToken) {
            Say "מרים את המנהרה..."
            docker compose --profile tunnel up -d 2>&1 | ForEach-Object { Say ("  " + $_) }
        }
    } finally { Pop-Location }
}

# ============================================================
#  שלב 3 — בודק שזה באמת עובד
# ============================================================
Title "3. בדיקה"
Start-Sleep -Seconds 12

$allOk = (DaemonUp)
if (DaemonUp) {
    foreach ($r in (docker ps --format "{{.Names}}|{{.Status}}" 2>$null | Where-Object { $_ -like "parkomat*" })) {
        $p = $r -split "\|"
        # ============================================================
        # ⚠️ וי ירוק על קונטיינר לא-בריא — זה מה שהיה כאן
        # ============================================================
        # השורה הקודמת הדפיסה ✔ ירוק על **כל** קונטיינר שרץ, בלי להסתכל
        # במצב הבריאות. נמדד ב-DELL008:
        #     ✔ parkomat-backup      Up 20 minutes (unhealthy)
        # ירוק, ומיד אחריו "✅ המערכת למעלה".
        #
        # ⚠️ וזו בדיוק המחלה שהסקריפט הזה נזהר ממנה במקום אחר: סימן שאינו
        # מבחין בין מצבים מפסיק להיות מידע. מי שרואה ירוק ליד (unhealthy)
        # לומד להתעלם מהירוק.
        if ($p[1] -match "unhealthy") {
            Say ("  ⚠ {0,-20} {1}" -f $p[0], $p[1]) "Yellow"
            $allOk = $false
        }
        # ⚠️ "מתחיל" אינו כשל ואינו הצלחה — הוא **אין ידיעה עדיין**, ולכן
        # אינו מפיל את הסיכום. תקופת החסד של הגיבוי היא 15 דקות בכוונה.
        elseif ($p[1] -match "health: starting") {
            Say ("  … {0,-20} {1}" -f $p[0], $p[1]) "DarkGray"
        }
        else {
            Say ("  ✔ {0,-20} {1}" -f $p[0], $p[1]) "Green"
        }
    }
}

# ⚠️ "הקונטיינר רץ" אינו "השרת עובד". קונטיינר שקורס בלולאה מופיע כ-Up
# בדיוק בין נפילה לנפילה; רק תשובה מ-/health מוכיחה שהוא חי באמת.
try {
    $h = Invoke-WebRequest -Uri "http://127.0.0.1:4000/health" -TimeoutSec 15 -UseBasicParsing
    Say ("✅ השרת עונה (HTTP {0}) — הקליטה פעילה." -f $h.StatusCode) "Green"
} catch {
    $allOk = $false
    # ============================================================
    # ⚠️ "נסי שוב בעוד דקה" הייתה כל התשובה כאן — וזו תשובה גרועה
    # ============================================================
    # קונטיינר שקורס בלולאה מופיע כ-running בין נפילה לנפילה,
    # ו- רואה אותו כעדכני ואינו נוגע בו. כלומר
    # הכפתור היה אומר "נסי שוב" **לנצח**, בלי שום מידע, ומי שלוחץ היה
    # מסיק שהכפתור שבור.
    #
    # ⚠️ ולא מפעילים כאן מחדש בכוח. קריסה בלולאה נובעת מקוד או מהגדרה,
    # והפעלה מחדש רק מוחקת את הלוג שמסביר למה. מה שחסר הוא **הסיבה**.
    $loop = $false
    foreach ($n in (docker ps -a --format "{{.Names}}" 2>$null | Where-Object { $_ -like "parkomat*" })) {
        $i = docker inspect $n --format "{{.State.Status}}|{{.RestartCount}}" 2>$null
        if (-not $i) { continue }
        $p2 = $i -split "|"
        if ($p2[0] -eq "restarting" -or [int]$p2[1] -gt 3) {
            Say ("⛔ {0} קורס בלולאה ({1} הפעלות מחדש) — הפעלה נוספת לא תעזור." -f $n, $p2[1]) "Red"
            $loop = $true
        }
    }
    if ($loop) {
        Say "הסיבה נמצאת בשורות הבאות. צלמי אותן ושלחי:" "Yellow"
    } else {
        Say "⚠  השרת אינו עונה. ייתכן שהוא באמצע עלייה — אבל הנה מה שהוא כתב:" "Yellow"
    }
    # 25 שורות מספיקות כדי לראות את החריגה, ולא מציפות את המסך.
    docker logs --tail 25 parkomat 2>&1 | ForEach-Object { Say ("  " + $_) }
}

Write-Host ""
if ($allOk) { Write-Host "   ✅  המערכת למעלה. אפשר לסגור את החלון." -ForegroundColor Green }
else        { Write-Host "   ⚠   משהו עדיין לא תקין. צלמי את המסך ושלחי." -ForegroundColor Yellow }
Write-Host ""

# ⚠️ רק כשאדם לחץ. המשימה המתוזמנת חייבת להסתיים לבד.
if ($Interactive) {
    Write-Host "   הקישי Enter לסגירה..." -ForegroundColor DarkGray
    [void](Read-Host)
}
