# ============================================================
# deploy.ps1 — פריסה מלאה בפקודה אחת, ב-DELL008
# ============================================================
# ⚠️ קיים כי הפריסה דרשה שמונה צעדים ידניים, ואחד מהם — ריקון
# VITE_API_BASE — נכשל בשקט: הדף נטען, מנסה לפנות לכתובת מפורשת, הדפדפן
# חוסם, והמסך מציג ממשק בלי נתונים ובלי שום שגיאה מובנת.
#
# ⚠️ **נשמר עם BOM במכוון.** PowerShell 5.1 קורא UTF-8 בלי BOM כ-ANSI,
# והעברית הופכת לבתים ששוברים מחרוזות — הגרסה בלי BOM נכשלה ב-10 שגיאות
# תחביר שכולן היו קידוד ולא קוד.
#
# בטוח להריץ שוב ושוב: כל שלב בודק את מצבו לפני שהוא נוגע במשהו.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ⚠️ בלי זה PowerShell 5.1 קורא את פלט Docker ו-git בקידוד המערכת,
# והעברית חוזרת כג'יבריש (╫⌐╫ó╫¿). זה לא רק מכוער — זה **שבר בדיקה**:
# ההשוואה ל-"כבר קיים גיבוי מהיום" נכשלה למרות שהשורה הייתה שם, והסקריפט
# דיווח על כשל בגיבוי תקין לחלוטין.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Say($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)  { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t){ Write-Host "  !!  $t" -ForegroundColor Yellow }
function Die($t) { Write-Host "  XX  $t" -ForegroundColor Red; exit 1 }

Say "1. משיכת הקוד"
git pull origin main
Ok "גרסה: $(git log --oneline -1)"

Say "2. הגדרות"
if (-not (Test-Path .env)) { Die ".env חסר. העתק מ-.env.docker.example ומלא את הערכים." }
Copy-Item .env ".env.bak" -Force
$lines = @(Get-Content .env)

function GetKey($key) {
  $m = $lines | Where-Object { $_ -match "^\s*$key=" } | Select-Object -First 1
  if ($m) { return ($m -replace "^\s*$key=", "").Trim() }
  return $null
}
function SetKey($key, $value) {
  $script:lines = @($script:lines | Where-Object { $_ -notmatch "^\s*$key=" })
  $script:lines += "$key=$value"
}

# ⚠️ בלי האסימון אין מנהרה, ובלי מנהרה אין גישה בכלל — לא מבחוץ וגם לא
# מהמשרד, כי הפורטים סגורים לרשת. נכשלים כאן, מוקדם ובבירור.
# ⚠️ המנהרה אופציונלית. בלי דומיין ב-Cloudflare אין אסימון — וזה לא סיבה
# למנוע את פריסת הגיבוי, ה-2FA ושאר התיקונים. בלי אסימון: הדשבורד ממשיך
# להיות מוגש ב-HTTP ברשת המשרד, בדיוק כמו קודם.
$token = GetKey "CLOUDFLARE_TUNNEL_TOKEN"
$useTunnel = [bool]$token
if ($useTunnel) { Ok "אסימון המנהרה קיים — HTTPS יופעל" }
else { Warn "אין אסימון מנהרה — הדשבורד יוגש ב-HTTP ברשת המשרד (ללא הצפנה)" }

$public = GetKey "PUBLIC_URL"
if (-not $public) { Warn "PUBLIC_URL לא מוגדר — הבדיקה בסוף תדולג" }
else { Ok "כתובת ציבורית: $public" }

# ⚠️ הצעד שנכשל בשקט. VITE_API_BASE נצרב לחבילה בזמן הבנייה; ערך מפורש
# בו שובר את ה-origin האחד והדפדפן יחסום את הבקשות.
$api = GetKey "VITE_API_BASE"
if ($api) { Warn "VITE_API_BASE היה '$api' — רוקן (חובה ל-origin אחד)" }
SetKey "VITE_API_BASE" ""
if ($public) { SetKey "DASHBOARD_ORIGIN" $public }

Set-Content .env -Value $lines -Encoding utf8
Ok "ההגדרות הקודמות: .env.bak"

Say "3. בנייה והרמה"
if ($useTunnel) {
  # ⚠️ עם מנהרה הפורטים נסגרים לרשת: כל התעבורה עוברת ב-HTTPS, ופורט
  # HTTP פתוח הוא בדיוק הנתיב שההצפנה באה לסגור.
  SetKey "BIND_ADDR" "127.0.0.1"
  Set-Content .env -Value $lines -Encoding utf8
  docker compose --profile tunnel up -d --build
} else {
  docker compose up -d --build
}
if ($LASTEXITCODE -ne 0) { Die "הבנייה נכשלה" }

Say "4. המתנה לבריאות"
$deadline = (Get-Date).AddMinutes(3)
do {
  Start-Sleep -Seconds 5
  $ps = docker compose ps --format json | ConvertFrom-Json
  $bad = @($ps | Where-Object { $_.State -ne "running" })
} while ($bad.Count -gt 0 -and (Get-Date) -lt $deadline)
if ($bad.Count -gt 0) {
  $bad | ForEach-Object { Warn "$($_.Service): $($_.State)" }
  Die "לא כל השירותים עלו. הרץ: docker compose logs"
}
Ok "כל השירותים רצים"

