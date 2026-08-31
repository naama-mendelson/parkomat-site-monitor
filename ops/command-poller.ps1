# ops/command-poller.ps1 — מבצע פקודות שהגיעו מהדשבורד.
#
# ============================================================
# ⚠️ זה חייב לרוץ מחוץ ל-Docker — וזו לא העדפה
# ============================================================
# מבצע שרץ בתוך Docker נופל יחד עם מה שהוא אמור להרים, ולכן הוא חסר
# תועלת בדיוק ברגע היחיד שהוא נחוץ. הוא רץ כמשימה מתוזמנת של Windows.
#
# הזרימה: הדשבורד → Supabase (service_commands) → הסקריפט הזה →
# start-parkomat.ps1. אף חוליה אינה עוברת דרך ה-master.
#
# ============================================================
# ⚠️ המפתח הסודי — למה זה מותר כאן ואסור בדפדפן
# ============================================================
# `claim_service_command` ו-`complete_service_command` נשללו מ-PUBLIC
# והוענקו ל-service_role בלבד. משתמש שיכול לקרוא להן דרך הדפדפן היה
# יכול לסמן "בוצע" על בקשה שאיש לא ביצע — כלומר להשתיק את הכפתור בלי
# שאיש ידע. המפתח נקרא מ-master/.env, על מכונת השרת עצמה, ואינו יוצא
# ממנה. זה בדיוק ההבדל שכלל 7 מדבר עליו.

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root "master\.env"
$Starter = Join-Path $PSScriptRoot "start-parkomat.ps1"
$LogFile = Join-Path $PSScriptRoot "command-poller.log"

function Say([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

if (-not (Test-Path $EnvFile)) { Say "❌ לא נמצא $EnvFile"; exit 1 }
if (-not (Test-Path $Starter)) { Say "❌ לא נמצא $Starter"; exit 1 }

# ---------- קריאת ההגדרות ----------
$conf = @{}
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*#') { continue }
    $i = $line.IndexOf('=')
    if ($i -lt 1) { continue }
    $conf[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
}

$url = $conf['SUPABASE_URL']
$key = $conf['SUPABASE_SECRET_KEY']
if (-not $url -or -not $key) { Say "❌ חסר SUPABASE_URL או SUPABASE_SECRET_KEY ב-master\.env"; exit 1 }

$headers = @{
    "apikey"        = $key
    "Authorization" = "Bearer $key"
    "Content-Type"  = "application/json"
}

function Rpc([string]$name, $body) {
    $json = if ($null -eq $body) { "{}" } else { $body | ConvertTo-Json -Compress }
    # ⚠️ UTF8 מפורש: ה-reason מגיע בעברית, וברירת המחדל של PowerShell 5.1
    # הייתה הופכת אותו לג'יבריש בדרך חזרה ליומן.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Method Post -Uri "$url/rest/v1/rpc/$name" `
        -Headers $headers -Body $bytes -TimeoutSec 30
}

# ---------- תפיסת הפקודה הבאה ----------
try {
    $cmd = Rpc "claim_service_command" $null
} catch {
    # ⚠️ כשל רשת אינו שגיאה שדורשת תשומת לב: הסקריפט רץ כל דקה, והניסיון
    # הבא יקרה מיד. רישום ויציאה שקטה — לא התראה על כל קפיצת אינטרנט.
    Say "אין קשר ל-Supabase: $($_.Exception.Message)"
    exit 0
}

if (-not $cmd -or $cmd.Count -eq 0) { exit 0 }

$c = if ($cmd -is [array]) { $cmd[0] } else { $cmd }
Say "=== התקבלה פקודה #$($c.id): $($c.command) מאת $($c.requested_by) ==="
if ($c.reason) { Say "    סיבה: $($c.reason)" }

# ---------- ביצוע ----------
$ok = $false
$result = ""
try {
    if ($c.command -eq "ping") {
        # ============================================================
        # ⚠️ בדיקה שעוברת את כל השרשרת ואינה עושה כלום
        # ============================================================
        # בלי זה, הדרך היחידה לוודא שכפתור החירום עובד הייתה **להפעיל
        # את השרת מחדש באמת** — כלומר להפיל את הקליטה לארבע דקות.
        # מנגנון שבדיקתו יקרה יותר מהתקלה שהוא מונע הוא מנגנון שלא
        # בודקים, ואז מגלים שהוא שבור בדיוק כשצריך אותו.
        #
        # נמדד: בקשה מ-30/08 16:27 נשארה תלויה יומיים ואיש לא ידע.
        $ok = $true
        $result = "המבצע חי · $env:COMPUTERNAME · $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        Say "    בדיקה — עונה"
    } elseif ($c.command -eq "restart") {
        # ⚠️ בתהליך נפרד ולא dot-source: אם start-parkomat.ps1 יזרוק, זה
        # לא יפיל את המדווח — ואז הפקודה הייתה נשארת 'running' לנצח,
        # והכפתור היה חסום מכאן והלאה בגלל הריסון.
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Starter 2>&1
        $code = $LASTEXITCODE
        $result = ($out | Select-Object -Last 25 | Out-String).Trim()
        $ok = ($code -eq 0)
        Say "    הסתיים בקוד $code"
    } else {
        $result = "פקודה לא מוכרת: $($c.command)"
        Say "    $result"
    }
} catch {
    $result = "שגיאה: $($_.Exception.Message)"
    Say "    $result"
}

# ---------- דיווח ----------
# ⚠️ בתוך try משלו: אם הדיווח נכשל, הפקודה נשארת 'running' והכפתור נעול.
# זה בדיוק סוג הכשל שהופך תיקון לתקלה, ולכן יש כאן ניסיון חוזר.
for ($i = 1; $i -le 3; $i++) {
    try {
        Rpc "complete_service_command" @{ p_id = $c.id; p_ok = $ok; p_result = $result } | Out-Null
        Say "    דווח: $(if ($ok) { 'done' } else { 'failed' })"
        break
    } catch {
        Say "    דיווח נכשל (ניסיון $i/3): $($_.Exception.Message)"
        if ($i -lt 3) { Start-Sleep -Seconds 5 }
    }
}
