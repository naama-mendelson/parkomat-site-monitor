# check-site.ps1 — מה קורה באתר עצמו, כשהדשבורד אומר משהו שלא מסתדר.
#
# ⚠️ הסקריפט קורא בלבד. הוא אינו כותב דבר לתוך C:\ProgramData\Parkomat —
# תיקיית ההגדרות של הסוכן אינה מקום לקבצי בדיקה.
#
# ⚠️ הקובץ חייב BOM. PowerShell 5.1 קורא .ps1 בקידוד ANSI כשאין BOM,
# והעברית הופכת לג׳יבריש שנכשל כבר בפרסור.
#
# ⚠️ המונה הוא הסימן, לא ה-MODE. סוכן שמדווח שינויי מצב ואינו מייצר
# תפעולים נראה חי לגמרי בדשבורד — מגדל 1 הראה ready במשך שבוע עם אפס
# תפעולים. לכן נדגמות 6 דגימות ולא אחת: שאלה אחת בלבד נענית כאן —
# האם המונה זז.
$ErrorActionPreference = 'Continue'
$base = 'C:\ProgramData\Parkomat\Agent'

Write-Host "=== 1. ההגדרות ===" -ForegroundColor Cyan
$cfg = Get-Content (Join-Path $base 'config.json') -Raw | ConvertFrom-Json
"אתר   : $($cfg.SiteId)  ($($cfg.SiteName))"
"PLC   : $($cfg.Plc.IpAddress):$($cfg.Plc.Port)"
"רגיסטרים: MODE=$($cfg.Plc.ModeRegister) card=$($cfg.Plc.CardRegister) cycle=$($cfg.Plc.CycleRegister)"
"קצב דגימה: $($cfg.PollIntervalMs) מ״ש"

Write-Host "`n=== 2. השירות והתהליכים ===" -ForegroundColor Cyan
Get-Service *arkomat* | Format-Table Name, Status, StartType -AutoSize
Get-Process *arkomat* -ErrorAction SilentlyContinue |
  Select-Object Name, Id, StartTime, @{n='זיכרון MB';e={[int]($_.WorkingSet64/1MB)}} | Format-Table -AutoSize
Get-Service mosquitto -ErrorAction SilentlyContinue | Format-Table Name, Status -AutoSize

Write-Host "`n=== 3. קריאה ישירה מה-PLC ===" -ForegroundColor Cyan
function Read-Plc([string]$ip, [int]$port, [int]$addr, [int]$count) {
  $c = New-Object System.Net.Sockets.TcpClient
  $c.ReceiveTimeout = 3000
  $c.SendTimeout = 3000
  try {
    $c.Connect($ip, $port)
    $s = $c.GetStream()
    $req = [byte[]]@(0,1, 0,0, 0,6, 1, 4,
                     [byte](($addr -shr 8) -band 255), [byte]($addr -band 255),
                     [byte](($count -shr 8) -band 255), [byte]($count -band 255))
    $s.Write($req, 0, $req.Length)
    $buf = New-Object byte[] 256
    $n = $s.Read($buf, 0, 256)
    if ($n -lt (9 + $count*2)) { return $null }
    $out = @()
    for ($i = 0; $i -lt $count; $i++) { $out += ([int]$buf[9 + $i*2] * 256 + [int]$buf[10 + $i*2]) }
    return $out
  } catch { Write-Host "  ❌ $($_.Exception.Message)" -ForegroundColor Red; return $null }
    finally { $c.Close() }
}

$ip = $cfg.Plc.IpAddress
$port = $cfg.Plc.Port
$addr = $cfg.Plc.ModeRegister
"נדגם 6 פעמים על פני 30 שניות — מה שחשוב הוא אם המונה זז:"
$first = $null
$last = $null
for ($k = 1; $k -le 6; $k++) {
  $r = Read-Plc $ip $port $addr 3
  if ($r -eq $null) { "  דגימה $k : אין תשובה" }
  else {
    $names = @{0='תחזוקה';1='מוכן';2='בתפעול';3='בתפעול';5='תקלה'}
    $mn = $names[[int]$r[0]]
    if (-not $mn) { $mn = '?' }
    "  דגימה $k : MODE=$($r[0]) ($mn)  כרטיס=$($r[1])  מונה=$($r[2])"
    if ($first -eq $null) { $first = $r[2] }
    $last = $r[2]
  }
  if ($k -lt 6) { Start-Sleep -Seconds 5 }
}
if ($first -ne $null -and $last -ne $null) {
  if ($last -gt $first) { Write-Host "  ✅ המונה זז ($first → $last) — המכונה מבצעת מחזורים" -ForegroundColor Green }
  else { Write-Host "  ⚠️ המונה תקוע על $first במשך 30 שניות" -ForegroundColor Yellow }
}

Write-Host "`n=== 4. טקסט התקלה (רגיסטר 2) ===" -ForegroundColor Cyan
$ft = Read-Plc $ip $port 2 20
if ($ft) { ($ft | ForEach-Object { if ($_ -gt 0 -and $_ -lt 65536) { [char]$_ } }) -join '' }

Write-Host "`n=== 5. הלוג של הסוכן ===" -ForegroundColor Cyan
$logs = Join-Path $base 'logs'
Get-ChildItem $logs -Filter *.log | Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 Name, LastWriteTime, @{n='KB';e={[int]($_.Length/1KB)}} | Format-Table -AutoSize
$newest = Get-ChildItem $logs -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) { "`n--- 30 השורות האחרונות מתוך $($newest.Name) ---"; Get-Content $newest.FullName -Tail 30 }

Write-Host "`n=== 6. מה הסוכן באמת שידר ===" -ForegroundColor Cyan
# ============================================================
# ⚠️ זו הראיה המכרעת, והגרסה הראשונה של הסקריפט החמיצה אותה
# ============================================================
# הסוכן כותב יומן נפרד של כל הודעה ששודרה — agent-sent-YYYY-MM-DD.jsonl.
# הסקריפט סינן *.log בלבד, ולכן הראה יומן שכולו סנכרוני NTP והשאיר את
# השאלה החשובה פתוחה.
#
# ⚠️ ולמה היא מכרעת: MqttPublisher.cs אינו רושם דבר על מצב החיבור. סוכן
# שאיבד את החיבור ל-MQTT נראה **זהה לחלוטין** לאתר שקט — אותו יומן, אותו
# מסך. היומן הזה הוא הדבר היחיד שמפריד ביניהם.
$sent = Get-ChildItem $logs -Filter "agent-sent-*.jsonl" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending
if (-not $sent) {
  Write-Host "  ⚠️ אין יומן שידור כלל — הסוכן לא שידר דבר מאז ההתקנה" -ForegroundColor Yellow
} else {
  $sent | Select-Object -First 5 Name, LastWriteTime, @{n="KB";e={[int]($_.Length/1KB)}} | Format-Table -AutoSize
  $age = (Get-Date) - $sent[0].LastWriteTime
  if ($age.TotalHours -gt 24) {
    Write-Host ("  ⚠️ השידור האחרון לפני {0:N1} שעות" -f $age.TotalHours) -ForegroundColor Yellow
  } else {
    Write-Host ("  ✅ שידור אחרון לפני {0:N1} שעות" -f $age.TotalHours) -ForegroundColor Green
  }
  "`n--- 10 השורות האחרונות מתוך $($sent[0].Name) ---"
  Get-Content $sent[0].FullName -Tail 10
}
