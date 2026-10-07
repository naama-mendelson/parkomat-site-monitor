# scan-registers.ps1 — מוצא איזה אוגר בבקר משתנה כשמעבירים את הבורר (אוטו / חצי אוטו / ידני).
#
# ============================================================
# למה הכלי הזה קיים
# ============================================================
# הסוכן קורא רק את אוגר ה-MODE, ונמדד (05/10/2026, ויצמן 93 ומגדל 1): בחצי אוטו
# ובידני עם תקלה הבקר כותב שם 1/3/5 — בדיוק כמו באוטומט. כלומר אין לסוכן שום
# דרך לדעת שהמתקן אינו באוטומט, והפעלה של טכנאי נספרת כפעילות ותקלות של האתר.
# אם מצב הבורר שמור באוגר אחר — הכלי הזה מוצא אותו.
#
# ============================================================
# מה הוא עושה, ומה **לא**
# ============================================================
# - קורא בלבד (FC 03 / 04). **אין בקוד הזה שום פקודת כתיבה לבקר.**
# - אינו כותב ל-C:\ProgramData\Parkomat ואינו עוצר את הסוכן: הוא קורא את
#   config.json כטקסט ופותח חיבור Modbus משלו, לצד הסוכן.
# - הפלט נשמר גם לקובץ על שולחן העבודה, כדי שאפשר יהיה לשלוח אותו.
#
# הפעלה (CMD או PowerShell, במחשב האתר, בלי הרשאות מנהל):
#   powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\Desktop\scan-registers.ps1"
# טווח או פקודה אחרים:
#   ... -File scan-registers.ps1 -From 0 -To 2000 -Fc 3
#
# בזמן הריצה: Enter = שורת סימון בפלט (למשל "עכשיו חצי אוטו"). Ctrl+C = עצירה.

param(
  [int]$From = 0,
  [int]$To = 999,
  [int]$Fc = 0,              # 0 = כמו בהגדרות הסוכן
  [int]$IntervalMs = 1000,
  [int]$QuietSeconds = 15,
  [string]$Ip = "",
  [int]$Port = 0,
  [string]$Transport = "",
  [int]$ModeRegister = -1,   # ‎-1 = כמו בהגדרות הסוכן (רק לתצוגה בשורות הפלט)
  [string]$LogDir = "",      # ריק = שולחן העבודה
  [int]$Seconds = 0          # 0 = עד Ctrl+C (מספר — לבדיקה אוטומטית של הכלי)
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------- הגדרות: מה שהסוכן משתמש בו, אלא אם נמסר אחרת ----------
$cfgPath = "C:\ProgramData\Parkomat\Agent\config.json"
$plc = $null
$site = "?"
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $plc = $cfg.Plc
  if ($cfg.SiteId) { $site = $cfg.SiteId }
}
if (-not $Ip) { if ($plc -and $plc.IpAddress) { $Ip = $plc.IpAddress } else { $Ip = "192.168.1.3" } }
if ($Port -le 0) { if ($plc -and $plc.Port) { $Port = [int]$plc.Port } else { $Port = 502 } }
if (-not $Transport) { if ($plc -and $plc.Transport) { $Transport = $plc.Transport } else { $Transport = "tcp" } }
if ($Fc -le 0) { if ($plc -and $plc.FunctionCode) { $Fc = [int]$plc.FunctionCode } else { $Fc = 4 } }
$modeReg = $ModeRegister
if ($modeReg -lt 0 -and $plc -and $plc.ModeRegister) { $modeReg = [int]$plc.ModeRegister }
if ($modeReg -gt $To) { $To = $modeReg }
$udp = ($Transport.Trim().ToLower() -eq "udp")
if ($Fc -ne 3 -and $Fc -ne 4) { throw "פקודת קריאה $Fc אינה נתמכת — רק 3 או 4 (קריאה בלבד)" }

if (-not $LogDir) { $LogDir = [Environment]::GetFolderPath("Desktop") }
$logFile = Join-Path $LogDir ("plc-scan-" + (Get-Date -Format "yyyy-MM-dd_HH-mm-ss") + ".txt")
function Say([string]$text) {
  Write-Host $text
  Add-Content -Path $logFile -Value $text -Encoding UTF8
}

