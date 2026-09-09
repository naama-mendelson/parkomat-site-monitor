using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>שדרוג מהגרסה שבאמת מותקנת באתרים — מ-JSON, לא מאובייקט.</b>
///
/// <para>כל בדיקות האיפוס האחרות בונות <c>SiteConfig</c> בזיכרון, ושם כל
/// מאפיין קיים תמיד עם ערך. זה <b>לא</b> מה שיושב באתר: קובץ שנכתב ע"י
/// 1.0.20 <b>חסר לגמרי</b> את <c>Supabase</c>, את <c>Mqtt.Disabled</c>
/// ואת <c>Plc.FunctionCode</c> — שדות שנולדו אחריו.</para>
///
/// <para>הצורה כאן הועתקה מקובץ אמיתי (<c>C:\ProgramData\Parkomat\Agent\
/// config.json</c>) של התקנת 1.0.20, בלי הערכים הסודיים. זה מסלול השדרוג
/// של 21 מכונות, והוא לא היה מכוסה באף בדיקה.</para>
///
/// <para>⚠️ <b>ולמה זה מסוכן דווקא כאן:</b> שדה חסר אינו שגיאה ואינו שורת
/// לוג — הוא מגיע כערך ברירת מחדל של הטיפוס. <c>FunctionCode</c> שמגיע
/// כ-0 אינו 3 ואינו 4, כלומר הסוכן היה שולח פקודת Modbus שאינה קיימת,
/// והכשל היה נראה **זהה** לכתובת IP שגויה: timeout, בלי שום רמז.</para>
/// </summary>
public class UpgradeFromTheFieldTests
{
    /// <summary>
    /// הצורה כפי שהיא בשדה. ⚠️ אין כאן <c>Supabase</c>, אין
    /// <c>Mqtt.Disabled</c> ואין <c>Plc.FunctionCode</c> — וזה כל העניין.
    /// </summary>
    private const string FieldJson = """
    {
      "SiteId": "2438",
      "SiteName": "מגדל 1",
      "Plc": {
        "IpAddress": "192.168.1.3",
        "Port": 502,
        "Transport": "tcp",
        "ModeRegister": 290,
        "CardRegister": 291,
        "CycleRegister": 292,
        "FaultTextRegister": 300,
        "FaultTextMaxChars": 40
      },
      "Mqtt": {
        "Host": "example.s1.eu.hivemq.cloud",
        "Port": 8883,
        "Username": "agent",
        "Password": "the-site-password"
      },
      "PollIntervalMs": 1000,
      "NtpServer": "time.windows.com",
      "NtpSyncIntervalMinutes": 60
    }
    """;

    private static SiteConfig Upgrade()
    {
        SiteConfig? fromDisk = ConfigStore.FromJson(FieldJson);
        Assert.NotNull(fromDisk);

        // ⚠️ ההתקנה מניחה דגל איפוס, והסוכן בעלייה מריץ בדיוק את זה.
        SiteConfig after = ConfigStore.BuildResetConfig(fromDisk);

        // ⚠️ ודרך הדיסק וחזרה — כי זה מה שקורה בפועל, ו-`ToJson`/`FromJson`
        // הן אותן Options בדיוק ששני המסלולים משתמשים בהן.
        SiteConfig? roundTripped = ConfigStore.FromJson(ConfigStore.ToJson(after));
        Assert.NotNull(roundTripped);
        return roundTripped!;
    }

    // ------------------------------------------------------------
    // מה שחייב לשרוד, אחרת האתר מפסיק לדווח
    // ------------------------------------------------------------
    [Fact]
    public void TheSiteKeepsItsIdentityAndCredentials()
    {
        SiteConfig after = Upgrade();

        Assert.Equal("2438", after.SiteId);
        Assert.Equal("agent", after.Mqtt.Username);
        Assert.Equal("the-site-password", after.Mqtt.Password);
    }

    // ============================================================
    // ⚠️ שדה שנולד אחרי הקובץ — הסכנה האמיתית בשדרוג
    // ============================================================
    // `FunctionCode` נעדר מה-JSON של 1.0.20. אם הוא מגיע כ-0, הסוכן שולח
    // פקודת Modbus שאינה 3 ואינה 4 — והכשל נראה זהה לכתובת שגויה.
    [Fact]
    public void AFieldThatDidNotExistYetComesBackAsAKnownValue()
    {
        SiteConfig after = Upgrade();

        Assert.True(after.Plc.FunctionCodeIsKnown,
            $"FunctionCode יצא {after.Plc.FunctionCode} — לא 3 ולא 4");
        Assert.Equal(4, after.Plc.FunctionCode);
    }

