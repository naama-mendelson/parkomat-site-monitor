using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// בדיקות לתיקוני-הקצה שהוכנסו לסוכן (הפונקציות הטהורות שניתן לבדוק בלי דיסק/MQTT):
///  - Fix 2: הידוק PollIntervalMs (מונע crash-loop משדה מספרי שלילי).
///  - Fix 4: זהות clientId מבוססת-אתר בגשר (מונע התנגשות בין מחשבים משוכפלים).
///  - Fix 5: חלון רעננות ה-heartbeat מותאם לקצב הדגימה (מונע סמל-אפור שווא).
/// </summary>
public class AgentFixesTests
{
    // ===== Fix 2: ClampPollIntervalMs =====

    [Theory]
    [InlineData(-5, 100)]      // שלילי — היה מקריס את Task.Delay ומחזיר crash-loop
    [InlineData(0, 100)]       // אפס — לולאה חמה
    [InlineData(50, 100)]      // מתחת לרצפה
    [InlineData(100, 100)]     // בדיוק הרצפה
    [InlineData(1000, 1000)]   // ברירת מחדל תקינה — לא משתנה
    [InlineData(60000, 60000)] // בדיוק התקרה
    [InlineData(999999, 60000)]// מעל התקרה
    public void ClampPollIntervalMs_ClampsToSaneRange(int input, int expected)
    {
        Assert.Equal(expected, ConfigStore.ClampPollIntervalMs(input));
    }

    // ===== Fix 4: bridge clientId מבוסס-אתר =====

    [Fact]
    public void BridgeConfig_SetsSiteKeyedClientId()
    {
        var cfg = new SiteConfig
        {
            SiteId = "ABC123",
            Mqtt = new MqttConfig { Host = "broker.hivemq", Port = 8883, Username = "u", Password = "p" }
        };

        string conf = BridgeConfigWriter.Build(cfg);

        // הזהות ל-HiveMQ ולברוקר המקומי — לפי קוד האתר, לא לפי שם-המחשב.
        Assert.Contains("remote_clientid bridge-ABC123", conf);
        Assert.Contains("local_clientid bridge-ABC123", conf);
    }

    [Fact]
    public void BridgeConfig_DifferentSites_GetDifferentClientIds()
    {
        string a = BridgeConfigWriter.Build(new SiteConfig { SiteId = "1001", Mqtt = new MqttConfig() });
        string b = BridgeConfigWriter.Build(new SiteConfig { SiteId = "1002", Mqtt = new MqttConfig() });

        Assert.Contains("remote_clientid bridge-1001", a);
        Assert.Contains("remote_clientid bridge-1002", b);
        Assert.DoesNotContain("bridge-1002", a); // אין דליפה בין אתרים
    }

    [Fact]
    public void BridgeConfig_StripsControlCharsFromCredentials()
    {
        // סיסמה/שם עם CR/LF (הדבקה עם שורה חדשה) היו שוברים את bridge.conf לשורה
        // נוספת ש-Mosquitto מפרש כהוראה שגויה → הגשר לא עולה. הסניטציה מסירה אותם.
        var cfg = new SiteConfig
        {
            SiteId = "1234",
            Mqtt = new MqttConfig { Host = "broker", Port = 8883, Username = "user", Password = "pass\r\nlistener 1", }
        };

        string conf = BridgeConfigWriter.Build(cfg);

        Assert.Contains("remote_password passlistener 1", conf);  // ה-CRLF הוסר, נשאר בשורה אחת
        Assert.DoesNotContain("\nlistener 1", conf);              // אין שורה מוזרקת
    }

    [Fact]
    public void BridgeConfig_PersistenceLocationPresent()
    {
        string conf = BridgeConfigWriter.Build(new SiteConfig { SiteId = "1234", Mqtt = new MqttConfig() });
        Assert.Contains("persistence_location ", conf);
        Assert.Contains("Parkomat", conf);
    }

    // ===== התקנה טרייה: SiteId ריק — אסור שייווצר גשר ל-HiveMQ =====
    //
    // מאז שיש שם-משתמש ברירת מחדל, התקנה טרייה הפיקה גשר "תקין למראה" עם
    // clientId `bridge-` (זהה בכל התקנה טרייה!) ונושא פגום `sites//state`, והוא
    // באמת התחבר ופרסם ל-HiveMQ. שתי התקנות טריות היו מפילות זו את זו בלולאה.
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void BridgeConfig_NoSiteId_DoesNotCreateBridge(string siteId)
    {
        var cfg = new SiteConfig
        {
            SiteId = siteId,
            Mqtt = new MqttConfig { Host = "broker.hivemq", Port = 8883, Username = "agent", Password = "secret" }
        };

        string conf = BridgeConfigWriter.Build(cfg);

        Assert.DoesNotContain("connection hivemq-bridge", conf);   // אין גשר בכלל
        Assert.DoesNotContain("remote_clientid", conf);            // אין clientId משותף
        Assert.DoesNotContain("sites//", conf);                    // אין נושא פגום
        Assert.DoesNotContain("secret", conf);                     // הסיסמה לא נכתבת לדיסק
        // קריטי: בלי remote_username השער ב-ServiceManager לא יפעיל את Mosquitto.
        Assert.DoesNotContain("remote_username", conf);
        // הברוקר המקומי כן מוגדר — כדי שברגע שיוזן קוד אתר הכול יעלה.
        Assert.Contains("listener 1883 localhost", conf);
    }

    [Fact]
    public void BridgeConfig_WithSiteId_CreatesBridge()
    {
        // רגרסיה: ברגע שיש קוד אתר, הגשר חוזר להיכתב במלואו.
        string conf = BridgeConfigWriter.Build(new SiteConfig
        {
            SiteId = "2439",
            Mqtt = new MqttConfig { Host = "broker.hivemq", Port = 8883, Username = "agent", Password = "p" }
        });

        Assert.Contains("connection hivemq-bridge", conf);
        Assert.Contains("remote_clientid bridge-2439", conf);
        Assert.Contains("topic sites/2439/# out 1", conf);
        Assert.Contains("remote_username agent", conf);
    }

    // ===== Fix 5: חלון רעננות ה-heartbeat =====

    [Theory]
    [InlineData(1000, 10)]   // 3×1s=3 → הרצפה 10 מנצחת
    [InlineData(3000, 10)]   // 3×3s=9  → עדיין הרצפה
    [InlineData(4000, 12)]   // 3×4s=12 → מעל הרצפה
    [InlineData(5000, 15)]   // 3×5s=15
    [InlineData(15000, 45)]  // דגימה איטית — החלון גדל איתה (היה שובר את הסמל)
    [InlineData(60000, 180)] // התקרה של קצב הדגימה
    [InlineData(100, 10)]    // דגימה מהירה מאוד — לא יורד מתחת ל-10
    public void FreshnessWindow_ScalesWithPollInterval(int pollMs, int expectedSeconds)
    {
        Assert.Equal(expectedSeconds, HeartbeatPolicy.FreshnessWindowSeconds(pollMs));
    }
}
