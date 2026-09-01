; ===== Parkomat Agent Installer — התקנה למשתמש, בלי הרשאת מנהל =====
; המוצר מותקן עבור המשתמש הנוכחי בלבד (localappdata), בלי שירותי Windows ובלי UAC.
; ה-Tray עולה אוטומטית בכניסת המשתמש, ומפעיל+משגיח על ה-Agent ועל Mosquitto כתהליכים.

; 1.0.22 — תור השידור עבר לדיסק (שורד נפילת חשמל), cleansession בגשר תוקן
;          (נמדד: 0 מתוך 5 הודעות שרדו נתק אינטרנט לפניו, 5 מתוך 5 אחריו),
;          ונוספה כתיבה ישירה ל-Supabase — **כבויה** עד שממלאים אותה.
;
; ⚠️ 1.0.21 מעולם לא שוגר לשדה, ותוקן בו הפער שבו installer.iss הכריז על
;    גרסה שהבינאריים לא נשאו (הם אמרו 1.0.20). הגרסה חיה עכשיו במקום
;    אחד — Directory.Build.props — ו-AgentVersionTests נועל את השוויון.
#define MyAppName "Parkomat Agent"
; 1.0.17 — קריאת תיאור התקלה מהבקר (register 002, מחרוזת בסגנון C).
;          הטקסט מגיע ללוג הפעילות בדשבורד במקום "מושבת" סתמי.
;
; ⚠️ העלאת הגרסה אינה קוסמטית: היא מה שמאפשר לדעת **איזה סוכן מותקן באיזה
; אתר**. התקנה חוזרת עם אותו מספר נראית בלוח הבקרה כאילו כלום לא השתנה,
; ואז אי אפשר לענות על "האם האתר הזה כבר עודכן?".
; 1.0.18 — פרסום **עצמאי**: זמן הריצה של .NET ארוז בפנים.
;          ⚠️ 1.0.17 נבנה בטעות כ-framework-dependent, ולכן דרש התקנת
;          .NET 10 על כל מחשב אתר. אין להפיץ אותו.
; 1.0.19 — פענוח טקסט התקלה תוקן: הבקר שולח **נקודות קוד יוניקוד**
;          (1488=א .. 1514=ת), לא בתים ב-Windows-1255. 1.0.18 החזיר
;          "?א?? ?א???" במקום "מנהל חניון - דלתות חניון פתוחות".
; 1.0.20 — התרעה על מזהה אתר חסר. בלעדיו הנושאים יוצאים sites//state
;          והשרת אינו מנוי אליהם: כל הבדיקות ירוקות והאתר נעדר מהדשבורד.
;          כעת: הסוכן מסרב לשדר, הסמל נשאר אפור, ו"בדוק חיבור" אומר למה.
#define MyAppVersion "1.0.22"
#define MyAppPublisher "Parkomat"
#define ServiceName "ParkomatAgent"
#define ServiceExe "Parkomat.Agent.Service.exe"
#define TrayExe "Parkomat.Agent.Tray.exe"

; נתיבי הפרסום על מחשב הפיתוח
#define ServicePublishDir "C:\Users\נעמהמנדלסון\Documents\parkomatProjects\Parkomat.Agent\publish\service"
#define TrayPublishDir "C:\Users\נעמהמנדלסון\Documents\parkomatProjects\Parkomat.Agent\publish\tray"

; מיקום קבצי Mosquitto (על מחשב הפיתוח)
#define MosquittoDir "C:\Program Files\mosquitto"

