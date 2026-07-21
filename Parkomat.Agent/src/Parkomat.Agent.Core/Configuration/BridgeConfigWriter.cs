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
    /// ה-topic שאליו Mosquitto מפרסם את מצב הגשר **גם ל-HiveMQ**, כדי שהשרת
    /// יידע שהאתר נותק. הפורמט: sites/{code}/bridge, עם "1"/"0".
    /// </summary>
    public static string RemoteBridgeStateTopic(string siteCode) => $"sites/{siteCode}/bridge";

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

    // בונה את הטקסט של קובץ הגישור. public כדי שניתן יהיה לבדוק את התוכן בלי לגעת בדיסק.
    public static string Build(SiteConfig config)
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
        // זהות ה-clientId ל-HiveMQ מבוססת-אתר (bridge-{code}), *לא* לפי שם-המחשב.
        // בלי remote_clientid, Mosquitto נופל ל-clientId שנגזר מ-hostname — ושני
        // מחשבי-אתר שנוצרו מאותו image (אותו hostname) מציגים ל-HiveMQ אותו clientId,
        // מפילים זה את זה בלולאה (MQTT מחייב clientId ייחודי), ושני אתרים לא-קשורים
        // מהבהבים no_comm. local_clientid נותן זהות ייחודית גם מול הברוקר המקומי.
        sb.AppendLine($"remote_clientid bridge-{siteCode}");
        sb.AppendLine($"local_clientid bridge-{siteCode}");
        sb.AppendLine($"address {mqtt.Host}:{mqtt.Port}");
        // מעביר רק את הודעות האתר הזה, לפי קוד האתר.
        sb.AppendLine($"topic sites/{siteCode}/# out 1");
        sb.AppendLine("max_queued_messages 0");
        sb.AppendLine("try_private false");

        // ==========================================================
        // זיהוי ניתוק — שתי שכבות, ולא אחת
        // ==========================================================
        // ל-Agent יש LWT מול Mosquitto המקומי, והוא מכסה מקרה אחד: תהליך
        // הסוכן נופל בזמן שהמחשב חי. Mosquitto רואה את הניתוק, מפרסם
        // no_comm, והגשר מעביר אותו ל-HiveMQ. עובד.
        //
        // אבל **כשהחשמל נופל באתר, Mosquitto מת יחד עם הסוכן** — ואין מי
        // שיפרסם את ה-LWT. קודם הגדרנו notifications_local_only true, כלומר
        // הודעת מצב הגשר נשארה *מקומית* — על מחשב שכבוי. ל-HiveMQ לא הגיע
        // דבר, והשרת המשיך להציג את האתר כ"מוכן" לנצח.
        //
        // זה בדיוק הכשל שהכי חשוב לתפוס בחניון, והוא היחיד שלא נתפס.
        //
        // התיקון: מפרסמים את מצב הגשר **גם ל-HiveMQ**. Mosquitto רושם על
        // חיבור הגשר will מול הברוקר המרוחק, ולכן כשהגשר מת בפתאומיות
        // (נפילת חשמל, ניתוק רשת) — **HiveMQ עצמו** מפרסם "0" ל-topic הזה,
        // אחרי 1.5 × keepalive. עם keepalive של 60 שניות זה 90 שניות בדיוק.
        //
        // ההודעה היא "1"/"0" ולא JSON, ולכן היא הולכת ל-topic נפרד
        // (sites/{code}/bridge) ולא ל-sites/{code}/state — שם השרת מצפה
        // ל-JSON לפי החוזה. השרת מתרגם "0" ל-no_comm.
        sb.AppendLine("notifications true");
        sb.AppendLine("notifications_local_only false");
        sb.AppendLine($"notification_topic {RemoteBridgeStateTopic(siteCode)}");

        // keepalive מפורש ולא ברירת מחדל: הוא זה שקובע מתי HiveMQ מכריז על
        // הגשר כמת (1.5 × keepalive = 90 שניות). לא משאירים את זה למקרה.
        sb.AppendLine("keepalive_interval 60");

        sb.AppendLine("cleansession true");
        sb.AppendLine();

        // --- פרטי ההתחברות ל-HiveMQ (מתוך ההגדרות) ---
        sb.AppendLine($"remote_username {mqtt.Username}");
        sb.AppendLine($"remote_password {mqtt.Password}");
        sb.AppendLine();

        // ==========================================================
        // --- הצפנה — תמיד. אין מתג, ואין דרך לכבות. ---
        // ==========================================================
        // הגשר הזה מתחבר ל-HiveMQ דרך האינטרנט הפתוח, ומעביר את שם המשתמש
        // והסיסמה של האתר. בלי TLS הם עוברים בטקסט גלוי.
        //
        // קודם זה היה תלוי ב-checkbox בטופס ההגדרות. זו לא הייתה גמישות אלא
        // מלכודת: לחיצה אחת של טכנאי בשדה הורידה את ההצפנה של האתר כולו,
        // ושום דבר לא היה נכשל בקול — ההודעות פשוט היו זורמות לא מוצפנות.
        //
        // התעודה נמצאת במיקום קבוע ומבוקר (ProgramData, בלי רווחים בנתיב),
        // ולא ב-Program Files — כדי שלא ניפול על אי-התאמה של Program Files (x86).
        sb.AppendLine("bridge_tls_version tlsv1.2");
        sb.AppendLine($"bridge_cafile {AgentPaths.CaCertFile}");

        return sb.ToString();
    }
}