    [Fact]
    public void TheTransportIsKnownToo()
    {
        SiteConfig after = Upgrade();

        Assert.True(after.Plc.TransportIsKnown);
        Assert.Equal("tcp", after.Plc.Transport);
    }

    // ============================================================
    // ⚠️ ואתר UDP — כי "tcp" הוא גם ברירת המחדל, ולכן אינו מעיד
    // ============================================================
    // הבדיקה שמעל הייתה ירוקה **גם אם השימור נמחק לגמרי**: מוטציה
    // שהסירה את `fresh.Plc.Transport = old.Plc.Transport` עברה בשקט,
    // כי התוצאה הייתה "tcp" בין כה וכה. רק ערך שאינו ברירת המחדל מבדיל.
    //
    // וזה בדיוק הכשל שהתיעוד מזהיר ממנו: איפוס תמיד פוגע **דווקא**
    // באתרי ה-UDP, שבשבילם התכונה נבנתה, והכשל נראה כמו כתובת שגויה.
    [Fact]
    public void AUdpSiteKeepsItsTransportThroughTheUpgrade()
    {
        string udp = FieldJson.Replace("\"Transport\": \"tcp\"", "\"Transport\": \"udp\"");
        Assert.Contains("\"udp\"", udp);

        SiteConfig? fromDisk = ConfigStore.FromJson(udp);
        SiteConfig after = ConfigStore.BuildResetConfig(fromDisk!);
        SiteConfig? onDisk = ConfigStore.FromJson(ConfigStore.ToJson(after));

        Assert.Equal("udp", onDisk!.Plc.Transport);
        Assert.True(onDisk.Plc.UseUdp);
    }

    // ============================================================
    // ⚠️ ופקודת קריאה שרשומה **במפורש** כאפס
    // ============================================================
    // שדה חסר מגיע כ-4 (מאתחל המאפיין רץ רק כשהמאפיין נעדר), ולכן כל
    // הבדיקות שמעל היו ירוקות גם עם השומר `> 0` מוחלף ב-`>= 0`.
    // אפס **כתוב** הוא המקרה היחיד שבו השומר עושה משהו — וקובץ כזה נוצר
    // מעריכה ידנית או מגרסת ביניים. בלי השומר, הסוכן היה שולח פקודת
    // Modbus שאינה 3 ואינה 4, והכשל נראה זהה ל-timeout מכתובת שגויה.
    [Fact]
    public void AFunctionCodeWrittenAsZeroFallsBackToTheDefault()
    {
        string zero = FieldJson.Replace(
            "\"Transport\": \"tcp\"", "\"Transport\": \"tcp\",\n        \"FunctionCode\": 0");
        Assert.Contains("\"FunctionCode\": 0", zero);

        SiteConfig? fromDisk = ConfigStore.FromJson(zero);
        Assert.NotNull(fromDisk);
        Assert.Equal(0, fromDisk!.Plc.FunctionCode);   // ככה זה באמת מגיע מהדיסק

        SiteConfig after = ConfigStore.BuildResetConfig(fromDisk);
        Assert.Equal(4, after.Plc.FunctionCode);
        Assert.True(after.Plc.FunctionCodeIsKnown);
    }

    // ⚠️ סעיף שלם שנעדר מהקובץ אסור לו לחזור כ-null: כל קריאה אליו
    // הייתה מפילה את הסוכן בעלייה, על כל 21 המכונות בבת אחת.
    [Fact]
    public void AWholeSectionThatIsMissingDoesNotComeBackNull()
    {
        SiteConfig after = Upgrade();

        Assert.NotNull(after.Supabase);
        Assert.NotNull(after.Plc);
        Assert.NotNull(after.Mqtt);
    }

    // ⚠️ ובלי סיסמת Supabase המסלול הישיר חייב להישאר **כבוי**, ולא
    // "דלוק וחסר" — סוכן שמנסה כל מחזור, נכשל כל מחזור, וממלא את הלוג.
    [Fact]
    public void TheDirectPathStaysOffWhenTheFileNeverHadIt()
    {
        SiteConfig after = Upgrade();

        Assert.False(after.Supabase.Enabled);
        Assert.True(string.IsNullOrEmpty(after.Supabase.Password));
    }

