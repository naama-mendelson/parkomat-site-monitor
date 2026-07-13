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
    /// נתיב לקובץ פעימת הלב: ...\Parkomat\Agent\heartbeat.
    /// השירות מעדכן אותו אחרי כל קריאה מוצלחת מה-PLC,
    /// וממשק המשתמש בודק אותו כדי לדעת אם ה-Agent באמת עובד.
    /// </summary>
    public static string HeartbeatFile { get; } = Path.Combine(BaseFolder, "heartbeat");

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