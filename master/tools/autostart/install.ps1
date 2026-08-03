# install.ps1 — רושם את השרת להפעלה אוטומטית. הרצה חד-פעמית.
#
#   powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1
#
# ==========================================================
# ⚠️ זה למחשב פיתוח בלבד. לא לשרת.
# ==========================================================
# בשרת אמיתי המסלול הוא Docker: `restart: unless-stopped` ב-docker-compose.yml
# עושה את אותו הדבר טוב יותר — הוא מרים אחרי קריסה, אחרי אתחול המכונה, ובלי
# תלות בכך שמישהו מחובר. ראה README, "פריסה בשרת (Docker)".
#
# הקובץ הזה קיים כי במחשב פיתוח אין Docker, והשרת נשאר מכובה בשקט אחרי כל
# סגירת חלון — מה שכבר עלה 15 שעות של דשבורד מיושן.
#
# ⚠️ **במעבר לשרת: לבטל את המשימה הזו לפני שמרימים את הקונטיינר.**
#     Unregister-ScheduledTask -TaskName "Parkomat SiteMonitor Server" -Confirm:$false
#
# שני עותקים של השרת — אחד כאן ואחד בשרת — מתחברים ל-HiveMQ עם אותו
# clientId ומנתקים זה את זה בלולאה אינסופית. אף אחד מהם לא יקלוט כלום,
# והתסמין ייראה כמו "השרת החדש לא עובד".
#
# ==========================================================
# בלי הרשאות מנהל, בכוונה
# ==========================================================
# משימה ברמת המשתמש אינה דורשת UAC, ולא דורשת לשמור סיסמה במערכת. זו אותה
# החלטה שהפרויקט כבר נקט בסוכן (installer.iss: PrivilegesRequired=lowest).
#
# ⚠️ המחיר, וצריך להכיר אותו: משימה ברמת משתמש רצה רק כשהמשתמש **מחובר**.
# מחשב שאותחל ואיש לא נכנס בו — השרת לא יעלה. אם המחשב הזה הוא שרת שאמור
# לעבוד גם בלי אדם, צריך התחברות אוטומטית או שירות Windows (עם מנהל).
#
# ==========================================================
# שני טריגרים, ולא אחד
# ==========================================================
#   1. AtLogOn — מכסה reboot.
#   2. כל 5 דקות — מכסה את מה שהטריגר הראשון אינו מכסה: קריסה, סגירה ידנית,
#      או תהליך שנהרג. הסקריפט בודק אם השרת רץ ואינו עושה כלום אם כן, ולכן
#      הריצות האלה זולות לחלוטין.
#
# הבדיקה הזו היא גם מה שמונע את הכשל המסוכן: שני עותקים של השרת מנתקים זה
# את זה בלולאה (clientId קבוע ב-MQTT). ראה start-master.ps1.

$ErrorActionPreference = "Stop"

$taskName = "Parkomat SiteMonitor Server"
$here     = $PSScriptRoot
$vbs      = Join-Path $here "launch-hidden.vbs"

if (-not (Test-Path $vbs)) { throw "לא נמצא: $vbs" }

# רישום מחדש מאפס — כך הרצה חוזרת מעדכנת במקום להיכשל.
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "המשימה הקודמת הוסרה."
}

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument """$vbs"""

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

# ExecutionTimeLimit 0 = בלי מגבלת זמן. ברירת המחדל (3 ימים) הייתה הורגת
# את המשימה, לא את השרת — אבל היא הייתה מסמנת אותה ככושלת ומבלבלת אבחון.
# MultipleInstances IgnoreNew: אם הרצה קודמת עוד מתבצעת, לא מפעילים שנייה.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName `
    -Action $action `
    -Trigger @($triggerLogon, $triggerRepeat) `
    -Settings $settings `
    -Description "מפעיל את שרת Parkomat SiteMonitor אם אינו רץ. בודק כל 5 דקות ובכל כניסה למערכת." | Out-Null

Write-Output "נרשמה המשימה: $taskName"
Write-Output "  טריגרים: כניסה למערכת + כל 5 דקות"
Write-Output "  מריצה:   $vbs"
Write-Output ""
Write-Output "מפעיל עכשיו כדי לוודא שזה עובד..."
Start-ScheduledTask -TaskName $taskName
