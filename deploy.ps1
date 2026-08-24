# ============================================================
# deploy.ps1 — פריסה מלאה בפקודה אחת, ב-DELL008
# ============================================================
# ⚠️ הסקריפט הזה קיים כי הפריסה דרשה שמונה צעדים ידניים, ואחד מהם —
# ריקון VITE_API_BASE — נכשל בשקט: המסך נטען, הנתונים לא מגיעים, ואין
# שום שגיאה מובנת. צעד שנכשל בשקט בתוך רשימה ידנית הוא רק שאלה של זמן.
#
# בטוח להריץ שוב ושוב: כל שלב בודק את מצבו לפני שהוא נוגע במשהו.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Say($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)  { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t){ Write-Host "  !!  $t" -ForegroundColor Yellow }
function Die($t) { Write-Host "  XX  $t" -ForegroundColor Red; exit 1 }

Say "1. משיכת הקוד"
git pull origin main
$sha = (git log --oneline -1)
Ok "גרסה: $sha"

Say "2. הגדרות"
if (-not (Test-Path .env)) { Die ".env חסר. העתק מ-.env.docker.example ומלא את הערכים." }

# ⚠️ גיבוי לפני נגיעה. הקובץ הזה מחזיק את כל פרטי הגישה של המערכת.
Copy-Item .env ".env.bak" -Force
$lines = @(Get-Content .env)

# כתובת האתר — מזוהה אוטומטית אם לא הוגדרה
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
       Select-Object -First 1).IPAddress
if (-not $ip) { Die "לא נמצאה כתובת IPv4" }

function SetKey($key, $value) {
  $script:lines = @($script:lines | Where-Object { $_ -notmatch "^\s*$key=" })
  $script:lines += "$key=$value"
}

$existing = ($lines | Where-Object { $_ -match "^\s*SITE_ADDRESS=" })
if ($existing) { Ok "SITE_ADDRESS כבר מוגדר: $($existing -replace '^\s*SITE_ADDRESS=','')" }
else { SetKey "SITE_ADDRESS" "https://$ip"; Ok "SITE_ADDRESS נקבע ל-https://$ip" }

# ⚠️ זה הצעד שנכשל בשקט. VITE_API_BASE נצרב לחבילה בזמן הבנייה; אם הוא
# מצביע ל-http://...:4000, דף שנטען ב-HTTPS ינסה לקרוא ל-HTTP והדפדפן
# יחסום כתוכן מעורב — בלי שגיאה שמישהו יבין.
$api = ($lines | Where-Object { $_ -match "^\s*VITE_API_BASE=" })
if ($api -and ($api -notmatch "^\s*VITE_API_BASE=\s*$")) {
  SetKey "VITE_API_BASE" ""
  Warn "VITE_API_BASE היה '$($api -replace '^\s*VITE_API_BASE=','')' — רוקן (חובה ל-origin אחד)"
} else { SetKey "VITE_API_BASE" ""; Ok "VITE_API_BASE ריק" }

Set-Content .env -Value $lines -Encoding utf8
Ok "גיבוי ההגדרות הקודמות: .env.bak"

Say "3. בנייה והרמה"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Die "הבנייה נכשלה" }

Say "4. המתנה לבריאות"
$deadline = (Get-Date).AddMinutes(3)
do {
  Start-Sleep -Seconds 5
  $ps = docker compose ps --format json | ConvertFrom-Json
  $bad = @($ps | Where-Object { $_.State -ne "running" })
  $left = [int]($deadline - (Get-Date)).TotalSeconds
} while ($bad.Count -gt 0 -and (Get-Date) -lt $deadline)
if ($bad.Count -gt 0) {
  $bad | ForEach-Object { Warn "$($_.Service): $($_.State)" }
  Die "לא כל השירותים עלו. docker compose logs"
}
Ok "כל השירותים רצים"

Say "5. תעודת השורש"
# ⚠️ בלי זה הדפדפן מזהיר בכל כניסה, המשתמשים לומדים ללחוץ 'המשך בכל
# זאת', והתקיפה שה-HTTPS בא למנוע חוזרת לעבוד — כי בדיוק כך היא נראית.
docker compose exec -T proxy cat /data/caddy/pki/authorities/local/root.crt |
  Set-Content parkomat-ca.crt -Encoding ascii
if (-not (Test-Path parkomat-ca.crt)) { Die "חילוץ התעודה נכשל" }
certutil -addstore -f "ROOT" parkomat-ca.crt | Out-Null
Ok "התעודה הותקנה במחשב הזה · הקובץ: parkomat-ca.crt"

Say "6. בדיקות"
$fail = 0

try {
  $r = Invoke-WebRequest "https://$ip/health" -TimeoutSec 20 -UseBasicParsing
  if ($r.StatusCode -eq 200) { Ok "HTTPS עונה · /health = 200" } else { Warn "HTTPS החזיר $($r.StatusCode)"; $fail++ }
} catch { Warn "HTTPS לא ענה: $($_.Exception.Message)"; $fail++ }

$bk = docker compose logs --tail=40 backup 2>&1 | Out-String
if ($bk -match "אומת") { Ok "הגיבוי רץ ואומת" }
elseif ($bk -match "כבר קיים גיבוי מהיום") { Ok "גיבוי מהיום כבר קיים" }
else { Warn "הגיבוי טרם הופיע בלוג — בדוק: docker compose logs backup"; $fail++ }

$mq = docker compose logs --tail=60 parkomat 2>&1 | Out-String
if ($mq -match "listening to sites") { Ok "קליטת MQTT פעילה" } else { Warn "קליטת MQTT לא אושרה"; $fail++ }

Say "סיכום"
if ($fail -eq 0) {
  Write-Host "  הכל עבר. הדשבורד: https://$ip" -ForegroundColor Green
} else {
  Write-Host "  $fail בדיקות לא עברו — ראה למעלה" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  מה שנשאר, ולא נעשה כאן:" -ForegroundColor Cyan
Write-Host "   - להעתיק parkomat-ca.crt לשאר המחשבים ולהריץ שם:"
Write-Host "       certutil -addstore -f ""ROOT"" parkomat-ca.crt"
Write-Host "   - שכל משתמש ירשם לאימות דו-שלבי (תפריט החשבון)"
Write-Host "   - פרטי גישה נפרדים ל-MQTT לכל אתר (קונסולת HiveMQ)"
Write-Host ""