# ---------- Modbus, קריאה בלבד ----------
$script:tid = 0
$script:udpClient = $null
$script:tcpClient = $null
$script:stream = $null
function Open-Plc {
  if ($udp) {
    $script:udpClient = New-Object System.Net.Sockets.UdpClient
    $script:udpClient.Connect($Ip, $Port)
    $script:udpClient.Client.ReceiveTimeout = 1500
  } else {
    $script:tcpClient = New-Object System.Net.Sockets.TcpClient
    $script:tcpClient.ReceiveTimeout = 2000
    $script:tcpClient.SendTimeout = 2000
    $script:tcpClient.Connect($Ip, $Port)
    $script:stream = $script:tcpClient.GetStream()
  }
}
function Read-Exact([int]$n) {
  $buf = New-Object byte[] $n
  $got = 0
  while ($got -lt $n) {
    $r = $script:stream.Read($buf, $got, $n - $got)
    if ($r -le 0) { throw "החיבור לבקר נסגר" }
    $got += $r
  }
  return ,$buf
}
# מחזיר מערך ערכים, או מספר שלם (קוד חריגה של Modbus) כשהבקר דוחה את הכתובת.
function Read-Block([int]$addr, [int]$count) {
  $script:tid = ($script:tid + 1) % 65536
  $req = [byte[]]@(
    [byte](($script:tid -shr 8) -band 0xFF), [byte]($script:tid -band 0xFF),
    0, 0, 0, 6, 1, [byte]$Fc,
    [byte](($addr -shr 8) -band 0xFF), [byte]($addr -band 0xFF),
    [byte](($count -shr 8) -band 0xFF), [byte]($count -band 0xFF))
  if ($udp) {
    $ep = New-Object System.Net.IPEndPoint ([System.Net.IPAddress]::Any), 0
    while ($script:udpClient.Available -gt 0) { [void]$script:udpClient.Receive([ref]$ep) }
    [void]$script:udpClient.Send($req, $req.Length)
    $resp = $script:udpClient.Receive([ref]$ep)
  } else {
    $script:stream.Write($req, 0, $req.Length)
    $head = Read-Exact 6
    $len = ($head[4] -shl 8) -bor $head[5]
    $body = Read-Exact $len
    $resp = [byte[]]($head + $body)
  }
  if ($resp.Length -lt 9) { throw "תשובה קצרה מהבקר ($($resp.Length) בתים)" }
  $rfc = $resp[7]
  if (($rfc -band 0x80) -ne 0) { return [int]$resp[8] }
  $bc = $resp[8]
  if ($bc -ne $count * 2 -or $resp.Length -lt 9 + $bc) { throw "תשובה לא תקינה מכתובת $addr" }
  $vals = New-Object int[] $count
  for ($i = 0; $i -lt $count; $i++) { $vals[$i] = ($resp[9 + 2 * $i] -shl 8) -bor $resp[10 + 2 * $i] }
  return ,$vals
}

# ---------- גילוי: אילו כתובות הבקר מוכן להחזיר ----------
# בלוק של 100 קודם; כתובת שנדחתה — מפרקים לבלוקים קטנים, ואחר כך לבודדים.
# ⚠️ רשימה משותפת ולא ערך מוחזר: PowerShell "פורש" מערך שחוזר מפונקציה, ולכן
# בלוק יחיד (זוג [כתובת, כמות]) היה הופך לשני מספרים, ותוצאה ריקה ל-$null ברשימה.
$script:blocks = New-Object System.Collections.ArrayList
function Find-Blocks([int]$lo, [int]$hi, [int]$size) {
  for ($a = $lo; $a -le $hi; $a += $size) {
    $n = [Math]::Min($size, $hi - $a + 1)
    $r = Read-Block $a $n
    if ($r -is [int]) {
      if ($n -gt 1) { Find-Blocks $a ($a + $n - 1) ([Math]::Max(1, [int][Math]::Floor($n / 10))) }
    } else {
      [void]$script:blocks.Add(@($a, $n))
    }
  }
}

function Snapshot {
  $map = @{}
  foreach ($b in $script:blocks) {
    $vals = Read-Block $b[0] $b[1]
    if ($vals -is [int]) { continue }
    for ($i = 0; $i -lt $b[1]; $i++) { $map[$b[0] + $i] = $vals[$i] }
  }
  return $map
}

