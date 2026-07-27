using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// איפוס-לברירות-מחדל שהמתקין מפעיל בכל התקנה.
///
/// ==========================================================
/// למה זה הקוד שגרם לסיסמה כמעט להיכנס למאגר ציבורי
/// ==========================================================
/// המתקין מניח דגל איפוס בכל התקנה, וה-ConfigStore בעלייה כותב config טרי.
/// עד כה שרד רק ה-SiteId — כלומר **כל שדרוג גרסה מחק את סיסמת ה-HiveMQ של
/// האתר**. הגשר הפסיק להתחבר, האתר הפסיק לדווח, וטכנאי היה צריך להקליד את
/// הסיסמה מחדש בשטח אחרי כל עדכון.
///
/// הלחץ הזה הוליד ניסיון להדביק את הסיסמה לתוך SiteConfig.cs. התיקון הנכון
/// הוא להכיר בכך שפרטי ההזדהות הם **זהות האתר** ולא העדפה: בדיוק כמו
/// SiteId, אי אפשר לגזור אותם מחדש, ולכן הם שורדים איפוס.
///
/// BuildResetConfig היא טהורה בדיוק כדי שכל זה ייבדק בלי לגעת ב-ProgramData.
/// </summary>
public class ConfigResetTests
{
    /// <summary>ברירת המחדל המהודרת — ריקה ב-clone טרי, הערך הצרוב על מכונת build.</summary>
    private static string CompiledDefaultPassword => new SiteConfig().Mqtt.Password;
    private static string CompiledDefaultUsername => new SiteConfig().Mqtt.Username;

    // ===== מה ששורד =====

    [Fact]
    public void Reset_PreservesSiteId()
    {
        // רגרסיה על ההתנהגות שכבר הייתה: בלי SiteId הנתיב הוא sites//state,
        // שהשרת דוחה, וה-remote_clientid ריק ומתנגש בין אתרים.
        var old = new SiteConfig { SiteId = "3513" };

        SiteConfig fresh = ConfigStore.BuildResetConfig(old);

        Assert.Equal("3513", fresh.SiteId);
    }

    [Fact]
    public void Reset_PreservesMqttCredentials()
    {
        // הלב של התיקון.
        var old = new SiteConfig { SiteId = "3513" };
        old.Mqtt.Username = "site-3513";
        old.Mqtt.Password = "s3cret-from-the-field";

        SiteConfig fresh = ConfigStore.BuildResetConfig(old);

        Assert.Equal("site-3513", fresh.Mqtt.Username);
        Assert.Equal("s3cret-from-the-field", fresh.Mqtt.Password);
    }

    [Fact]
    public void Upgrade_DoesNotLoseAConfiguredSitesPassword()
    {
        // התרחיש המלא כפי שהוא קורה בשטח: אתר שהוגדר ידנית פעם אחת, ואז
        // שדרוג גרסה. אחרי האיפוס הוא חייב להיות מסוגל להתחבר בלי טכנאי.
        var configuredInTheField = new SiteConfig { SiteId = "2438" };
        configuredInTheField.Mqtt.Username = "site-2438";
        configuredInTheField.Mqtt.Password = "pw-typed-by-technician";
        configuredInTheField.Plc.IpAddress = "10.0.0.99";     // סחף הגדרות
        configuredInTheField.PollIntervalMs = 7777;

        SiteConfig afterUpgrade = ConfigStore.BuildResetConfig(configuredInTheField);

        // זהות — שורדת.
        Assert.Equal("2438", afterUpgrade.SiteId);
        Assert.Equal("site-2438", afterUpgrade.Mqtt.Username);
        Assert.Equal("pw-typed-by-technician", afterUpgrade.Mqtt.Password);

        // סחף — נוקה, וזו כל מטרת האיפוס.
        Assert.Equal(new SiteConfig().Plc.IpAddress, afterUpgrade.Plc.IpAddress);
        Assert.Equal(new SiteConfig().PollIntervalMs, afterUpgrade.PollIntervalMs);
    }

    // ===== מה שלא שורד — וזו הכוונה =====

