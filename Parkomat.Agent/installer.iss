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
; 1.0.22 — כתיבה ישירה ל-Supabase (כבויה), תור עמיד בדיסק,
;          ו-cleansession false בגשר: נמדד 0 מתוך 5 הודעות ששרדו נתק
;          אינטרנט לפני, ו-5 מתוך 5 אחרי.
; 1.0.23 — **דופק**. הסוכן שולח אצווה ריקה כל 60 שניות, ו-pg_cron
;          מסמן no_comm אחרי 3 דקות שתיקה. זה מה שיחליף את הצוואה של
;          MQTT ביום ש-HiveMQ ייכבה — בלעדיו אתר מת נראה תקין לנצח.
;          ⚠️ הדופק שנבנה קודם מעולם לא שלח בקשה: SendAsync חוסם אצווה
;          ריקה לפני הרשת. BeatAsync היא הדלת היחידה ששולחת ריק.
;          + הגדרות: שדה אחד (סיסמה) במקום ארבעה. הכתובת והמפתח צרובים,
;          ושם המשתמש נגזר מקוד האתר.
;          + הסוכן מדווח את גרסתו על הפעימה — לראשונה אפשר לדעת מרחוק
;          איזו גרסה רצה באיזה אתר.
; 1.0.24 — **ניסיון חוזר לכתיבה הישירה**. אצווה שנכשלה נשמרת לדיסק
;          (queue-supabase) ונשלחת בסבב הבא, הישנות קודם. עד כה היא
;          נזרקה — נכון כל עוד MQTT הוא רשת הביטחון, ובדיוק מה שמנע
;          לכבות אותו: בלי זה כל גמגום רשת הוא אובדן נתונים קבוע.
;          ⚠️ תקרה של 100 לאצווה: השרת דוחה מעל 200 **כולה**, ותור של
;          1,000 אחרי נתק ארוך היה נדחה בכל ניסיון — תור שאינו מתרוקן.
; 1.0.25 — תפעול עבר להימרכז ל-Supabase **בנקודת ההפקה ואל הדיסק**.
;          קודם הוא מורכז מתוך הצופה, כלומר בכל ניסיון שידור — ותפעול
;          שנכשל נשלח שוב ושוב לאורך כל הנתק. המעבר לזיכרון פתח באג הפוך:
;          הפסקת חשמל בין ההפקה לשליחה מחקה אותו מ-Supabase לתמיד.
; 1.0.26 — **סיסמת Supabase שורדת שדרוג.** עד כה רק SiteId ופרטי MQTT
;          שרדו איפוס, כלומר כל שדרוג כיבה את המסלול הישיר בשקט: Enabled
;          נגזר מהסיסמה, אז סיסמה שנמחקה אינה שגיאה ואינה שורת לוג.
;          + גם שלוש העקיפות, שהן דלת היציאה.
; 1.0.27 — **אבחון.** שורת העלייה נושאת גרסה (עד כה היא דווחה רק דרך
;          הפעימה, כלומר רק כשהמסלול הישיר דולק — לא באתר שהשתבש בו
;          משהו), ומצב כבוי מדפיס **למה** הוא כבוי במקום לשתוק.
;          + שם קובץ ההתקנה נושא את הגרסה: שתי גרסאות נבנו לאותו נתיב
;          ולא היה אפשר לדעת בדיעבד איזו הותקנה.
; 1.0.28 — **דגל האיפוס נצרך לפני הכתיבה, לא אחריה.** קודם הסדר היה
;          הפוך והכול בתוך catch בולע: מחיקה שנכשלה השאירה את הדגל, ואז
;          **כל** קריאה ל-Load איפסה את ה-config מחדש. Load נקראת מארבעה
;          מקומות, ובהם ServiceManager שקורא אותה שוב ושוב — כלומר סיסמה
;          שהוקלדה ביד נמחקה שניות אחר כך, והטופס נפתח ריק. זה נראה כאילו
;          כפתור השמירה שבור, ושלח את האבחון לכיוון הלא נכון.
; 1.0.29 — **רק העלייה צורכת את דגל האיפוס.** האיפוס ישב בתוך Load,
;          כלומר כל *קריאה* של ההגדרות יכלה לשכתב אותן — ו-Load נקראת
;          מארבעה מקומות, ובהם ServiceManager שקורא אותה בכל בדיקת שומר.
;          ⚠️ ובזמן התקנה זה חמור: תהליך של הגרסה הקודמת שעדיין רץ צורך
;          את הדגל **בקוד הישן שלו**, כלומר מאפס לפי כללים של גרסה
;          שהוחלפה — ומוחק שדות שהגרסה החדשה שומרת. זו ההשערה המובילה
;          לכך שתיקון 1.0.26 לא החזיק בהתקנה אמיתית.
; 1.0.30 — **Load אינה כותבת יותר, בשום מסלול.** נשארה בה כתיבה אחת:
;          קובץ שאינו קיים גרם לה לשמור ברירות מחדל. רגע אחד שבו הקובץ
;          אינו קיים — נעילה, אנטי-וירוס, כתיבה מקבילה — ומי שקרא במקרה
;          דרס את ההגדרות. ⚠️ ו"מי שקרא במקרה" הוא ServiceManager, שקורא
;          כמה פעמים בדקה: סיסמה נמחקת בלי שאיש נגע בטופס, בלי התקנה,
;          ובלי שורה בלוג. יצירת הקובץ בהרצה ראשונה עברה ל-LoadAtStartup.
; 1.0.31 — **המסלול הישיר מנותק מ-MQTT באמת.** עד כה הכתיבה ל-Supabase
;          ישבה בתוך ה-try שנפתח ב-EnsureConnectedAsync: ברוקר מקומי שאינו
;          זמין זורק בשורה הראשונה, וכל מה שאחריו מדלג — כולל הכתיבה
;          הישירה **וכולל הפעימה**. כלומר המסלול שנבנה כדי לשרוד את נפילת
;          MQTT יכול היה לרוץ רק בסבב שבו MQTT דווקא עבד.
;          ⚠️ נמדד פעמיים: בלוג 2438 כל שש הכתיבות הישירות הופיעו מיד אחרי
;          חיבור-מחדש, ובניסוי מבוקר סוכן בלי ברוקר לא כתב דבר בשלוש דקות.
;          + מצב ו-resync ממורכזים בנקודת ההפקה, והתפר OnPublished הוסר:
;          הוא ישב על ניסיון השידור ולא על הפקת ההודעה, ומשם נולדו שני
;          באגים בלתי תלויים.
; 1.0.32 — ⚠️ **הסרה הפסיקה למחוק את זהות האתר.** [UninstallDelete] הכיל
;          {commonappdata}\Parkomat, כלומר הסרה-והתקנה מחקה את config.json
;          כולו: מזהה האתר, סיסמת HiveMQ, וסיסמת Supabase. נמדד באתר 2438 —
;          הלוג אמר `Config loaded for site ''` ואחריו SITE ID IS INVALID,
;          והסוכן הפסיק לשדר לגמרי. וסיסמת Supabase מוצגת פעם אחת בהנפקה,
;          אז אין מאיפה להעתיק אותה.
;          ⚠️ וזו הייתה הסיבה האמיתית מאחורי יום שלם של אבחון: כל התיקונים
;          ב-ConfigStore שומרים שדות **מקובץ שכבר נמחק**.
;          נמחק עכשיו רק מה שנוצר מחדש מעצמו; config.json והלוגים נשארים.
; 1.0.33 — **מצב ישיר בלבד.** Mqtt.Disabled ב-config.json מכבה את מסלול
;          ה-MQTT לגמרי: אין חיבור לברוקר, bridge.conf נמחק (ולכן ה-Tray
;          אינו מעלה את Mosquitto), ותפעולים אינם נכנסים לתור שאיש לא
;          ירוקן. ⚠️ הכיבוי **נגזר** ומותנה ב-Supabase.Enabled: אתר בלי
;          סיסמה נשאר על MQTT, כי אתר שאינו מדווח לשום מקום הוא הכשל
;          השקט הגרוע ביותר במערכת הזו. אין תיבת סימון בטופס בכוונה —
;          לחיצה אחת בשדה הייתה משביתה אתר, כמו תיבת ה-TLS שהוסרה.
; 1.0.34 — ⚠️ **ה-Tray מחליט על Mosquitto מההגדרה, לא מ-bridge.conf.**
;          1.0.33 הסתמך על כך שהסוכן מוחק את bridge.conf, ושבלעדיו ה-Tray
;          לא יעלה את Mosquitto. זה מרוץ, והוא הפסיד בשטח: Start() מפעיל
;          את הסוכן ומיד בודק את הקובץ — לפני שהסוכן הספיק למחוק. הלוג אמר
;          "MQTT is OFF" ו-Mosquitto רץ לצדו, כלומר האתר שידר בשני
;          המסלולים בזמן שהוגדר לאחד. + כיבוי אקטיבי: Mosquitto שכבר רץ
;          נעצר, אחרת המתג היה דורש הפעלה מחדש כדי לתפוס.
; 1.0.35 — ⚠️ **לחיצה על "שמור" בטופס הדליקה מחדש את MQTT.** OnSave בונה
;          MqttConfig מאפס מארבעה שדות, ואין בטופס תיבה ל-Disabled (בכוונה),
;          ולכן הערך אבד בכל שמירה. בשטח זה נראה כאילו ההתקנה מחקה את הדגל:
;          מתקינים, מקלידים סיסמה, לוחצים שמור — ו-Mosquitto חוזר לאוויר.
;          אותו דפוס בדיוק כמו _sbOverrides.
; 1.0.36 — ⚠️ **אתר ישיר-בלבד לא דיווח את מצבו.** הודעת ה"לידה" וה-resync
;          חיו בתוך שלב ג', שמדולג כשה-MQTT כבוי. נצפה באתר 2438 דקות
;          אחרי הכיבוי: הפעימות עלו כרגיל והסטטוס נשאר תקוע על no_comm,
;          כי הצוואה של הגשר סימנה אותו כש-Mosquitto נעצר ואיש לא ניקה.
;          פעימה מוכיחה **חיים**, לא **מצב** — ובאתר שקט הודעת מצב עשויה
;          לא להגיע במשך ימים.
; 1.0.37 — **Modbus מעל UDP, לבחירה.** יש בקרים שחושפים Modbus ב-UDP
;          בלבד. Plc.Transport ("tcp"/"udp") בוחר, והבורר יושב בחלונית
;          הכתובות — הגדרת התקנה, לא הגדרה יומיומית. ערך לא מוכר
;          נופל ל-TCP **עם שורת אזהרה בלוג**, כדי שקובץ שאומר UDP
;          וסוכן שקורא TCP לא יהיה פער שאיש יכול לראות.
;          ⚠️ **התעבורה שורדת את איפוס ההתקנה** (BuildResetConfig), בעוד
;          הכתובת והרגיסטרים ממשיכים להתאפס כמקודם. כתובת שגויה
;          נכשלת בקול וניתנת להקלדה מחדש; תעבורה שגויה נראית זהה —
;          הבקר פשוט אינו עונה — ואין בקובץ עקב לכך שמישהו בחר אחרת.
;          + תיקון נלווה: שני הטפסים בנו PlcConfig מחדש עם 5 שדות מתוך 8,
;          ולכן **כל שמירה מחקה את FaultTextRegister**. עכשיו נערך במקום.
#define MyAppVersion "1.0.38"
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

