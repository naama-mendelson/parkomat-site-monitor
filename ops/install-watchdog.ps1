# ops/install-watchdog.ps1 — רושם שומר שמרים את Parkomat לבד.
#
# ============================================================
# ⚠️ שומר עדיף על כפתור, וזה לא עניין של נוחות
# ============================================================
# כפתור דורש שמישהו **ידע** שהמערכת למטה. ב-27/08/2026 איש לא ידע
# במשך 2.5 ימים — ההתראה החזירה 401 בכל ירייה. כפתור היה יושב ללא
# שימוש בדיוק כמו שהתקלה ישבה ללא טיפול.
#
# השומר רץ בעצמו: בהתחברות, ואז כל 5 דקות. אם הכול תקין הוא לא עושה
# כלום — start-parkomat.ps1 בודק לפני שהוא פועל.
#
# ============================================================
# ⚠️ הגבול שלו, במפורש
# ============================================================
# המשימה רצה **בהקשר של המשתמש**, כי Docker Desktop ב-Windows מחייב
# סשן מחובר. אי אפשר לעקוף את זה עם RunLevel או עם חשבון SYSTEM —
# ניסיון כזה ייצור משימה שרצה ונכשלת בשקט, וזה גרוע מלא להתקין כלום.
#
# כלומר: מחשב שאותחל ואיש לא נכנס אליו יישאר למטה. הפתרון לזה הוא
# כניסה אוטומטית או העברת master לשירות Windows — החלטה נפרדת.

$ErrorActionPreference = "Stop"

$TaskName = "Parkomat-Watchdog"
$Script = Join-Path $PSScriptRoot "start-parkomat.ps1"

if (-not (Test-Path $Script)) {
    Write-Host "❌ לא נמצא: $Script" -ForegroundColor Red
    exit 1
}

# ⚠️ -WindowStyle Hidden ו-NonInteractive: המשימה רצה כל 5 דקות, וחלון
# שקופץ 288 פעמים ביום הופך את המחשב לבלתי שמיש — ואז מישהו יבטל את
# המשימה, וההגנה תיעלם.
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""

$atLogon = New-ScheduledTaskTrigger -AtLogOn
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# ⚠️ StartWhenAvailable: אחרי הדלקה, המשימה שהוחמצה בזמן שהמחשב היה
# כבוי תרוץ מיד — וזה בדיוק המקרה שהסקריפט הזה קיים בשבילו.
# ⚠️ ו-MultipleInstances: IgnoreNew — הרצה שנתקעה בהמתנה ל-Docker לא
# תצבור עשר הרצות מקבילות שכולן מנסות להרים את אותו דבר.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Write-Host "משימה קודמת הוסרה." }
catch { }

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger @($atLogon, $every5) -Settings $settings `
    -Description "מוודא ש-Docker Desktop והקונטיינרים של Parkomat רצים. נבנה אחרי נפילת 27-30/08/2026." | Out-Null

Write-Host "✅ '$TaskName' נרשמה: בהתחברות, ואז כל 5 דקות." -ForegroundColor Green

# ============================================================
# המשימה השנייה — המבצע של הכפתור בדשבורד
# ============================================================
# ⚠️ **כל דקה ולא כל חמש.** מי שלוחצת על "הפעל מחדש" ולא רואה תגובה
# תוך זמן סביר מסיקה שהכפתור שבור ולוחצת שוב — ולכן קצב הבדיקה הוא
# חלק מהתכנון של הכפתור, לא פרט תפעולי.
#
# ⚠️ והבקשה פגה אחרי 15 דקות (`claim_service_command`), כך שמשימה
# שהייתה כבויה שעתיים לא תבצע הפעלה מחדש בזמן אקראי כשהכול תקין.
$PollerName = "Parkomat-CommandPoller"
$Poller = Join-Path $PSScriptRoot "command-poller.ps1"

if (Test-Path $Poller) {
    $pAction = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Poller`""

    $pEvery1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

    # ⚠️ ExecutionTimeLimit ארוך מזה של השומר: המבצע מריץ את
    # start-parkomat.ps1 בתוכו, וזה לבדו יכול לקחת ארבע דקות.
    $pSettings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

    try { Unregister-ScheduledTask -TaskName $PollerName -Confirm:$false -ErrorAction Stop } catch { }

    Register-ScheduledTask -TaskName $PollerName `
        -Action $pAction -Trigger @($atLogon, $pEvery1) -Settings $pSettings `
        -Description "מבצע פקודות 'הפעל מחדש' שנשלחו מהדשבורד דרך Supabase." | Out-Null

    Write-Host "✅ '$PollerName' נרשמה: כל דקה." -ForegroundColor Green
} else {
    Write-Host "⚠️ לא נמצא $Poller — הכפתור בדשבורד לא יבוצע." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "לבדיקה מיידית:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "לצפייה:         Get-ScheduledTask -TaskName 'Parkomat-*' | Get-ScheduledTaskInfo"
Write-Host "ללוגים:         Get-Content '$(Join-Path $PSScriptRoot "start-parkomat.log")' -Tail 30"
Write-Host "                Get-Content '$(Join-Path $PSScriptRoot "command-poller.log")' -Tail 30"
Write-Host "להסרה:          Unregister-ScheduledTask -TaskName 'Parkomat-Watchdog' -Confirm:`$false"
Write-Host "                Unregister-ScheduledTask -TaskName 'Parkomat-CommandPoller' -Confirm:`$false"
