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
        var cfg = new SupabaseConfig
        {
            Url = "  ", AnonKey = "k", Email = "a@parkomat.co.il", Password = "p",
        };
        Assert.False(cfg.Enabled);
    }

    [Fact]
    public void SiteConfigDefaultsToDisabled()
    {
        Assert.False(new SiteConfig().Supabase.Enabled);
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