; ⚠️ גרסה על **קובץ ההתקנה עצמו**, ולא רק בלוח הבקרה.
; AppVersion למעלה עונה על "איזו גרסה מותקנת באתר". השורות האלה עונות על
; שאלה אחרת שנשאלת קודם: טכנאי עם שלושה ParkomatAgentSetup.exe בתיקיית
; ההורדות — איזה מהם החדש? בלעדיהן מאפייני הקובץ ריקים לגמרי, והתשובה
; היחידה היא תאריך השינוי, שמשתנה בכל העתקה.
VersionInfoVersion={#MyAppVersion}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
AppPublisher={#MyAppPublisher}
; התקנה למשתמש הנוכחי בלבד — בלי הרשאת מנהל, בלי חלון UAC.
PrivilegesRequired=lowest
; מתקינים לתיקיית המשתמש (…\AppData\Local\Parkomat\Agent).
DefaultDirName={localappdata}\Parkomat\Agent
DisableProgramGroupPage=yes
; רישום-לוג מלא של ההתקנה ל-%TEMP%\Setup Log*.txt (Inno יציע לשמור אם נכשל).
SetupLogging=yes
; ⚠️ הגרסה **בשם הקובץ**, ולא רק במאפיינים.
; ב-06/09/2026 נבנו 1.0.25 ו-1.0.26 לאותו נתיב בדיוק. אחת מהן הותקנה
; באתר 2438, ולא הייתה שום דרך לדעת בדיעבד איזו — מה שהפך שאלה עובדתית
; ("האם התיקון עבד?") לבלתי-פתירה, והוביל לשעה של ניחושים על גבי לוגים.
; מאפייני הקובץ אכן נושאים גרסה (VersionInfoVersion למטה), אבל אף אחד
; אינו פותח מאפיינים לפני שהוא לוחץ פעמיים — וטכנאי עם שלושה קבצים
; בהורדות בוחר לפי השם.
OutputBaseFilename=ParkomatAgentSetup-{#MyAppVersion}
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
; ============================================================
; ⚠️ משימה מתוזמנת — כי `Run` לבדו אינו מספיק
; ============================================================
; נמדד באתר 1089, 09/09/2026, מיומני האירועים של Windows:
;
;     02:59  1074  הפעלה מחדש יזומה
;     03:02  6005  עלייה
;     03:04  1074  ועוד אחת, שלוש דקות אחרי   ← חתימת עדכון Windows
;     03:04  6005  עלייה
;
; המשתמש היה מחובר (`query user` → Active מ-03:04), הערך ב-`Run` היה קיים
; ותקין — **והטריי לא עלה חמש שעות.** באתחול של עדכון, Windows מחזירה את
; המשתמש לסשן כדי לסיים את העדכון, אבל רצף העלייה של אפליקציות המשתמש
; לא מתבצע כרגיל.
;
; ⚠️ **המשמעות: אתר מת לגמרי אחרי כל עדכון, עד שמישהו מגיע פיזית.**
; פעם בחודש, ב-21 אתרים, בשעות הלילה — ובזמנים מפוזרים, כי העדכונים
; מתגלגלים לכל מכונה בנפרד. זה מה שנראה כמו "הרבה אתרים בלי קליטה".
;
; ⚠️ **משימה מתוזמנת מופעלת ע"י שירות Task Scheduler**, שאינו תלוי ברצף
; העלייה של המעטפת — וזו בדיוק התכונה שחסרה ל-`Run`.
;
; וכל חמש דקות ולא רק בכניסה: כך נתפסת גם קריסה באמצע היום, ומשך
; ההשבתה חסום בחמש דקות במקום בשעות.
;
; ⚠️ **והפעלה כפולה אינה מזיקה**: `Program.cs` של הטריי מחזיק Mutex,
; ומופע שני יוצא בשקט. בלי המאפיין הזה המשימה הייתה מייצרת עשרות
; טריים ביום.
;
; ⚠️ **בלי הרשאות מנהל**: משימה למשתמש הנוכחי, "רק כשהמשתמש מחובר" —
; אין סיסמה שמורה ואין UAC, בדיוק כמו שאר ההתקנה.
; `/F` — דורס משימה קודמת, כדי שהתקנה חוזרת לא תיכשל.
Filename: "{sys}\schtasks.exe"; \
  Parameters: "/Create /TN ""ParkomatAgentKeepAlive"" /TR ""\""{app}\tray\{#TrayExe}\"""" /SC MINUTE /MO 5 /F"; \
  Flags: runhidden; StatusMsg: "מגדיר הפעלה אוטומטית..."

; מפעילים את ה-Tray מיד בסוף ההתקנה — הוא ידאג להפעיל את השאר.
Filename: "{app}\tray\{#TrayExe}"; \
  Description: "הפעל את Parkomat Agent"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
; לפני מחיקת הקבצים — סוגרים את שלושת התהליכים כדי לשחרר נעילות.
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im {#TrayExe}"; Flags: runhidden; RunOnceId: "KillTray"
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im {#ServiceExe}"; Flags: runhidden; RunOnceId: "KillAgent"
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im mosquitto.exe"; Flags: runhidden; RunOnceId: "KillMosq"
; ⚠️ והמשימה המתוזמנת נמחקת גם היא. בלעדיה הסרה משאירה משימה שמנסה
; להריץ קובץ שנמחק, כל חמש דקות, לנצח.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""ParkomatAgentKeepAlive"" /F"; Flags: runhidden; RunOnceId: "DelKeepAlive"

[UninstallDelete]
; מוחקים את כל תיקיית ההתקנה (service, tray, mosquitto) ואת נתוני הריצה,
; כדי שלא יישאר שום עקבות.
Type: filesandordirs; Name: "{app}"

; ============================================================
; ⚠️ ProgramData **אינו** נמחק כולו — וזו הייתה שורה אחת שעלתה יום שלם
; ============================================================
; כאן עמד:  Type: filesandordirs; Name: "{commonappdata}\Parkomat"
; בנימוק "שלא יישאר שום עקבות". המחיר התגלה ב-06/09/2026: הסרה-והתקנה
; מוחקת את config.json, כלומר את **זהות האתר** — מזהה האתר, סיסמת
; HiveMQ, וסיסמת Supabase.
;
; ⚠️ ושלושתם אינם ניתנים לשחזור באותה מידה:
;   • מזהה האתר — הסוכן מסרב לשדר בלעדיו ומדפיס SITE ID IS INVALID.
;   • סיסמת HiveMQ — יש ברירת מחדל צרובה, אז היא שורדת.
;   • סיסמת Supabase — **מוצגת פעם אחת בהנפקה**. Supabase שומר גיבוב
;     בלבד, ולכן אין מאיפה להעתיק אותה: צריך להנפיק חדשה, כלומר
;     שדרוג שגרתי הופך לפעולת ניהול.
;
; ⚠️ והכשל שקט לחלוטין: `SupabaseConfig.Enabled` נגזר, אז סיסמה שנמחקה
; אינה שגיאה — היא נראית זהה ל"האתר הזה לא הופעל".
;
; נמחק רק מה שנוצר מחדש מעצמו. **`config.json` והלוגים נשארים** —
; הלוגים כי הם הראיה היחידה כשחוקרים למה אתר הפסיק לדווח.
;
; ⚠️ המחיר המודע: `config.json` מכיל סיסמאות בטקסט גלוי והוא נשאר על
; המכונה אחרי הסרה. זה נכון גם היום בזמן שהסוכן מותקן, המחשב יושב
; בחניון ולא עובר יד, והחלופה — מחיקת זהות האתר בכל שדרוג — הוכחה
; כיקרה בהרבה.
Type: filesandordirs; Name: "{commonappdata}\Parkomat\Agent\queue"
Type: filesandordirs; Name: "{commonappdata}\Parkomat\Agent\queue-supabase"
Type: files; Name: "{commonappdata}\Parkomat\Agent\bridge.conf"
Type: files; Name: "{commonappdata}\Parkomat\Agent\cacert.pem"
Type: files; Name: "{commonappdata}\Parkomat\Agent\heartbeat"
Type: files; Name: "{commonappdata}\Parkomat\Agent\alive"
Type: files; Name: "{commonappdata}\Parkomat\Agent\detector-state"
Type: files; Name: "{commonappdata}\Parkomat\Agent\clock-offset"
Type: files; Name: "{commonappdata}\Parkomat\Agent\hivemq-status"
Type: files; Name: "{commonappdata}\Parkomat\Agent\reset-to-defaults.flag"

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
