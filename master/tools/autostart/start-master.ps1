# start-master.ps1 — מפעיל את השרת אם הוא אינו רץ. אחרת לא עושה כלום.
#
# ==========================================================
# למה זה קיים
# ==========================================================
# לא היה שום דבר שמפעיל את השרת. כל reboot, כל קריסה, כל סגירת חלון —
# והמערכת שותקת עד שמישהו נזכר להריץ ידנית. זה נמדד בפועל: 15 שעות שבהן
# אף הודעה לא נכתבה ל-Supabase, והתגלה במקרה.
#
# (ההודעות עצמן לא אבדו — HiveMQ שמר אותן בזכות clientId קבוע עם
# clean:false, וכולן נכנסו כשהשרת עלה. אבל הדשבורד הראה מצב בן 15 שעות.)
#
# ==========================================================
# ⚠️ עותק אחד בלבד — זו אינה אופטימיזציה
# ==========================================================
# ה-subscriber משתמש ב-clientId קבוע ('parkomat-master-subscriber'), כי זה
# מה שמאפשר ל-HiveMQ לשמור את התור בין הפעלות. אבל תקן MQTT מחייב clientId
# ייחודי: שני עותקים של השרת **מנתקים זה את זה בלולאה אינסופית**, ואף אחד
# לא מספיק לעבד הודעה. זה נצפה בלוג בפועל.
#
# לכן הבדיקה כאן אינה "נחמד שלא נכפיל" אלא תנאי לתקינות. היא נעשית על
# שורת הפקודה של התהליך ולא על הפורט: הפורט נתפס רק אחרי שהשרת סיים לעלות,
# וחלון של כמה שניות בין הפעלה לתפיסת פורט הספיק כדי להפעיל עותק שני.

$ErrorActionPreference = "Stop"

# שורש master/ — שתי רמות מעל הקובץ הזה (tools/autostart/)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $root "logs"

try {
    # --- כבר רץ? לא נוגעים ---
    $running = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -like "*master.js*" }
    if ($running) { exit 0 }

    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

    # קובץ ליום, כדי שאפשר יהיה לחזור אחורה בלי קובץ ענק אחד.
    $stamp = Get-Date -Format "yyyy-MM-dd"
    $out = Join-Path $logDir "master-$stamp.log"
    $err = Join-Path $logDir "master-$stamp.err.log"

    # --env-file-if-exists — בדיוק כמו ב-package.json. בלעדיו אין DATABASE_URL
    # והשרת מסרב לעלות.
    Start-Process -FilePath "node" `
        -ArgumentList "--env-file-if-exists=.env", "master.js" `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $out `
        -RedirectStandardError $err

    Add-Content -Path (Join-Path $logDir "autostart.log") -Encoding utf8 `
        -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  הופעל (לא נמצא תהליך קיים)"

    # --- ניקוי לוגים ישנים: 14 יום ---
    Get-ChildItem $logDir -Filter "master-*.log" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
catch {
    # כשל כאן אסור שיפיל את המשימה בשקט — נרשם, והריצה הבאה תנסה שוב.
    try {
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
        Add-Content -Path (Join-Path $logDir "autostart.log") -Encoding utf8 `
            -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  כשל בהפעלה: $($_.Exception.Message)"
    } catch { }
    exit 1
}
