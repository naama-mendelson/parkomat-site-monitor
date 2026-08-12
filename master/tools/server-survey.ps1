# server-survey.ps1 - Parkomat SiteMonitor server survey. READ ONLY.
#
# ============================================================
# WHY THIS FILE IS IN ENGLISH
# ============================================================
# Every other comment in this project is Hebrew. This file is not, and the
# reason is mechanical: Windows PowerShell 5.1 reads .ps1 files using the
# system ANSI codepage unless the file carries a UTF-8 BOM. On an unknown
# machine that turns Hebrew into mojibake and the script fails to *parse* -
# not to run, to parse. It also has to survive being pasted straight into a
# console window, where the codepage is whatever it happens to be.
#
# ASCII removes the entire class of failure. On a machine we cannot test
# first, that is worth more than matching the house style.
#
# ============================================================
# WHAT IT DOES - AND DOES NOT
# ============================================================
# Reads only. It installs nothing, changes no setting, opens no port and
# writes nowhere except the screen. Safe on a production server.
#
# HOW TO RUN
#   1. Open PowerShell on the target server (Administrator not required -
#      the script reports what it could not read).
#   2. Paste the whole thing, press Enter.
#   3. Copy ALL the output and send it back.
#
# !! FILL IN THESE TWO before running. They are in the system's .env file.
#    Without them the connectivity tests are skipped - and those are the
#    most important part of the survey.

$HIVEMQ_HOST   = "xxxxxxxx.s1.eu.hivemq.cloud"
$SUPABASE_HOST = "aws-0-xxxx.pooler.supabase.com"

# ------------------------------------------------------------
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference    = "SilentlyContinue"

function Section($t) { ""; "=" * 64; "  $t"; "=" * 64 }
function Item($k, $v) { "{0,-32} {1}" -f "$k", $v }

"Parkomat SiteMonitor - server survey"
"Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

Section "1. MACHINE"
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
Item "Hostname"          $env:COMPUTERNAME
Item "OS"                "$($os.Caption) build $($os.BuildNumber)"
Item "Architecture"      $os.OSArchitecture
Item "RAM (GB)"          ([math]::Round($cs.TotalPhysicalMemory / 1GB, 1))
Item "Logical cores"     $cs.NumberOfLogicalProcessors
Item "Last boot"         $os.LastBootUpTime
Item "Uptime"            ((Get-Date) - $os.LastBootUpTime).ToString("d\d\ hh\:mm")

# The single most important line in this section. Any solution that needs an
# interactive session (Docker Desktop) will NOT come back after a power cut
# if the machine stops at the logon screen.
$wl = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Item "Auto-logon" $(if ($wl.AutoAdminLogon -eq "1") { "YES" } else { "NO - stops at logon screen" })

foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3") {
  Item "Disk $($d.DeviceID) free (GB)" ([math]::Round($d.FreeSpace / 1GB, 1))
}
$bat = Get-CimInstance Win32_Battery
Item "UPS detected" $(if ($bat) { "YES - $($bat.Name)" } else { "not detected (may exist, not on USB)" })

