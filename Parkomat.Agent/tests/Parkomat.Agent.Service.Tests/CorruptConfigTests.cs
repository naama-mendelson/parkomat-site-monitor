using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// <c>config.json</c> קיים אבל אינו ניתן לפענוח — <b>ואסור לדרוס אותו</b>.
///
/// <para>⚠️ <b>מה שהיה.</b> האיפוס בעלייה קרא את הקובץ, ופענוח שנכשל נבלע
/// ל-<c>old = null</c> — כלומר "אין הגדרות קודמות". ואז
/// <c>Save(BuildResetConfig(null))</c> כתב ברירות מחדל <b>מעליו</b>: מזהה
/// האתר, סיסמת HiveMQ, <b>וסיסמת Supabase</b> — שמוצגת פעם אחת בהנפקה
/// ואין מאיפה להעתיק אותה. קובץ פגום ניתן לתקן ביד; קובץ שנדרס — לא.</para>
///
/// <para>⚠️ <b>וקובץ פגום אינו תרחיש דמיוני:</b> נפילת חשמל אחרי ה-Move
/// ולפני שהבייטים נשטפו לדיסק משאירה בדיוק שם קובץ תקין עם תוכן ריק. זה
/// המחשב שהפרויקט הזה קיים בגללו (DELL008).</para>
///
/// <para>כל הבדיקות רצות בתיקייה זמנית, דרך התפר <c>ApplyResetMarker(configPath,
/// flagPath)</c> / <c>Save(config, path)</c>. אף אחת אינה נוגעת ב-ProgramData.</para>
/// </summary>
public sealed class CorruptConfigTests : IDisposable
{
    private readonly string _dir;
    private readonly string _config;
    private readonly string _flag;

    public CorruptConfigTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "pk-cfg-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _config = Path.Combine(_dir, "config.json");
        _flag = Path.Combine(_dir, "reset-to-defaults.flag");
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    // קובץ שנקטע באמצע: ה-JSON נפתח, הסיסמאות בפנים, והסוגר לא הגיע.
    private const string Truncated =
        "{\n  \"SiteId\": \"2438\",\n  \"Supabase\": { \"Password\": \"issued-once\" ";

    private string[] CorruptCopies() => Directory.GetFiles(_dir, "config.json.corrupt-*");

    // ============================================================
    // ⚠️ הבאג עצמו: ההתקנה דורסת קובץ שאינה מבינה
    // ============================================================
    [Fact]
    public void TheInstallResetNeverOverwritesAConfigItCannotParse()
    {
        File.WriteAllText(_config, Truncated);
        File.WriteAllText(_flag, "");

        ConfigStore.ApplyResetMarker(_config, _flag);

        Assert.Equal(Truncated, File.ReadAllText(_config));
    }

    // ⚠️ ועותק נשמר לצדו. הקובץ עצמו נשאר במקום לאדם שיתקן — אבל מי שיפתח
    // את טופס ההגדרות וילחץ "שמור" ידרוס אותו, ולכן העותק קיים **לפני** כן.
    [Fact]
    public void AndACopyOfItIsPreserved()
    {
        File.WriteAllText(_config, Truncated);
        File.WriteAllText(_flag, "");

        ConfigStore.ApplyResetMarker(_config, _flag);

        string[] copies = CorruptCopies();
        Assert.Single(copies);
        Assert.Equal(Truncated, File.ReadAllText(copies[0]));
    }

    // ⚠️ קובץ ריק לגמרי — הצורה הסבירה ביותר אחרי נפילת חשמל בלי Flush.
    [Fact]
    public void AnEmptyFileIsTreatedAsUnparseableToo()
    {
        File.WriteAllText(_config, "");
        File.WriteAllText(_flag, "");

        ConfigStore.ApplyResetMarker(_config, _flag);

        Assert.Equal("", File.ReadAllText(_config));
        Assert.Single(CorruptCopies());
    }

