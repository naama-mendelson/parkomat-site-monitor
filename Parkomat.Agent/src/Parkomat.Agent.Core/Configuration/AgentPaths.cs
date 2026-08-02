namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// נתיבים קבועים של קבצי ה-Agent, מרוכזים במקום אחד כדי ששני התהליכים
/// (ה-Service וה-Tray) יתייחסו בדיוק לאותם קבצים.
/// </summary>
public static class AgentPaths
{
    /// <summary>
    /// תיקיית הבסיס של הנתונים:
    /// C:\ProgramData\Parkomat\Agent
    /// נבחרה כי היא משותפת לכל המשתמשים במחשב — ה-Service (מערכת)
    /// וה-Tray (משתמש רגיל) שניהם יכולים לגשת אליה.
    /// </summary>
    public static string BaseFolder { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Parkomat",
        "Agent");

    /// <summary>נתיב מלא לקובץ ההגדרות: ...\Parkomat\Agent\config.json</summary>
    public static string ConfigFile { get; } = Path.Combine(BaseFolder, "config.json");

    /// <summary>
    /// סימון "אפס להגדרות ברירת מחדל" שהמתקין מניח בכל התקנה. ה-ConfigStore, בעליית
    /// הסוכן, מאפס את ה-config לברירות המחדל אך **שומר את ה-SiteId** שהוזן — כדי
    /// שעדכון לא ימחוק את זהות האתר (topics ריקים sites// + התנגשות clientId).
    /// </summary>
    public static string ResetToDefaultsFlag { get; } = Path.Combine(BaseFolder, "reset-to-defaults.flag");

    /// <summary>
    /// נתיב לקובץ פעימת הלב: ...\Parkomat\Agent\heartbeat.
    /// השירות מעדכן אותו אחרי כל קריאה מוצלחת מה-PLC,
    /// וממשק המשתמש בודק אותו כדי לדעת אם ה-Agent באמת עובד.
    /// </summary>
    public static string HeartbeatFile { get; } = Path.Combine(BaseFolder, "heartbeat");

    /// <summary>
    /// נתיב לקובץ החיוּת: ...\Parkomat\Agent\alive.
    ///
    /// ==========================================================
    /// למה זה קובץ נפרד מ-heartbeat, ולא עוד שימוש בו
    /// ==========================================================
    /// שני הקבצים עונים על שתי שאלות **שונות**, וערבוב שלהן היה באג אמיתי:
    ///
    ///   heartbeat — "הקריאה מה-PLC הצליחה". צובעת את הסמל ב-Tray. אתר שהבקר
    ///               שלו מת *חייב* להיראות אפור, ולכן אסור לכתוב אותה בכשל.
    ///   alive     — "לולאת ה-Worker מסתובבת". נכתבת בכל סבב, גם כשהקריאה
    ///               נכשלה, ומשמשת **רק** להחלטת ה-watchdog אם הסוכן תקוע.
    ///
    /// כשה-watchdog התבסס על heartbeat, נתק PLC נראה לו זהה לתקיעה: הוא הרג
    /// את הסוכן אחרי 30 שניות, בעוד שהסוכן צריך ~42 שניות (10 כשלונות × 3.2ש'
    /// timeout + מרווח דגימה) כדי לשדר state=error. ההריגה מאפסת את המונה,
    /// ולכן זו לא הייתה תחרות אלא **מלכודת: error לא שודר לעולם**, והאתר
    /// דשדש בין no_comm להפעלה-מחדש במקום להציג תקלת בקר.
    /// </summary>
    public static string LivenessFile { get; } = Path.Combine(BaseFolder, "alive");