Say ("=" * 64)
Say "  סורק אוגרים — קריאה בלבד · אתר $site · $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')"
Say ("  בקר {0} {1}:{2} · פקודה FC 0{3} · אוגרים {4}–{5} · MODE באוגר {6}" -f ($(if ($udp) { "UDP" } else { "TCP" })), $Ip, $Port, $Fc, $From, $To, $modeReg)
Say "  הפלט נשמר גם ל: $logFile"
Say ("=" * 64)

try {
  Open-Plc
  Find-Blocks $From $To 100
} catch {
  $m = $_.Exception.Message
  if ($m -match "forbidden|access permissions|10013") {
    Say "X  חומת האש של Windows חוסמת את PowerShell מלדבר עם הבקר (10013)."
  } else {
    Say "X  אין תקשורת עם הבקר: $m"
  }
  exit 1
}
$total = 0; foreach ($b in $script:blocks) { $total += $b[1] }
if ($total -eq 0) { Say "X  הבקר לא החזיר אף אוגר בטווח $From-$To בפקודה FC 0$Fc. לנסות -Fc $(if ($Fc -eq 4) { 3 } else { 4 })"; exit 1 }
Say "OK הבקר מחזיר $total אוגרים בטווח."

# ---------- כיול: מה זז לבד ----------
Say ""
Say ">> $QuietSeconds שניות של כיול — לא לגעת בבורר. אוגרים שזזים עכשיו (טיימרים, מונים) יוסתרו."
$prev = Snapshot
$noisy = @{}
$until = (Get-Date).AddSeconds($QuietSeconds)
while ((Get-Date) -lt $until) {
  Start-Sleep -Milliseconds $IntervalMs
  $cur = Snapshot
  foreach ($k in $cur.Keys) { if ($prev.ContainsKey($k) -and $prev[$k] -ne $cur[$k]) { $noisy[$k] = $true } }
  $prev = $cur
}
if ($noisy.Count) { Say ("   מוסתרים ({0}): {1}" -f $noisy.Count, (($noisy.Keys | Sort-Object) -join ", ")) }
$modeNow = "?"
if ($prev.ContainsKey($modeReg)) { $modeNow = $prev[$modeReg] }
Say "OK מוכן. MODE עכשיו = $modeNow"
Say ""
Say ">> עכשיו להעביר את הבורר, בהפסקות של כ-10 שניות: אוטו → חצי אוטו → ידני → אוטו."
Say "   לפני כל העברה ללחוץ Enter כאן (נרשמת שורת סימון). Ctrl+C לעצירה."
Say ""

$mark = 0
$stopAt = $null
if ($Seconds -gt 0) { $stopAt = (Get-Date).AddSeconds($Seconds) }
while ($true) {
  if ($stopAt -and (Get-Date) -ge $stopAt) { Say "— הסתיים ($Seconds שניות)"; break }
  # ⚠️ בלי מקלדת (קלט מנותב) KeyAvailable זורק — אז פשוט בלי סימונים, ולא נופלים.
  try {
    while ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq "Enter") { $mark++; Say ("----- סימון {0} · {1} -----" -f $mark, (Get-Date -Format "HH:mm:ss")) }
    }
  } catch { }
  Start-Sleep -Milliseconds $IntervalMs
  try { $cur = Snapshot } catch { Say ("!  {0} קריאה נכשלה: {1}" -f (Get-Date -Format "HH:mm:ss"), $_.Exception.Message); continue }
  $changes = @()
  foreach ($k in ($cur.Keys | Sort-Object)) {
    if ($noisy.ContainsKey($k)) { continue }
    if ($prev.ContainsKey($k) -and $prev[$k] -ne $cur[$k]) { $changes += ("אוגר {0}: {1} → {2}" -f $k, $prev[$k], $cur[$k]) }
  }
  if ($changes.Count) {
    $m = "?"; if ($cur.ContainsKey($modeReg)) { $m = $cur[$modeReg] }
    Say ("{0}  [MODE={1}]  {2}" -f (Get-Date -Format "HH:mm:ss"), $m, ($changes -join " · "))
  }
  $prev = $cur
}