    // ============================================================
    // ⚠️ קריאה שנכשלה אינה פענוח שנכשל
    // ============================================================
    // אנטי-וירוס שמחזיק את הקובץ ברגע העלייה אינו אומר שהקובץ פגום. אסור
    // לאפס, ו**הדגל נשאר** — ההתקנה ביקשה איפוס, והוא יקרה בעלייה הבאה
    // כשהקובץ נגיש. מחיקת הדגל כאן הייתה מבטלת את האיפוס בשקט.
    [Fact]
    public void AConfigThatCannotBeReadRightNowIsNeitherResetNorCopied()
    {
        File.WriteAllText(_config, ConfigStore.ToJson(new SiteConfig { SiteId = "2438" }));
        File.WriteAllText(_flag, "");
        string before = File.ReadAllText(_config);

        using (new FileStream(_config, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            ConfigStore.ApplyResetMarker(_config, _flag);
        }

        Assert.Equal(before, File.ReadAllText(_config));
        Assert.True(File.Exists(_flag), "הדגל נצרך בלי שהאיפוס קרה — ההתקנה איבדה את בקשתה");
        Assert.Empty(CorruptCopies());
    }

    // ⚠️ והמסלול הרגיל לא נשבר: קובץ תקין מאופס ושומר את זהות האתר.
    [Fact]
    public void AReadableConfigIsStillResetAndKeepsItsIdentity()
    {
        var old = new SiteConfig { SiteId = "2438", PollIntervalMs = 7777 };
        old.Supabase.Password = "issued-once";
        File.WriteAllText(_config, ConfigStore.ToJson(old));
        File.WriteAllText(_flag, "");

        ConfigStore.ApplyResetMarker(_config, _flag);

        SiteConfig after = ConfigStore.FromJson(File.ReadAllText(_config))!;
        Assert.Equal("2438", after.SiteId);
        Assert.Equal("issued-once", after.Supabase.Password);
        Assert.Equal(new SiteConfig().PollIntervalMs, after.PollIntervalMs);
        Assert.False(File.Exists(_flag));
        Assert.Empty(CorruptCopies());
    }

    // ============================================================
    // ⚠️ טופס ההגדרות — אותה דריסה, מדלת אחרת
    // ============================================================
    // `Load` מחזירה ברירות מחדל על קובץ שאינו ניתן לפענוח, הטופס מציג אותן,
    // והטכנאי מקליד מזהה אתר ולוחץ "שמור". ‏`Save` הייתה דורסת את המקור בלי
    // שנשאר ממנו דבר. השמירה עצמה לגיטימית — אדם ביקש אותה — אבל לא בלי עותק.
    [Fact]
    public void SavingOverAnUnparseableFileKeepsACopyFirst()
    {
        File.WriteAllText(_config, Truncated);

        ConfigStore.Save(new SiteConfig { SiteId = "2438" }, _config);

        string[] copies = CorruptCopies();
        Assert.Single(copies);
        Assert.Equal(Truncated, File.ReadAllText(copies[0]));
        Assert.Equal("2438", ConfigStore.FromJson(File.ReadAllText(_config))!.SiteId);
    }

    // ⚠️ ושמירה רגילה אינה מייצרת עותקים — אחרת כל "שמור" היה מלכלך את
    // התיקייה, ועותק "פגום" שאינו פגום מבלבל את מי שמאבחן.
    [Fact]
    public void SavingOverAValidFileMakesNoCopy()
    {
        File.WriteAllText(_config, ConfigStore.ToJson(new SiteConfig { SiteId = "1" }));

        ConfigStore.Save(new SiteConfig { SiteId = "2" }, _config);

        Assert.Empty(CorruptCopies());
    }

    // ⚠️ וסוכן שעולה שוב ושוב על אותו קובץ פגום אינו צובר עותקים זהים.
    [Fact]
    public void TheSameCorruptContentIsCopiedOnce()
    {
        File.WriteAllText(_config, Truncated);

        for (int i = 0; i < 3; i++)
        {
            File.WriteAllText(_flag, "");
            ConfigStore.ApplyResetMarker(_config, _flag);
        }

        Assert.Single(CorruptCopies());
    }

    // ============================================================
    // ⚠️ ובלוג: "לא דרסתי" חייב להיאמר, ולא להסתתר מאחורי SITE ID INVALID
    // ============================================================
    // אחרי שהקובץ נשמר, ‏`Load` מחזירה ברירות מחדל והסוכן נעצר על "מזהה
    // אתר לא תקין" — הודעה שמפנה לטופס, כלומר לתיקון שמוחק את הראיה.
    // ⚠️ מבנית, כי ה-Worker קורא מ-ProgramData.
    [Fact]
    public void TheWorkerSaysCriticallyThatTheConfigWasLeftUntouched()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        string w = File.ReadAllText(Path.Combine(dir!.FullName, "src", "Parkomat.Agent.Service", "Worker.cs"));

        int load = w.IndexOf("ConfigStore.LoadAtStartup()", StringComparison.Ordinal);
        int idCheck = w.IndexOf("SiteIdRule.Check(", StringComparison.Ordinal);
        Assert.True(load > 0 && idCheck > load, "לא נמצאו העוגנים של העלייה");

        // לפני בדיקת המזהה — אחרת הלולאה שלה חוסמת את השורה לנצח.
        string between = w[load..idCheck];
        Assert.Contains("ConfigStore.PreserveIfUnreadable(AgentPaths.ConfigFile)", between);
        Assert.Contains("LogCritical", between);
    }
}