    /// <summary>
    /// מצב ה-detector בין הרצות: ...\Parkomat\Agent\detector-state.
    ///
    /// ==========================================================
    /// למה זה נשמר, ומה זה מונע
    /// ==========================================================
    /// ה-detector הוא edge-triggered — הוא משדר על *שינוי* MODE. בעלייה אין
    /// לו MODE קודם, ולכן קריאה ראשונה שנוחתת באמצע מחזור (MODE 2/3) פותחת
    /// פעולה חדשה עם חותם "עכשיו".
    ///
    /// זה נכון להתקנה טרייה, אבל שגוי אחרי **הפעלה מחדש**: הפעולה כבר הייתה
    /// פתוחה, ומפתח ה-dedup בשרת בנוי על החותם המדווח — ולכן כל עלייה ייצרה
    /// שורת פעולה נוספת. אתר עם MODE תקוע על 2 ייצר פעולה פיקטיבית בכל
    /// הפעלה. וזה לא רק רעש: **מכנה אחוז הכשל הוא מספר הפעולות**, ולכן אתר
    /// שבור קיבל ציון בריא יותר ככל שהוא נשבר יותר.
    ///
    /// שמירת ה-MODE האחרון מאפשרת לסוכן להמשיך מאיפה שהפסיק במקום לפתוח
    /// מחדש. כמו בהיסט השעון, הקובץ נושא חותם ונפסל אם הוא ישן מדי — מצב
    /// ישן היה מייצר `end` לפעולה שהסתיימה מזמן, עם משך מנופח.
    /// </summary>
    public static string DetectorStateFile { get; } = Path.Combine(BaseFolder, "detector-state");

    /// <summary>
    /// ההיסט האחרון שנמדד מול שרת NTP, בפורמט "&lt;שניות&gt; &lt;נמדד-ב-unix&gt;".
    /// נשמר כדי שסוכן שעולה בלי אינטרנט יתחיל מההיסט הידוע האחרון במקום מאפס.
    /// חותם המדידה חיוני — היסט ישן מדי נפסל (ראה AgentClock.TryLoad).
    /// </summary>
    public static string ClockOffsetFile { get; } = Path.Combine(BaseFolder, "clock-offset");

    /// <summary>
    /// נתיב לקובץ סטטוס החיבור ל-HiveMQ: ...\Parkomat\Agent\hivemq-status.
    /// השירות כותב אליו "&lt;0|1&gt; &lt;unix-seconds&gt;" — האם גשר ה-Mosquitto
    /// באמת מחובר ל-HiveMQ. ה-Tray קורא אותו כדי לצבוע את הסמל רק כשגם ה-PLC
    /// וגם ה-HiveMQ מחוברים.
    /// </summary>
    public static string HiveMqStatusFile { get; } = Path.Combine(BaseFolder, "hivemq-status");
    /// <summary>
    /// נתיב לקובץ הגישור של Mosquitto: ...\Parkomat\Agent\bridge.conf.
    /// ה-Agent כותב אותו אוטומטית לפי ההגדרות, ו-Mosquitto קורא ממנו.
    /// </summary>
    public static string BridgeConfigFile { get; } = Path.Combine(BaseFolder, "bridge.conf");

    /// <summary>
    /// נתיב לקובץ תעודת ה-CA של HiveMQ: ...\Parkomat\Agent\cacert.pem.
    /// המתקין מעתיק את התעודה לכאן — מיקום *קבוע* שאנחנו שולטים בו, בלי רווחים,
    /// כדי שגשר ה-TLS של Mosquitto ל-HiveMQ תמיד ימצא אותה. (בעבר הקישור היה
    /// ל-C:\Program Files\mosquitto\cacert.pem, שנשבר על מכונות 64-ביט שבהן
    /// Mosquitto נחת ב-Program Files (x86).)
    /// </summary>
    public static string CaCertFile { get; } = Path.Combine(BaseFolder, "cacert.pem");

    /// <summary>
    /// תיקיית הלוגים: ...\Parkomat\Agent\logs.
    /// השירות כותב לכאן קובץ ליום (agent-YYYY-MM-DD.log), כדי שטכנאי
    /// יוכל לקרוא מה ה-Agent עשה ולמה לא נשלח מידע.
    /// </summary>
    public static string LogsFolder { get; } = Path.Combine(BaseFolder, "logs");

    /// <summary>
    /// מוודא שתיקיית הבסיס קיימת. בטוח לקרוא לזה כמה פעמים —
    /// אם התיקייה כבר קיימת, לא קורה כלום.
    /// </summary>
    public static void EnsureBaseFolderExists()
    {
        Directory.CreateDirectory(BaseFolder);
    }

    /// <summary>מוודא שתיקיית הלוגים קיימת. בטוח לקרוא כמה פעמים.</summary>
    public static void EnsureLogsFolderExists()
    {
        Directory.CreateDirectory(LogsFolder);
    }
}