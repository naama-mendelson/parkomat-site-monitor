using System.Text;

namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// כותב את קובץ הגישור של Mosquitto (bridge.conf) לפי ההגדרות.
/// כך הגדרות ה-HiveMQ מוזנות במקום אחד (הגדרות ה-Agent),
/// וה-Mosquitto מקבל אותן אוטומטית — הטכנאי לא נוגע בו.
///
/// יושב ב-Core כדי ששני הצדדים יוכלו לכתוב את אותו קובץ:
/// ה-Service (בעליית השירות) וה-Tray (מיד עם שמירת הגדרות, כדי להחיל בלי restart ידני).
/// </summary>
public static class BridgeConfigWriter
{
    /// <summary>
    /// ה-topic (מקומי בלבד) שאליו Mosquitto מפרסם את מצב חיבור הגשר ל-HiveMQ:
    /// "1" = מחובר, "0" = מנותק (retained). ה-Agent נרשם אליו כדי לדעת אם
    /// ההודעות באמת מגיעות ל-HiveMQ, ולא רק ל-Mosquitto המקומי.
    /// </summary>
    public const string BridgeStateTopic = "parkomat/bridge/state";

    /// <summary>
    /// מייצר את תוכן קובץ הגישור לפי ההגדרות, וכותב אותו לדיסק.
    /// </summary>
    public static void Write(SiteConfig config)
    {
        AgentPaths.EnsureBaseFolderExists();

        string content = Build(config);

        // כתיבה בטוחה: קודם לקובץ זמני, ואז החלפה — כדי שלא ייווצר
        // קובץ חצי-כתוב אם החשמל נופל באמצע.
        string tempFile = AgentPaths.BridgeConfigFile + ".tmp";
        File.WriteAllText(tempFile, content, new UTF8Encoding(false));
        File.Move(tempFile, AgentPaths.BridgeConfigFile, overwrite: true);
    }

    // בונה את הטקסט של קובץ הגישור.
    private static string Build(SiteConfig config)
    {
        string siteCode = config.SiteId;
        var mqtt = config.Mqtt;

        var sb = new StringBuilder();

        // --- מאזין מקומי: ה-Agent מתחבר לכאן ---
        sb.AppendLine("listener 1883 localhost");
        sb.AppendLine("allow_anonymous true");
        sb.AppendLine();

        // --- שמירה לדיסק (עמידות לניתוקים) ---
        sb.AppendLine("persistence true");
        sb.AppendLine(@"persistence_location C:\ProgramData\Parkomat\Mosquitto\");
        sb.AppendLine();

        // --- הגדרת הגשר ל-HiveMQ ---
        sb.AppendLine("connection hivemq-bridge");
        sb.AppendLine($"address {mqtt.Host}:{mqtt.Port}");
        // מעביר רק את הודעות האתר הזה, לפי קוד האתר.
        sb.AppendLine($"topic sites/{siteCode}/# out 1");
        sb.AppendLine("max_queued_messages 0");
        sb.AppendLine("try_private false");
        // מדווח על מצב חיבור הגשר ל-HiveMQ ל-topic מקומי (לא נשלח ל-HiveMQ עצמו),
        // כדי שה-Agent ידע אם הקשר לענן באמת קיים.
        sb.AppendLine("notifications true");
        sb.AppendLine("notifications_local_only true");
        sb.AppendLine($"notification_topic {BridgeStateTopic}");
        sb.AppendLine("cleansession true");
        sb.AppendLine();

        // --- פרטי ההתחברות ל-HiveMQ (מתוך ההגדרות) ---
        sb.AppendLine($"remote_username {mqtt.Username}");
        sb.AppendLine($"remote_password {mqtt.Password}");
        sb.AppendLine();

        // --- הצפנה ---
        // רק אם ההגדרות דורשות TLS (HiveMQ בענן). ל-Broker מקומי לבדיקות —
        // בלי TLS, כדי שלא ייכשל handshake מול פורט לא-מוצפן.
        // התעודה נמצאת במיקום קבוע ומבוקר (ProgramData, בלי רווחים בנתיב),
        // ולא ב-Program Files — כדי שלא ניפול על אי-התאמה של Program Files (x86).
        if (mqtt.UseTls)
        {
            sb.AppendLine("bridge_tls_version tlsv1.2");
            sb.AppendLine($"bridge_cafile {AgentPaths.CaCertFile}");
        }

        return sb.ToString();
    }
}