    // ⚠️ ו-MQTT חייב להישאר **דלוק**. `MqttEnabled` נגזר, ואתר שאין לו
    // סיסמת Supabase נשאר על MQTT יהיה מה שיהיה בקובץ — אחרת השדרוג היה
    // מייצר אתר שאינו מדווח לשום מקום, המצב הגרוע ביותר במערכת.
    [Fact]
    public void MqttStaysOnAfterTheUpgrade()
    {
        SiteConfig after = Upgrade();

        Assert.True(after.MqttEnabled);
    }

    // ============================================================
    // ⚠️ הטבעת קוד האתר — ומה שהתברר עליה כשהשער הזה נכשל
    // ============================================================
    // הגרסה הראשונה של השער בדקה את ההטבעה **אחרי מסלול הדיסק**, ונכשלה.
    // הקוד היה נכון והשער היה שגוי: `SupabaseConfig.SiteId` מסומן
    // `[JsonIgnore]` בכוונה — הוא כבר יושב ב-`SiteConfig.SiteId`, ושמירתו
    // פעמיים היא שתי אמיתות שיום אחד ייפרדו. `ConfigStore.Load` מטביע
    // אותו בכל טעינה.
    [Fact]
    public void TheSiteCodeIsStampedBeforeItReachesTheDisk()
    {
        SiteConfig? fromDisk = ConfigStore.FromJson(FieldJson);
        Assert.NotNull(fromDisk);

        SiteConfig after = ConfigStore.BuildResetConfig(fromDisk!);
        Assert.Equal("2438", after.Supabase.SiteId);
    }

    // ⚠️ **ואינו נשמר לדיסק — במכוון.** אם יום אחד הוא כן יישמר, ייווצרו
    // שתי אמיתות לאותו ערך, וקובץ שנערך ביד יוכל להכיל אתר אחד בשדה אחד
    // ואתר אחר בשדה השני.
    [Fact]
    public void AndItIsDeliberatelyNotPersisted()
    {
        SiteConfig? fromDisk = ConfigStore.FromJson(FieldJson);
        SiteConfig after = ConfigStore.BuildResetConfig(fromDisk!);

        SiteConfig? roundTripped = ConfigStore.FromJson(ConfigStore.ToJson(after));
        Assert.NotNull(roundTripped);
        Assert.Equal("", roundTripped!.Supabase.SiteId);
    }

    // ============================================================
    // ⚠️ ולכן `Load` **חייב** להטביע אותו — וזה לא היה נבדק בשום מקום
    // ============================================================
    // שתי בדיקות קיימות מטביעות את הערך **בעצמן** לפני שהן בודקות
    // (`onDisk.Supabase.SiteId = onDisk.SiteId;`). כלומר הן מדמות את מה
    // ש-`Load` עושה במקום לוודא שהוא עושה זאת. אם השורה הזו תימחק מ-`Load`,
    // האימייל של **כל** אתר ייגזר ממחרוזת ריקה, `Enabled` יישאר false
    // לנצח, והמסלול הישיר פשוט לא יקרה — בלי שגיאה ובלי שורת לוג, על כל
    // המכונות בבת אחת. כל הבדיקות היו נשארות ירוקות.
    //
    // ⚠️ נבדק במבנה, כי `Load` נוגעת ב-`C:\ProgramData` והכלל בפרויקט הזה
    // הוא לא לכתוב לשם בבדיקות.
    [Fact]
    public void LoadIsTheOneThatStampsIt()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string src = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Core", "Configuration", "ConfigStore.cs"));

        // ⚠️ שורות הערה מוסרות: ההערה מעל השורה מסבירה בדיוק את המנגנון,
        // והייתה צובעת את השער ירוק בלי שהשורה קיימת.
        string code = string.Join("\n",
            src.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        int from = code.IndexOf("static SiteConfig Load(", StringComparison.Ordinal);
        Assert.True(from >= 0, "Load איננה");
        int to = code.IndexOf("ApplyResetMarkerIfPresent()", from, StringComparison.Ordinal);
        Assert.True(to > from, "לא נמצא סוף הגוף של Load");

        Assert.Contains("Supabase.SiteId =", code[from..to]);
    }
}
