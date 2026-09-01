using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הגשר חייב לצבור הודעות בזמן נתק אינטרנט.
///
/// ⚠️ הבדיקה הזו נולדה מבאג שהיה בייצור ב-16 אתרים, ואיש לא ידע עליו:
/// `bridge.conf` הגדיר `cleansession true`, ואז **כל הודעה שנוצרה באתר
/// בזמן נתק אינטרנט אבדה לתמיד**. לא התעכבה — אבדה.
///
/// נמדד בניסוי מבוקר (tools/cleansession-test.sh): שני ברוקרים מקומיים,
/// אותו קונפיג בדיוק, ניתוק יזום של היעד, חמש הודעות QoS 1:
///
///     cleansession true   →  0 מתוך 5
///     cleansession false  →  5 מתוך 5
///
/// ⚠️ **ולמה בדיקה מבנית ולא התנהגותית:** ההתנהגות תלויה בשני ברוקרים
/// חיים ובהמתנות של עשרות שניות — זו אינה בדיקת יחידה. מה שכן ניתן
/// לנעול כאן הוא שהערך אינו חוזר לאחור בשקט, וזה בדיוק מה שקרה: השורה
/// הייתה **היחידה בקובץ בלי נימוק**, ולכן היא נראתה כמו פרט טכני.
/// </summary>
public class BridgeQueueingTests
{
    [Fact]
    public void BridgeConfig_KeepsSessionSoMessagesSurviveAnOutage()
    {
        string conf = BridgeConfigWriter.Build(new SiteConfig
        {
            SiteId = "2438",
            Mqtt = new MqttConfig { Host = "broker.hivemq", Port = 8883, Username = "u", Password = "p" }
        });

        Assert.Contains("cleansession false", conf);

        // ⚠️ ובמפורש: `true` מוחק את המנוי של הגשר בכל ניתוק, ואז אין למי
        // לצבור. זו אינה העדפת סגנון — זו ההפרדה בין "ההודעות מחכות"
        // לבין "ההודעות אינן קיימות".
        Assert.DoesNotContain("cleansession true", conf);
    }

    [Fact]
    public void BridgeConfig_QueueIsUnbounded()
    {
        string conf = BridgeConfigWriter.Build(new SiteConfig
        {
            SiteId = "2438",
            Mqtt = new MqttConfig()
        });

        // ⚠️ 0 = ללא הגבלה. שמירת הסשן בלי תור להכניס אליו הייתה חצי תיקון:
        // נתק ארוך היה מתמלא ומתחיל לזרוק, וזה נראה בדיוק כמו הבאג המקורי.
        // הנפחים כאן זעירים (עשרות הודעות ביום לאתר), ולכן אין סיבה לתקרה.
        Assert.Contains("max_queued_messages 0", conf);
    }

    [Fact]
    public void BridgeConfig_StillDetectsDisconnect()
    {
        string conf = BridgeConfigWriter.Build(new SiteConfig
        {
            SiteId = "2438",
            Mqtt = new MqttConfig()
        });

        // ⚠️ שמירת הסשן אסור שתפגע בזיהוי הניתוק — זו השכבה שתופסת נפילת
        // חשמל באתר, והיחידה שתופסת אותה. הצירוף הזה (סשן נשמר + הודעת
        // מצב הגשר מגיעה ל-HiveMQ) הוא מה שנדרש, ולא אחד מהם.
        Assert.Contains("notifications true", conf);
        Assert.Contains("notifications_local_only false", conf);
        Assert.Contains("keepalive_interval 60", conf);
    }
}
