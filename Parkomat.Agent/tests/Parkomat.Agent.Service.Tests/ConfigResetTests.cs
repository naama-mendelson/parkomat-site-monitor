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

    // ===== Supabase שורד שדרוג =====

    [Fact]
    public void Upgrade_KeepsTheSitesSupabasePassword()
    {
        // ============================================================
        // ⚠️ באג אמיתי שנתפס רגע לפני התקנה בשטח, ולא חשש תיאורטי
        // ============================================================
        // רק SiteId ופרטי MQTT שרדו איפוס. אתר 2438 — היחיד שרץ על המסלול
        // הישיר — היה מאבד את סיסמת Supabase בשדרוג הבא.
        //
        // ⚠️ **והכיבוי היה שקט לחלוטין.** `Enabled` נגזר מהסיסמה, כך שסיסמה
        // שנמחקה אינה שגיאה ואינה שורת לוג: היא נראית זהה ל"האתר הזה לא
        // הופעל". האתר ממשיך לדווח ב-MQTT ונראה תקין, וההיעלמות מתגלה רק
        // ביום שמכבים את MQTT — כלומר בדיוק כשאין דרך חזרה.
        //
        // וההחזרה אינה הקלדה מחדש: Supabase שומר גיבוב בלבד, אז הסיסמה
        // המקורית אינה קיימת בשום מקום וצריך להנפיק חדשה.
        var inTheField = new SiteConfig();
        inTheField.SiteId = "2438";
        inTheField.Supabase.Password = "issued-once-never-shown-again";

        var afterUpgrade = ConfigStore.BuildResetConfig(inTheField);

        Assert.Equal("issued-once-never-shown-again", afterUpgrade.Supabase.Password);
        Assert.True(afterUpgrade.Supabase.Enabled,
            "המסלול הישיר כבוי אחרי שדרוג — האתר יפסיק לכתוב ישירות בלי שום סימן");
    }

    [Fact]
    public void Upgrade_KeepsTheExitDoorOverrides()
    {
        // ⚠️ שלוש העקיפות אינן סודות — הן דלת היציאה. אתר שהופנה ל-Postgres
        // אחר היה חוזר ל-Supabase בהתקנה הבאה, בלי שאיש ביקש ובלי שדבר
        // יצביע על כך. המבחן הוא "האם אפשר לגזור מחדש", לא "האם זה סוד".
        var repointed = new SiteConfig();
        repointed.SiteId = "2438";
        repointed.Supabase.Password = "pw";
        repointed.Supabase.Url = "https://postgrest.parkomat.internal";
        repointed.Supabase.AnonKey = "self-hosted-key";
        repointed.Supabase.Email = "agent-2438@parkomat.internal";

        var after = ConfigStore.BuildResetConfig(repointed);

        Assert.Equal("https://postgrest.parkomat.internal", after.Supabase.Url);
        Assert.Equal("self-hosted-key", after.Supabase.AnonKey);
        Assert.Equal("agent-2438@parkomat.internal", after.Supabase.Email);
    }

    [Fact]
    public void Upgrade_SurvivesTheRoundTripToDiskAndBack()
    {
        // ============================================================
        // ⚠️ הפער שהיה בין הבדיקה לבין מה שקורה באתר
        // ============================================================
        // `BuildResetConfig` טהורה, ולכן קלה לבדיקה — אבל מה שמגיע לאתר עובר
        // אחריה `Save` ואז `Load`. שתיהן נוגעות ב-C:\ProgramData, שאסור
        // לבדיקה לכתוב אליו, ולכן ההמרה עצמה לא נבדקה מעולם.
        //
        // ⚠️ **ושדה שנעלם בהמרה נראה בדיוק כמו שדה ששרד**: הבדיקה על
        // הפונקציה הטהורה עוברת, ה-config שנכתב לדיסק חסר את הסיסמה, והאתר
        // מפסיק לכתוב ישירות בלי שום שגיאה. `[JsonIgnore]` על השדה הלא נכון,
        // ‎setter שנשמט, שינוי שם — כל אחד מהם עושה זאת.
        //
        // ToJson/FromJson הן אותן Options בדיוק ששני המסלולים משתמשים בהן.
        var inTheField = new SiteConfig();
        inTheField.SiteId = "2438";
        inTheField.Mqtt.Password = "hivemq-pw";
        inTheField.Supabase.Password = "issued-once-never-shown-again";
        inTheField.Supabase.Url = "https://postgrest.parkomat.internal";

        var afterReset = ConfigStore.BuildResetConfig(inTheField);
        var onDisk = ConfigStore.FromJson(ConfigStore.ToJson(afterReset));

        Assert.NotNull(onDisk);
        Assert.Equal("2438", onDisk!.SiteId);
        Assert.Equal("hivemq-pw", onDisk.Mqtt.Password);
        Assert.Equal("issued-once-never-shown-again", onDisk.Supabase.Password);
        Assert.Equal("https://postgrest.parkomat.internal", onDisk.Supabase.Url);

        // ⚠️ ו-SiteId ב-Supabase מסומן [JsonIgnore] בכוונה — הוא מוטבע מחדש
        // ב-Load ולא נשמר. לכן `Enabled` נבדק **אחרי** ההטבעה, שזה בדיוק מה
        // ש-Load עושה בשורה האחרונה שלו.
        onDisk.Supabase.SiteId = onDisk.SiteId;
        Assert.True(onDisk.Supabase.Enabled,
            "אחרי מעבר לדיסק ובחזרה המסלול הישיר כבוי — האתר יפסיק לכתוב בלי סימן");
    }

    [Fact]
    public void OnlyTheStartupDoorConsumesTheResetFlag()
    {
        // ============================================================
        // ⚠️ קריאה שהיא גם כתיבה — ומארבעה מקומות
        // ============================================================
        // האיפוס ישב בתוך `Load`, ולכן **כל** קריאה של ההגדרות יכלה לשכתב
        // אותן. `Load` נקראת מה-Worker, מטופס ההגדרות, מ-StatusForm,
        // ומ-`ServiceManager` — שקורא אותה **בכל בדיקת שומר**, כלומר כמה
        // פעמים בדקה, רק כדי לדעת את קצב הדגימה.
        //
        // ⚠️ ובזמן התקנה זה חמור במיוחד: תהליך של הגרסה **הקודמת** שעדיין
        // רץ יכול לצרוך את הדגל בקוד הישן שלו — כלומר האיפוס מתבצע לפי
        // הכללים של גרסה שכבר הוחלפה, ומוחק שדות שהגרסה החדשה שומרת.
        //
        // האיפוס הוא אירוע בעלייה, ולכן הוא שייך למי שעולה — ורק לו.
        string core = Source("Parkomat.Agent.Core", "Configuration", "ConfigStore.cs");

        // `Load` הרגילה אינה נוגעת בדגל
        int plainLoad = core.IndexOf("public static SiteConfig Load()", StringComparison.Ordinal);
        Assert.True(plainLoad > 0, "לא נמצאה Load");
        int endOfLoad = core.IndexOf("private static void ApplyResetMarkerIfPresent",
                                     plainLoad, StringComparison.Ordinal);
        Assert.True(endOfLoad > plainLoad);
        Assert.DoesNotContain("ApplyResetMarkerIfPresent()", core[plainLoad..endOfLoad]);

        // ורק ה-Worker עובר דרך הדלת שכן צורכת אותו
        string worker = Source("Parkomat.Agent.Service", "Worker.cs");
        Assert.Contains("ConfigStore.LoadAtStartup()", worker);

        static string Source(params string[] parts)
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
                dir = dir.Parent;
            Assert.NotNull(dir);
            return File.ReadAllText(Path.Combine([dir!.FullName, "src", .. parts]));
        }
    }

    [Fact]
    public void TheResetFlagIsConsumedBeforeTheWriteNotAfter()
    {
        // ============================================================
        // ⚠️ דגל שלא נמחק הופך "איפוס בהתקנה" ל"איפוס בכל טעינה"
        // ============================================================
        // הסדר היה: לכתוב את ה-config המאופס, ואז למחוק את הדגל — והכול
        // בתוך catch בולע. אם המחיקה נכשלה, או אם Save זרק, הדגל שרד.
        //
        // ⚠️ ו-`Load` נקראת מארבעה מקומות, ובהם `ServiceManager` שקורא
        // אותה שוב ושוב רק כדי לקרוא את קצב הדגימה. כלומר הדגל השורד אינו
        // "איפוס אחד נוסף" אלא **מחיקה חוזרת**: הטכנאי מקליד סיסמה, לוחץ
        // שמור, והיא נעלמת שניות אחר כך. הטופס נפתח ריק, וזה נראה בדיוק
        // כאילו כפתור השמירה שבור — כלומר האבחון נשלח לכיוון הלא נכון.
        //
        // ⚠️ **בדיקה מבנית ולא התנהגותית, ובכוונה.** המסלול האמיתי נוגע
        // ב-C:\ProgramData, שאסור לבדיקה לכתוב אליו. אותו שיקול כמו
        // `TheObserverRunsEvenWhenTheBrokerIsDown`: מוכיחים את הסדר.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string src = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Core", "Configuration", "ConfigStore.cs"));

        int marker = src.IndexOf("ApplyResetMarkerIfPresent()\n", StringComparison.Ordinal);
        if (marker < 0) marker = src.IndexOf("private static void ApplyResetMarkerIfPresent",
                                             StringComparison.Ordinal);
        Assert.True(marker > 0, "לא נמצאה ApplyResetMarkerIfPresent");

        string body = src[marker..];
        int delete = body.IndexOf("File.Delete(AgentPaths.ResetToDefaultsFlag)",
                                  StringComparison.Ordinal);
        int save = body.IndexOf("Save(BuildResetConfig(old))", StringComparison.Ordinal);

        Assert.True(delete > 0 && save > 0, "לא נמצאו שני העוגנים");
        Assert.True(delete < save,
            "הדגל נמחק אחרי הכתיבה — מחיקה שנכשלת תאפס את ה-config בכל טעינה");

        // ⚠️ וכשל במחיקה חייב **לצאת**, לא להמשיך לאפס. בלי היציאה הסדר
        // החדש לא קונה דבר: הדגל נשאר והאיפוס קורה בכל זאת.
        string between = body[delete..save];
        Assert.Contains("return;", between);
    }

    [Fact]
    public void Upgrade_OnAMachineThatWasNeverConfigured_StaysOff()
    {
        // ⚠️ הצד השני, ולא פחות חשוב: שדה ריק **אינו** שורד — הוא נופל
        // לברירת המחדל. אחרת התקנה על מחשב חדש הייתה גוררת ערכי-רפאים,
        // ו-`Enabled` היה יכול להידלק באתר שאיש לא הפעיל.
        var never = new SiteConfig();
        never.SiteId = "1358";

        var after = ConfigStore.BuildResetConfig(never);

        Assert.False(after.Supabase.Enabled,
            "המסלול הישיר נדלק באתר שמעולם לא הוגדר");
        Assert.True(string.IsNullOrWhiteSpace(after.Supabase.Password));
    }
}