Section "2. CLOCK - critical for this system"
# All hour-of-day / day-of-week statistics and month boundaries are computed
# from the LOCAL clock. A server on UTC shifts everything by 3 hours. And the
# ingestion compares agent timestamps against this clock - drift causes real
# messages to be rejected.
Item "Time zone"      (Get-TimeZone).Id
Item "Local time"     (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Item "UTC time"       ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss"))
$w32 = w32tm /query /status 2>&1 | Out-String
Item "Time source"    $(if ($w32 -match "Source:\s*(.+)") { $Matches[1].Trim() } else { "unavailable / not synced" })

Section "3. OUTBOUND CONNECTIVITY - the usual project killer"
# Without these the system simply does not work: 8883 carries the messages
# from the parking sites, 6543 is the database. Many corporate firewalls
# allow only 80/443, which silently blocks 6543.
function TestPort($label, $target, $port) {
  if ($target -like "xxx*") { Item $label "SKIPPED - hostname not filled in"; return }
  $r = Test-NetConnection -ComputerName $target -Port $port -WarningAction SilentlyContinue
  Item $label $(if ($r.TcpTestSucceeded) { "OPEN" } else { "BLOCKED" })
}
TestPort "HiveMQ 8883 (MQTT/TLS)"   $HIVEMQ_HOST   8883
TestPort "Supabase 6543 (Postgres)" $SUPABASE_HOST 6543
TestPort "Supabase 443 (HTTPS)"     $SUPABASE_HOST 443
TestPort "Internet 443 (control)"   "www.google.com" 443

# A TLS-inspecting proxy replaces the certificate with the company's own.
# If that is happening we must install their root CA, or every encrypted
# connection fails with an opaque error.
try {
  $req = [Net.HttpWebRequest]::Create("https://www.google.com")
  $req.Timeout = 8000
  $req.GetResponse() | Out-Null
  $issuer = ($req.ServicePoint.Certificate.Issuer -split ",")[0]
  Item "Certificate issuer" $issuer
  Item "TLS interception" $(if ($issuer -match "Google|GTS|WR|WE") { "no" } else { "LIKELY - $issuer" })
} catch { Item "TLS probe" "failed: $($_.Exception.Message)" }

$px = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
Item "HTTP proxy" $(if ($px.ProxyEnable -eq 1) { $px.ProxyServer } else { "none" })

Section "4. NETWORK IDENTITY"
$nic = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq "Up" } | Select-Object -First 1
$ip  = $nic.IPv4Address.IPAddress
Item "Internal IP"    $ip
Item "IP assignment"  $(if ((Get-NetIPAddress -IPAddress $ip).PrefixOrigin -eq "Dhcp") { "DHCP - may change" } else { "static" })
Item "Gateway"        $nic.IPv4DefaultGateway.NextHop
Item "DNS servers"    (($nic.DNSServer | Where-Object AddressFamily -eq 2).ServerAddresses -join ", ")
Item "Domain"         $(if ($cs.PartOfDomain) { $cs.Domain } else { "workgroup" })

$busy = Get-NetTCPConnection -LocalPort 4000 -State Listen
Item "Port 4000" $(if ($busy) { "IN USE by PID $($busy.OwningProcess)" } else { "free" })

Section "5. WHAT ALREADY RUNS HERE"
$n = Get-Command node   -ErrorAction SilentlyContinue
$d = Get-Command docker -ErrorAction SilentlyContinue
Item "Node.js" $(if ($n) { & node --version } else { "not installed" })
Item "Docker"  $(if ($d) { & docker --version } else { "not installed" })
Item "Hyper-V service" $(if ((Get-Service vmms).Status) { (Get-Service vmms).Status } else { "absent" })

""; "Listening ports (excluding Windows internals):"
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -lt 10000 -and $_.LocalPort -notin 135,139,445 } |
  Select-Object LocalPort, @{n="Process";e={ (Get-Process -Id $_.OwningProcess).ProcessName }} -Unique |
  Sort-Object LocalPort | Format-Table -AutoSize | Out-String

Section "6. SECURITY AND UPDATES"
$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct
Item "Antivirus / EDR" $(if ($av) { ($av.displayName -join ", ") } else { "not detected" })
Item "Firewall on"     ((Get-NetFirewallProfile | Where-Object Enabled -eq $true).Name -join ", ")

# An unattended 3am reboot with no auto-start for the service is a silent
# outage until someone notices in the morning.
$au = Get-ItemProperty "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
Item "Update policy" $(if ($au) { "managed (AUOptions=$($au.AUOptions))" } else { "default - auto reboot possible" })

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
Item "Running as admin" $((New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

""; "=" * 64
"END OF SURVEY - please copy ALL of the above and send it back."
"=" * 64
