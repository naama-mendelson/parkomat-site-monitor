using System.Text.Json;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הכתיבה הישירה — החלקים שאפשר לבדוק בלי רשת.
///
/// ⚠️ <b>החוזה נבדק בשני צדדים.</b> כאן ביחידה, ובשרת ב-<c>check-agent-write</c>
/// שקורא ל-<c>public.ingest_batch</c> דרך הרשת עם אותה צורה. שדה שנקרא כאן
/// בשם אחר אינו נכשל — הוא מגיע כ-NULL וההודעה נכתבת חסרה. זה בדיוק הכשל
/// השקט שחוזה ה-MQTT כבר תיעד על <c>user</c> שחייב להיות <c>""</c>.
/// </summary>
public class SupabaseWriteTests
{
    // ===== ההגדרות =====

    [Fact]
    public void DisabledUntilEveryFieldIsFilled()
    {
        // ⚠️ **זו הבדיקה שמאפשרת לשגר את הגרסה ל-16 אתרים.** כל עוד היא
        // נכונה, התקנה חדשה אינה משנה שום התנהגות.
        Assert.False(new SupabaseConfig().Enabled);

        var partial = new SupabaseConfig { Url = "https://x.supabase.co", AnonKey = "k" };
        Assert.False(partial.Enabled);

        partial.Email = "site-1@parkomat.co.il";
        Assert.False(partial.Enabled);

        partial.Password = "p";
        Assert.True(partial.Enabled);
    }

    [Fact]
    public void WhitespaceIsNotAValue()
    {
        // ⚠️ שדה שמכיל רווח נראה מלא בטופס ההגדרות. בלי הבדיקה הזו הוא היה
        // מפעיל את המסלול, וכל סבב היה נכשל וממלא את הלוג.
        //
        // ⚠️ **וזו הסיסמה, לא הכתובת** — הכתובת אינה עוד שדה שמקלידים, ורווח
        // בעקיפה שלה פירושו "השתמש בברירת המחדל". הסיסמה היא המתג היחיד,
        // ולכן היא המקום היחיד שבו רווח חייב להיקרא כ"ריק".
        var cfg = new SupabaseConfig { SiteId = "2438", Password = "  " };
        Assert.False(cfg.Enabled);

        cfg.Password = "p";
        Assert.True(cfg.Enabled);
    }

    [Fact]
    public void SiteConfigDefaultsToDisabled()
    {
        Assert.False(new SiteConfig().Supabase.Enabled);
    }

    [Fact]
    public void TheBurnedInProjectMatchesTheDashboard()
    {
        // ⚠️ **שני עותקים של אותו ערך, ולכן בדיקה.** הכתובת והמפתח חיים גם
        // ב-<c>SupabaseDefaults</c> וגם ב-<c>dashboard/.env</c>, ו-check-agent-write
        // קורא דווקא את השני. בלי ההשוואה הזו הם יכולים להיפרד בשקט: השער
        // ימשיך לעבור מול הפרויקט הנכון, בעוד 16 הסוכנים בשטח פונים לפרויקט
        // שאינו קיים — וזה ייראה כמו "הכתיבה הישירה לא עובדת", בלי רמז לסיבה.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "dashboard")))
            dir = dir.Parent;

        // ⚠️ דילוג ולא כישלון: עץ המקור אינו קיים על מכונת בנייה מנותקת.
        // (הבדיקה חיה בשער `check-agent-live`, שרץ מתוך הריפו.)
        string env = Path.Combine(dir?.FullName ?? "", "dashboard", ".env");
        if (!File.Exists(env)) return;

        string text = File.ReadAllText(env);
        string? Val(string key) => text
            .Split('\n')
            .Select(l => l.Trim())
            .FirstOrDefault(l => l.StartsWith(key + "="))?[(key.Length + 1)..].Trim();

        Assert.Equal(Val("VITE_SUPABASE_URL"), SupabaseDefaults.Url);
        Assert.Equal(Val("VITE_SUPABASE_PUBLISHABLE_KEY"), SupabaseDefaults.AnonKey);
    }