Say "5. בדיקות"
$fail = 0

if ($useTunnel) {
  $tn = docker compose logs --tail=60 tunnel 2>&1 | Out-String
if ($tn -match "Registered tunnel connection|connection established|Connection .* registered") {
  Ok "המנהרה מחוברת ל-Cloudflare"
} else { Warn "המנהרה לא אישרה חיבור — docker compose logs tunnel"; $fail++ }
}

# ⚠️ נבדק לפי **הקבצים** ולא לפי הלוג. תלות בטקסט עברי בפלט של Docker
# היא בדיוק מה שנשבר כאן פעם אחת; קובץ על הדיסק הוא עובדה בלי קידוד.
# ============================================================
# ⚠️ 25 שעות, ולא "מהיום" — והשינוי הזה תיקן מרוץ
# ============================================================
# הבדיקה שאלה "יש גיבוי מהיום?" **מיד** אחרי הרמת הקונטיינרים. אבל
# דיימון הגיבוי משלים בעלייה, וההשלמה לוקחת זמן: בפריסה של 30/08
# הבדיקה רצה ב-12:0x UTC והקובץ נוצר ב-12:51. התוצאה הייתה
# "אין גיבוי מהיום" על מערכת שגיבתה בסדר גמור.
#
# ⚠️ וזה גרוע במיוחד כאן: הפריסה מסיימת ב-"1 בדיקות לא עברו" **בכל
# פעם**, ואז מפסיקים לקרוא את השורה הזו — כולל ביום שבו הגיבוי באמת
# ייכשל. אזהרה שתמיד דולקת אינה אזהרה.
#
# 25 שעות היא גם השאלה הנכונה יותר: מה שמעניין אינו התאריך על הקובץ
# אלא **כמה זמן עבר** מאז הגיבוי האחרון. הגיבוי רץ ב-02:30 UTC יומי,
# ולכן 25 שעות סובלניות לגבול היום ועדיין תופסות דילוג אמיתי.
$cutoff = (Get-Date).AddHours(-25)
$dumps = @(Get-ChildItem "backups" -Filter "parkomat-*.jsonl.gz" -ErrorAction SilentlyContinue |
           Where-Object { $_.LastWriteTime -gt $cutoff } | Sort-Object LastWriteTime)
if ($dumps.Count -gt 0) {
  $kb = [int]($dumps[-1].Length / 1KB)
  $age = [int]((Get-Date) - $dumps[-1].LastWriteTime).TotalHours
  Ok "גיבוי אחרון: $($dumps[-1].Name) ($kb KB, לפני $age שעות)"
} else {
  $last = @(Get-ChildItem "backups" -Filter "parkomat-*.jsonl.gz" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
  $when = if ($last.Count) { $last[-1].LastWriteTime.ToString("dd/MM HH:mm") } else { "מעולם" }
  Warn "אין גיבוי מ-25 השעות האחרונות (אחרון: $when) — docker compose logs backup"; $fail++
}

$mq = docker compose logs --tail=60 parkomat 2>&1 | Out-String
if ($mq -match "listening to sites") { Ok "קליטת MQTT פעילה" }
else { Warn "קליטת MQTT לא אושרה"; $fail++ }

# ⚠️ הבדיקה מהחוץ ולא מבפנים: פנייה ל-127.0.0.1 הייתה עוקפת את Cloudflare
# ומאשרת בדיוק את מה שלא נבדק.
if ($public -and $useTunnel) {
  try {
    $r = Invoke-WebRequest "$public/health" -TimeoutSec 30 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Ok "HTTPS דרך Cloudflare עונה · /health = 200" }
    else { Warn "החזיר $($r.StatusCode)"; $fail++ }
  } catch { Warn "לא ענה: $($_.Exception.Message)"; $fail++ }
}

# ⚠️ מוודאים שהפורטים באמת נסגרו לרשת. פורט HTTP פתוח למשרד הוא בדיוק
# הנתיב שכל המהלך הזה בא לסגור.
$exposed = (docker compose ps --format json | ConvertFrom-Json) |
  ForEach-Object { $_.Publishers } | Where-Object { $_.URL -eq "0.0.0.0" }
if ($exposed -and $useTunnel) { Warn "יש פורטים פתוחים לרשת — צפוי loopback בלבד"; $fail++ }
elseif ($useTunnel) { Ok "אין פורטים פתוחים לרשת המשרד" }

Say "סיכום"
if ($fail -eq 0) {
  Write-Host "  הכל עבר." -ForegroundColor Green
  if ($public) { Write-Host "  הדשבורד: $public" -ForegroundColor Green }
} else {
  Write-Host "  $fail בדיקות לא עברו — ראה למעלה" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  מה שנשאר, ולא נעשה כאן:" -ForegroundColor Cyan
Write-Host "   - שכל משתמש ירשם לאימות דו-שלבי (תפריט החשבון)"
Write-Host "   - פרטי גישה נפרדים ל-MQTT לכל אתר (קונסולת HiveMQ)"
Write-Host ""