; ה-runtime של Visual C++ — נשלח לצד mosquitto.exe (ראה [Files]).
#define VcRuntimeDir "C:\Users\נעמהמנדלסון\Documents\parkomatProjects\Parkomat.Agent\vendor\vcruntime"

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
; ============================================================
; ⚠️ VCRUNTIME140.dll — בלעדיו Mosquitto לא עולה במחשב נקי
; ============================================================
; מחשב אתר טרי הוא Windows בלי כלום. Mosquitto נבנה עם MSVC, וכל
; הבינאריים שלו (mosquitto.exe, mosquitto.dll, libcrypto, sqlite3,
; pthreadVC3) מייבאים VCRUNTIME140.dll — שמגיע רק עם חבילת ה-Visual
; C++ Redistributable. במחשב הפיתוח היא מותקנת, ולכן זה עבד כאן
; ונכשל בשטח עם:
;
;   mosquitto.exe - System Error
;   The code execution cannot proceed because VCRUNTIME140.dll was not found.
;
; ⚠️ **ולכן לא מריצים כאן vc_redist.exe.** ההתקנה הזו היא
; PrivilegesRequired=lowest במכוון — בלי UAC, לתיקיית המשתמש. חבילת
; ה-Redistributable היא התקנה מערכתית שדורשת מנהל, והוספתה הייתה
; שוברת בדיוק את מה שמאפשר להתקין באתר בלי לקרוא למחלקת IT.
;
; במקום זה — app-local: Windows מחפש DLL קודם כול בתיקיית הקובץ
; המריץ, ולכן די בהנחת העותק ליד mosquitto.exe. VCRUNTIME140 אינו
; KnownDLL, כך שהחיפוש הזה באמת חל עליו.
;
; ⚠️ **רק הקובץ הזה, ולא כל החבילה.** נבדק על טבלת ה-imports של כל
; בינארי בתיקיית Mosquitto: אף אחד אינו דורש MSVCP140 (זה C ולא C++)
; ואף אחד אינו דורש VCRUNTIME140_1 (טיפול חריגות של C++). שאר
; התלויות הן api-ms-win-crt-* — ה-UCRT, שהוא חלק מ-Windows 10 ומעלה.
Source: "{#VcRuntimeDir}\VCRUNTIME140.dll"; DestDir: "{app}\mosquitto"; Flags: ignoreversion

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

  // ==========================================================
  // סנכרון שעון המחשב (w32time) — שכבה 1 של דיוק זמן האירועים
  // ==========================================================
  // חותם הזמן של כל פעולה נלקח משעון המחשב הזה (AgentClock). מחשב עם שעון סוטה
  // רושם את כל הפעולות שלו בזמן שגוי, וזה מרעיל משכי מצבים, זמינות והארכיון
  // החודשי. נמדד בשטח: אתר אחד מקדים ב-34 שניות, אחר מפגר ב-235.
  //
  // ⚠️ הפקודות האלה דורשות הרשאות מנהל, וההתקנה הזו היא PrivilegesRequired=lowest
  // בכוונה (בלי UAC). לכן הן **best-effort בדיוק כמו פקודות ה-sc שמעליהן**: אם
  // המתקין רץ כמשתמש רגיל הן נכשלות בשקט וההתקנה ממשיכה כרגיל. אם הוא הורץ
  // כמנהל (או שהמשתמש הוא מנהל) — השעון יסונכרן.
  //
  // מה שקורה בפועל בכל מקרה: הסוכן מודד את ההיסט בעצמו ורושם אותו ללוג בעלייה
  // (HostClockDiagnostics), כך שאתר עם שעון סוטה גלוי גם כשהסנכרון לא הוגדר.
  //
  // *לא* נלחמים בניהול הזמן של Windows: לא מחליפים את השירות, לא כותבים
  // לרג'יסטרי ידנית, ולא מגדירים GPO. רק מוודאים שהשירות הסטנדרטי דולק ומצביע
  // על שרת זמן.

  // 1. שהשירות יעלה לבד בכל אתחול (ברירת המחדל היא demand, ואז הוא כבוי).
  ExecHidden(Sys + '\sc.exe', 'config w32time start= auto');

  // 2. להפעיל אותו עכשיו.
  ExecHidden(Sys + '\net.exe', 'start w32time');

  // 3. מקור זמן. time.windows.com הוא ברירת המחדל של Windows; pool.ntp.org
  //    נוסף כגיבוי, ובאותו סדר שהסוכן משתמש בו (SiteConfig.NtpServer).
  //    0x9 = client mode + SpecialInterval, הצירוף המומלץ למכונה שאינה בדומיין.
  ExecHidden(Sys + '\w32tm.exe',
    '/config /manualpeerlist:"time.windows.com,0x9 pool.ntp.org,0x9" /syncfromflags:manual /update');

  // 4. סנכרון ראשון מיד, כדי שהפעולה הראשונה שתדווח תישא זמן נכון.
  ExecHidden(Sys + '\w32tm.exe', '/resync /force');

  // אילוץ ברירות מחדל בכל התקנה — אך בלי למחוק את זהות האתר: מניחים דגל,
  // וה-Agent בעלייתו מאפס את PLC/HiveMQ לברירות המחדל תוך *שמירת ה-SiteId*
  // שהוזן (ראה ConfigStore.ApplyResetMarkerIfPresent). config.json *אינו* נמחק
  // כאן — הסוכן צריך אותו כדי לקרוא את ה-SiteId הישן לפני האיפוס.
  ForceDirectories(ExpandConstant('{commonappdata}\Parkomat\Agent'));
  SaveStringToFile(ExpandConstant('{commonappdata}\Parkomat\Agent\reset-to-defaults.flag'), '', False);

  Result := '';   // ריק = ממשיכים בהתקנה
end;