    [Fact]
    public void TheUserNameIsDerivedFromTheSiteCode()
    {
        // ⚠️ חייב להסכים מילה במילה עם emailFor ב-provision-agent-user.js.
        // אי-הסכמה כאן פירושה סוכן שמנסה להתחבר כמשתמש שלא נוצר — 400 בכל
        // סבב, ואף שורה במסד.
        Assert.Equal("site-2438@parkomat.co.il", SupabaseDefaults.EmailFor("2438"));
        Assert.Equal("site-2438@parkomat.co.il", SupabaseDefaults.EmailFor("  2438  "));
        Assert.Equal("", SupabaseDefaults.EmailFor(""));
    }

    [Fact]
    public void AnExplicitUserNameStillWins()
    {
        // דלת היציאה: אתר שהועבר להתקנה אחרת עם מוסכמת שמות אחרת.
        var c = new SupabaseConfig { SiteId = "2438", Email = "other@parkomat.co.il" };
        Assert.Equal("other@parkomat.co.il", c.EffectiveEmail);
    }

    [Fact]
    public void ConfigStoreStampsTheSiteCodeOntoTheSupabaseSettings()
    {
        // ⚠️ **בדיקה מבנית, ובכוונה: ConfigStore קורא וכותב תחת ProgramData**,
        // ובדיקה התנהגותית הייתה נוגעת בתיקייה של סוכן אמיתי.
        //
        // ומה היא מונעת: בלי ההשמה הזו שם המשתמש נגזר ממחרוזת ריקה, Enabled
        // נשאר false לנצח, ו**שום שגיאה אינה נרשמת** — הכתיבה הישירה פשוט
        // אינה קורית, וזה נראה בדיוק כמו "לא הפעילו את האתר".
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string src = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Core", "Configuration", "ConfigStore.cs"));
        Assert.Matches(new System.Text.RegularExpressions.Regex(
            @"\.Supabase\.SiteId\s*=\s*result\.SiteId\s*;"), src);
    }

    // ===== מדיניות האסימון =====

    [Fact]
    public void RefreshesBeforeExpiryNotAfter()
    {
        // ⚠️ רענון בתגובה ל-401 נשמע חסכוני והוא הדרך לאבד הודעות: כל שידור
        // שנופל חייב לחזור, והתור מתמלא בזמן שהסוכן מגלה מחדש בכל סבב.
        var now = DateTimeOffset.Parse("2026-09-01T10:00:00Z");

        // פג בעוד 4 דקות — בתוך שולי הרענון.
        Assert.True(TokenPolicy.ShouldRefresh("t", now.AddMinutes(4), now));
        // פג בעוד 30 דקות — עדיין טוב.
        Assert.False(TokenPolicy.ShouldRefresh("t", now.AddMinutes(30), now));
    }

    [Fact]
    public void MissingTokenOrExpiryAlwaysRefreshes()
    {
        // ⚠️ ברירת המחדל היא לרענן. ניסיון מיותר עולה בקשה אחת; הימנעות
        // שגויה עולה בכל ההודעות עד שמישהו ישים לב.
        var now = DateTimeOffset.UtcNow;
        Assert.True(TokenPolicy.ShouldRefresh(null, now.AddHours(1), now));
        Assert.True(TokenPolicy.ShouldRefresh("", now.AddHours(1), now));
        Assert.True(TokenPolicy.ShouldRefresh("   ", now.AddHours(1), now));
        Assert.True(TokenPolicy.ShouldRefresh("t", null, now));
    }

    [Theory]
    [InlineData(3600, true)]    // שעה — הרגיל
    [InlineData(0, false)]      // לא סביר
    [InlineData(-5, false)]
    [InlineData(90000, false)]  // מעל יממה — לא סביר
    public void ImplausibleExpiryBecomesNullNotAGuess(int seconds, bool expectValue)
    {
        // ⚠️ null פירושו "רענן בפעם הבאה", שהוא המצב הבטוח. ניחוש היה
        // מייצר אסימון שנחשב תקף אחרי שפג.
        var now = DateTimeOffset.UtcNow;
        var got = TokenPolicy.ExpiryFrom(seconds, now);
        Assert.Equal(expectValue, got is not null);
    }

    // ===== המטען =====

    [Fact]
    public void StampIsIsoUtcWithMillisecondsAndZ()
    {
        // ⚠️ השרת שומר תאריכים כ-TEXT ומשווה אותם **לקסיקלית**. פורמט שאינו
        // אחיד עדיין "עובד" ומייצר סדר שגוי בהשוואות טווח.
        Assert.Equal("2026-09-01T10:00:00.000Z", BatchPayload.Stamp(1788256800));
    }

