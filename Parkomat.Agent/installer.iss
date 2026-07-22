; ===== Parkomat Agent Installer — התקנה למשתמש, בלי הרשאת מנהל =====
; המוצר מותקן עבור המשתמש הנוכחי בלבד (localappdata), בלי שירותי Windows ובלי UAC.
; ה-Tray עולה אוטומטית בכניסת המשתמש, ומפעיל+משגיח על ה-Agent ועל Mosquitto כתהליכים.

#define MyAppName "Parkomat Agent"
#define MyAppVersion "1.0.14"
#define MyAppPublisher "Parkomat"
#define ServiceName "ParkomatAgent"
#define ServiceExe "Parkomat.Agent.Service.exe"
#define TrayExe "Parkomat.Agent.Tray.exe"

; נתיבי הפרסום על מחשב הפיתוח
#define ServicePublishDir "C:\Users\נעמהמנדלסון\Documents\parkomatProjects\Parkomat.Agent\publish\service"
#define TrayPublishDir "C:\Users\נעמהמנדלסון\Documents\parkomatProjects\Parkomat.Agent\publish\tray"

; מיקום קבצי Mosquitto (על מחשב הפיתוח)
#define MosquittoDir "C:\Program Files\mosquitto"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; התקנה למשתמש הנוכחי בלבד — בלי הרשאת מנהל, בלי חלון UAC.
PrivilegesRequired=lowest
; מתקינים לתיקיית המשתמש (…\AppData\Local\Parkomat\Agent).
DefaultDirName={localappdata}\Parkomat\Agent
DisableProgramGroupPage=yes
; רישום-לוג מלא של ההתקנה ל-%TEMP%\Setup Log*.txt (Inno יציע לשמור אם נכשל).
SetupLogging=yes
OutputBaseFilename=ParkomatAgentSetup
OutputDir=installer-output
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "hebrew"; MessagesFile: "compiler:Languages\Hebrew.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; קבצי השירות (ה-Agent) — רץ כתהליך רגיל, לא כשירות.
Source: "{#ServicePublishDir}\*"; DestDir: "{app}\service"; Flags: recursesubdirs createallsubdirs ignoreversion
; קבצי ממשק המשתמש (Tray)
Source: "{#TrayPublishDir}\*"; DestDir: "{app}\tray"; Flags: recursesubdirs createallsubdirs ignoreversion
; קבצי Mosquitto (כולל cacert.pem) — בתוך תיקיית ההתקנה שלנו. ה-Agent מעתיק את
; התעודה בזמן ריצה לנתיב ה-ASCII הקבוע (ProgramData) כדי ש-Mosquitto יקרא אותה.
Source: "{#MosquittoDir}\*"; DestDir: "{app}\mosquitto"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
; הפעלה אוטומטית של ה-Tray בכניסת המשתמש (HKCU — לא דורש הרשאת מנהל).
; ה-Tray הוא שמפעיל את ה-Agent ואת Mosquitto ומשגיח עליהם.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "ParkomatAgentTray"; \
  ValueData: """{app}\tray\{#TrayExe}"""; Flags: uninsdeletevalue

[InstallDelete]
; מסירים קיצור-דרך ישן משולחן העבודה (מגרסאות קודמות) — עכשיו הוא בתפריט התחל.
Type: files; Name: "{userdesktop}\{#MyAppName}.lnk"

[Icons]
; קיצור דרך בתפריט התחל (רשימת האפליקציות, ליד 'הגדרות'/'תמונות') — כדי שאחרי
; "יציאה" אפשר להחזיר את ה-Agent בלחיצה אחת (ה-Tray מפעיל שוב את השירות
; ו-Mosquitto בעלייתו). {userprograms} ולא {commonprograms} — התקנה למשתמש,
; בלי הרשאת מנהל.
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\tray\{#TrayExe}"; \
  WorkingDir: "{app}\tray"; Comment: "הפעל את Parkomat Agent"; \
  IconFilename: "{app}\tray\Assets\logo-color.ico"

[Run]
; מפעילים את ה-Tray מיד בסוף ההתקנה — הוא ידאג להפעיל את השאר.
Filename: "{app}\tray\{#TrayExe}"; \
  Description: "הפעל את Parkomat Agent"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
; לפני מחיקת הקבצים — סוגרים את שלושת התהליכים כדי לשחרר נעילות.
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im {#TrayExe}"; Flags: runhidden; RunOnceId: "KillTray"
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im {#ServiceExe}"; Flags: runhidden; RunOnceId: "KillAgent"
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im mosquitto.exe"; Flags: runhidden; RunOnceId: "KillMosq"

[UninstallDelete]
; מוחקים את כל תיקיית ההתקנה (service, tray, mosquitto) ואת נתוני הריצה,
; כדי שלא יישאר שום עקבות.
Type: filesandordirs; Name: "{app}"
; נתוני ה-Agent + Mosquitto ב-ProgramData (config, bridge.conf, logs, cacert, persistence).
Type: filesandordirs; Name: "{commonappdata}\Parkomat"

[Code]
// מריץ פקודה חבויה ומחכה לסיומה; מתעלם מכל שגיאה — ניקוי הגנתי בלבד.
procedure ExecHidden(const FileName, Params: String);
var
  ResultCode: Integer;
begin
  Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// רץ *לפני* העתקת הקבצים: סוגר תהליכים קיימים (התקנה חוזרת/שדרוג) כדי לשחרר נעילות.
// בנוסף מנסה — best-effort — להסיר שירותים ישנים מגרסה קודמת שהותקנה כמנהל.
// בלי הרשאת מנהל פקודות ה-sc פשוט נכשלות בשקט (בלי UAC); אם המשתמש כן מנהל, זה מנקה.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Sys: String;
begin
  Sys := ExpandConstant('{sys}');

  // סוגרים את התהליכים של הגרסה החדשה (אם רצים).
  ExecHidden(Sys + '\taskkill.exe', '/f /im {#TrayExe}');
  ExecHidden(Sys + '\taskkill.exe', '/f /im {#ServiceExe}');
  ExecHidden(Sys + '\taskkill.exe', '/f /im mosquitto.exe');

  // ניקוי שירותים ישנים (גרסת-מנהל קודמת) — best-effort בלבד.
  ExecHidden(Sys + '\sc.exe', 'stop Mosquitto');
  ExecHidden(Sys + '\sc.exe', 'stop {#ServiceName}');
  ExecHidden(Sys + '\sc.exe', 'delete Mosquitto');
  ExecHidden(Sys + '\sc.exe', 'delete {#ServiceName}');

  // אילוץ ברירות מחדל בכל התקנה — אך בלי למחוק את זהות האתר: מניחים דגל,
  // וה-Agent בעלייתו מאפס את PLC/HiveMQ לברירות המחדל תוך *שמירת ה-SiteId*
  // שהוזן (ראה ConfigStore.ApplyResetMarkerIfPresent). config.json *אינו* נמחק
  // כאן — הסוכן צריך אותו כדי לקרוא את ה-SiteId הישן לפני האיפוס.
  ForceDirectories(ExpandConstant('{commonappdata}\Parkomat\Agent'));
  SaveStringToFile(ExpandConstant('{commonappdata}\Parkomat\Agent\reset-to-defaults.flag'), '', False);

  Result := '';   // ריק = ממשיכים בהתקנה
end;