    [Fact]
    public void Reset_ClearsEverythingThatCanBeDerivedAgain()
    {
        var old = new SiteConfig
        {
            SiteId = "1234",
            SiteName = "שם ישן",
            PollIntervalMs = 55,
            NtpServer = "ntp.old.example",
            NtpSyncIntervalMinutes = 999,
        };
        old.Plc.IpAddress = "1.2.3.4";
        old.Plc.Port = 9999;
        old.Plc.ModeRegister = 1;
        old.Mqtt.Host = "old.broker.example";
        old.Mqtt.Port = 1234;

        SiteConfig fresh = ConfigStore.BuildResetConfig(old);
        var defaults = new SiteConfig();

        Assert.Equal(defaults.SiteName, fresh.SiteName);
        Assert.Equal(defaults.PollIntervalMs, fresh.PollIntervalMs);
        Assert.Equal(defaults.NtpServer, fresh.NtpServer);
        Assert.Equal(defaults.NtpSyncIntervalMinutes, fresh.NtpSyncIntervalMinutes);
        Assert.Equal(defaults.Plc.IpAddress, fresh.Plc.IpAddress);
        Assert.Equal(defaults.Plc.Port, fresh.Plc.Port);
        Assert.Equal(defaults.Plc.ModeRegister, fresh.Plc.ModeRegister);

        // גם ה-Host והפורט של HiveMQ מתאפסים — הם ברירת מחדל, לא זהות.
        Assert.Equal(defaults.Mqtt.Host, fresh.Mqtt.Host);
        Assert.Equal(defaults.Mqtt.Port, fresh.Mqtt.Port);
    }

    // ===== מקרי קצה =====

    [Fact]
    public void Reset_WithNoPreviousConfig_IsAllDefaults()
    {
        // התקנה על מכונה נקייה, או config.json פגום שלא ניתן לפענוח.
        SiteConfig fresh = ConfigStore.BuildResetConfig(null);
        var defaults = new SiteConfig();

        Assert.Equal("", fresh.SiteId);
        Assert.Equal(defaults.Mqtt.Username, fresh.Mqtt.Username);
        Assert.Equal(defaults.Mqtt.Password, fresh.Mqtt.Password);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Reset_EmptyPreviousPassword_FallsBackToTheCompiledDefault(string? previous)
    {
        // קריטי לכיוון השני: מכונה שמעולם לא הוגדרה חייבת לקבל את הערך
        // שנצרב ב-build. אם ערך ריק היה "שורד", ההתקנה הטרייה הייתה ננעלת
        // על סיסמה ריקה — בדיוק הבאג שרצינו למנוע, רק הפוך.
        var old = new SiteConfig { SiteId = "1" };
        old.Mqtt.Password = previous!;
        old.Mqtt.Username = previous!;

        SiteConfig fresh = ConfigStore.BuildResetConfig(old);

        Assert.Equal(CompiledDefaultPassword, fresh.Mqtt.Password);
        Assert.Equal(CompiledDefaultUsername, fresh.Mqtt.Username);
    }

    [Fact]
    public void Reset_DoesNotMutateTheOldConfig()
    {
        // BuildResetConfig טהורה: הקורא עדיין מחזיק את הישן ללא שינוי.
        var old = new SiteConfig { SiteId = "9" };
        old.Mqtt.Password = "keep-me";
        old.Plc.IpAddress = "10.10.10.10";

        ConfigStore.BuildResetConfig(old);

        Assert.Equal("9", old.SiteId);
        Assert.Equal("keep-me", old.Mqtt.Password);
        Assert.Equal("10.10.10.10", old.Plc.IpAddress);
    }

    [Fact]
    public void Reset_ReturnsAnIndependentObject()
    {
        // שינוי בתוצאה לא נוגע במקור (Mqtt הוא אובייקט מקונן — קל לשתף בטעות).
        var old = new SiteConfig { SiteId = "9" };
        old.Mqtt.Password = "original";

        SiteConfig fresh = ConfigStore.BuildResetConfig(old);
        fresh.Mqtt.Password = "changed";

        Assert.Equal("original", old.Mqtt.Password);
        Assert.NotSame(old.Mqtt, fresh.Mqtt);
    }

    // ===== החוזה מול ה-build =====

    [Fact]
    public void CompiledDefaultPassword_IsNeverNull()
    {
        // בין אם agent-defaults.password קיים ובין אם לא, השדה חייב להיות
        // מחרוזת — קוד הגשר כותב אותו ל-bridge.conf בלי בדיקת null.
        Assert.NotNull(CompiledDefaultPassword);
    }
}