    [Fact]
    public void OperationCarriesEveryFieldTheServerReads()
    {
        var item = BatchPayload.From(new OperationMessage
        {
            Timestamp = 1788256800, StartEnd = "end", EntryExit = "exit",
            User = "4271", CycleCounter = 65535, State = SiteState.Operating,
        });

        Assert.Equal("operation", item.Kind);
        Assert.Equal("end", item.StartEnd);
        Assert.Equal("exit", item.EntryExit);
        Assert.Equal("4271", item.Card);
        Assert.Equal("operating", item.State);
        Assert.Equal(65535, item.Cycle);
        Assert.Equal("2026-09-01T10:00:00.000Z", item.OccurredAt);
        Assert.Equal(item.OccurredAt, item.ReportedAt);
    }

    [Fact]
    public void EmptyCardStaysEmptyStringNotNull()
    {
        // ⚠️ הכרטיס הוא חלק ממפתח הדדופ בשרת. null היה משנה את המפתח,
        // ואותה הודעה שנמסרת שוב הייתה נכתבת פעמיים.
        var item = BatchPayload.From(new OperationMessage
        {
            Timestamp = 1788256800, StartEnd = "start", EntryExit = "entry",
            User = "", CycleCounter = 1, State = SiteState.Operating,
        });
        Assert.Equal("", item.Card);

        string json = BatchPayload.Serialize([item]);
        Assert.Contains("\"card\":\"\"", json);
    }

    [Fact]
    public void EmptyFaultTextIsOmittedSoALateOneCanStillFillIt()
    {
        // ⚠️ "" היה כותב תיאור ריק ונועל את השדה. השרת ממלא תיאור שהגיע
        // באיחור **רק** כשהוא NULL.
        var item = BatchPayload.From(new StateMessage
        {
            Timestamp = 1788256800, State = SiteState.Error, FaultText = "",
        });
        Assert.Null(item.FaultText);
        Assert.DoesNotContain("fault_text", BatchPayload.Serialize([item]));
    }

    [Fact]
    public void StateNamesMatchTheServerContractExactly()
    {
        // השמות נאכפים בשרת. שינוי שלהם שובר קליטה בשקט.
        Assert.Equal("ready", SiteStateJson.Name(SiteState.Ready));
        Assert.Equal("operating", SiteStateJson.Name(SiteState.Operating));
        Assert.Equal("error", SiteStateJson.Name(SiteState.Error));
        Assert.Equal("maintenance", SiteStateJson.Name(SiteState.Maintenance));
        Assert.Equal("no_comm", SiteStateJson.Name(SiteState.NoComm));
    }

    [Fact]
    public void BodyShapeIsExactlyWhatTheRpcExpects()
    {
        // ⚠️ הצורה הזו נבדקת גם בשרת (check-agent-write). שם המפתח חייב
        // להיות p_messages — PostgREST ממפה שמות פרמטרים, לא מיקומים.
        string json = BatchPayload.Serialize([
            BatchPayload.From(new StateMessage { Timestamp = 1788256800, State = SiteState.Ready }),
        ]);

        using var doc = JsonDocument.Parse(json);
        Assert.True(doc.RootElement.TryGetProperty("p_messages", out var arr));
        Assert.Equal(JsonValueKind.Array, arr.ValueKind);
        Assert.Equal("state", arr[0].GetProperty("kind").GetString());
        Assert.Equal("ready", arr[0].GetProperty("status").GetString());
    }

    [Fact]
    public void StateItemDoesNotCarryOperationFields()
    {
        // ⚠️ שדות מיותרים אינם שגיאה בשרת — הוא מתעלם מהם — ולכן הם בדיוק
        // הסוג שנשאר. מטען נקי הוא מה שמאפשר לקרוא זריקה בעוד חצי שנה.
        string json = BatchPayload.Serialize([
            BatchPayload.From(new StateMessage { Timestamp = 1788256800, State = SiteState.Ready }),
        ]);

        foreach (string f in new[] { "start_end", "entry_exit", "card", "cycle", "reported_at" })
            Assert.DoesNotContain($"\"{f}\"", json);
    }
}
