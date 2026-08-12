# ⚠️ הקובץ נשמר ב-UTF-8 **עם BOM**. בלעדיו PowerShell 5.1 קורא אותו
#    כ-ANSI, וכל העברית כאן הופכת לשגיאות תחביר.
# tools/build-and-ship.ps1 — בונה את תמונת ה-Docker ואורז אותה להעברה לשרת.
#
# ============================================================
# למה סקריפט ולא שלוש פקודות בצ'אט
# ============================================================
# הפעולה הזו תיעשה שוב בכל גרסה, ועל מחשב שאולי לא יהיה זה. שלוש פקודות
# שמועתקות מהיסטוריית שיחה הן שלוש הזדמנויות לשכוח דגל.
#
# ⚠️ **והשלב שהכי קל לשכוח הוא הראשון**: אימות שהמנוע בכלל חי. בלעדיו
# `docker build` נכשל בהודעה על pipe שנראית כמו תקלת רשת, ולא כמו
# "Docker Desktop לא רץ".

$ErrorActionPreference = "Stop"

$Docker = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$Root = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $Root "dist-image"
$Tag = "parkomat:latest"

Write-Host "== 1/4  בדיקת מנוע Docker ==" -ForegroundColor Cyan
if (-not (Test-Path $Docker)) { throw "docker.exe לא נמצא ב-$Docker — Docker Desktop אינו מותקן." }
# ⚠️ **בלי `2>&1`, ובלי ErrorActionPreference=Stop סביב הקריאה הזו.**
# ב-PowerShell 5.1 הפניית stderr של קובץ הרצה עוטפת כל שורה ב-ErrorRecord,
# ועם Stop זו שגיאה מסיימת — כלומר הסקריפט מת **לפני** שהספיק להדפיס את
# ההסבר שכתוב כאן למטה, והמשתמשת רואה שגיאת pipe גולמית במקום מה לעשות.
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$info = (& $Docker info --format '{{.ServerVersion}}') 2>$null | Out-String
$ErrorActionPreference = $prev

if ($info -notmatch '^\s*\d') {
  throw @"
מנוע Docker אינו זמין.

הסיבה הנפוצה: רכיב Windows בשם "Virtual Machine Platform" כבוי.
פתחי PowerShell **כמנהל** והריצי:

    wsl --install --no-distribution

ואז אתחלי את המחשב. אחרי האתחול הפעילי את Docker Desktop והריצי שוב.
"@
}
Write-Host "   מנוע: $($info.Trim())" -ForegroundColor Green

Write-Host "== 2/4  שער הקשר הבנייה ==" -ForegroundColor Cyan
# ⚠️ רץ לפני הבנייה ולא אחריה: הוא תופס סודות שנכנסים לתמונה ואת הסוכן
# (Windows) שאינו אמור להיכנס כלל. אחרי הבנייה כבר יש תמונה עם הבעיה בפנים.
Push-Location (Join-Path $Root "master")
node tools/check-docker.js
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "שער ה-Docker נכשל — לא בונים." }
Pop-Location

Write-Host "== 3/4  בנייה ==" -ForegroundColor Cyan
Push-Location $Root
& $Docker build -t $Tag .
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "הבנייה נכשלה." }
Pop-Location

Write-Host "== 4/4  אריזה להעברה ==" -ForegroundColor Cyan
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory $OutDir | Out-Null }
$tar = Join-Path $OutDir "parkomat-image.tar"

# ⚠️ `docker save` ולא `docker push`: אין כאן registry, והשרת במשרד אינו
# בהכרח מחובר לאינטרנט בצורה שמאפשרת משיכה. קובץ יחיד עובר בכל דרך —
# דיסק, שיתוף רשת, TeamViewer.
& $Docker save -o $tar $Tag
if ($LASTEXITCODE -ne 0) { throw "האריזה נכשלה." }

# ⚠️ **הקבצים שהתמונה לא מכילה, ובכוונה.** docker-compose.yml ו-.env אינם
# חלק מהתמונה — הראשון מתאר איך להריץ אותה, והשני מכיל סודות שאסור שייצרבו
# פנימה. שניהם חייבים לנסוע לצד ה-tar, אחרת יש בשרת תמונה שאי אפשר להפעיל.
Copy-Item (Join-Path $Root "docker-compose.yml") $OutDir -Force
Copy-Item (Join-Path $Root ".env.docker.example") $OutDir -Force

$size = [math]::Round((Get-Item $tar).Length / 1MB, 1)
Write-Host ""
Write-Host "✅ מוכן להעברה: $OutDir" -ForegroundColor Green
Write-Host "   parkomat-image.tar     ($size MB)"
Write-Host "   docker-compose.yml"
Write-Host "   .env.docker.example"
Write-Host ""
Write-Host "בשרת:" -ForegroundColor Cyan
Write-Host "   docker load -i parkomat-image.tar"
Write-Host "   cp .env.docker.example .env   # ואז למלא את הערכים האמיתיים"
Write-Host "   docker compose up -d"
Write-Host ""
Write-Host "⚠️ .env אינו נכלל כאן — הוא מכיל סודות. יש למלא אותו בשרת." -ForegroundColor Yellow
