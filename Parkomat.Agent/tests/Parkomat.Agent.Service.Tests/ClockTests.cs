using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Time;
using Parkomat.Agent.Service.Logic;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// השעון המסונכרן (NTP) — מקור חותמות הזמן של הפעולות.
/// </summary>
public class ClockTests
{
    [Fact]
    public void Clock_BeforeAnySync_BehavesExactlyLikeLocalClock()
    {
        // קריטי: אתר עם UDP/123 חסום חייב להתנהג בדיוק כמו לפני התכונה.
        var clock = new AgentClock();

        Assert.False(clock.IsSynced);
        Assert.Equal(TimeSpan.Zero, clock.Offset);
        Assert.Null(clock.LastSyncUtc);

        long local = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.InRange(clock.UnixNow(), local - 1, local + 1);
    }

    [Fact]
    public void Clock_AppliesOffset_ToPublishedTime()
    {
        var clock = new AgentClock();
        long before = clock.UnixNow();

        clock.ApplyOffset(TimeSpan.FromMinutes(10));   // השעון המקומי מפגר ב-10 דק'

        Assert.True(clock.IsSynced);
        Assert.NotNull(clock.LastSyncUtc);
        // 600 שניות קדימה (± שנייה של ריצה)
        Assert.InRange(clock.UnixNow() - before, 599, 601);
    }

    [Fact]
    public void Clock_HandlesNegativeOffset_WhenPcClockRunsAhead()
    {
        var clock = new AgentClock();
        long before = clock.UnixNow();

        clock.ApplyOffset(TimeSpan.FromMinutes(-5));   // השעון המקומי מקדים

        Assert.InRange(clock.UnixNow() - before, -301, -299);
    }

    [Fact]
    public void Clock_LatestSyncWins()
    {
        var clock = new AgentClock();
        clock.ApplyOffset(TimeSpan.FromSeconds(120));
        clock.ApplyOffset(TimeSpan.FromSeconds(3));    // סנכרון מאוחר יותר מדייק

        Assert.Equal(TimeSpan.FromSeconds(3), clock.Offset);
    }

    // ===== חיבור למוח: הפעולות באמת נושאות את הזמן המתוקן =====

    [Fact]
    public void OperationDetector_UsesInjectedClock_ForOperationTimestamps()
    {
        // מחשב האתר מפגר בשעה. הפעולה חייבת להירשם בזמן ה-*אמיתי*.
        var clock = new AgentClock();
        clock.ApplyOffset(TimeSpan.FromHours(1));

        var detector = new OperationDetector(clock.UnixNow);

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 100);      // ready
        var result = detector.Process(mode: 2, cardNumber: "555", cycleCounter: 101);  // כניסה

        Assert.NotEmpty(result.Operations);
        long stamped = result.Operations[0].Timestamp;

        long corrected = clock.UnixNow();
        Assert.InRange(stamped, corrected - 2, corrected + 2);

        // ובפועל: שעה שלמה קדימה מהשעון המקומי הגולמי.
        long raw = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.InRange(stamped - raw, 3598, 3602);
    }

    [Fact]
    public void OperationDetector_WithoutClock_FallsBackToLocalTime()
    {
        // ברירת המחדל (בלי הזרקה) חייבת להישאר כפי שהייתה — כך 46 הטסטים
        // הקיימים וכל קורא אחר לא מושפעים.
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 1);
        var result = detector.Process(mode: 2, cardNumber: "7", cycleCounter: 2);

        long raw = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.NotEmpty(result.Operations);
        Assert.InRange(result.Operations[0].Timestamp, raw - 2, raw + 2);
    }

    // ===== שמירת ההיסט לדיסק — והפסילה של היסט לא-אמין =====

    [Fact]
    public void PersistedOffset_IsRestored_WhenFresh()
    {
        string path = Path.Combine(Path.GetTempPath(), $"clk-{Guid.NewGuid():N}");
        try
        {
            var saved = new AgentClock();
            saved.ApplyOffset(TimeSpan.FromSeconds(42));
            saved.Persist(path);

            var restored = new AgentClock();
            Assert.True(restored.TryLoadPersisted(path));
            Assert.Equal(42, restored.Offset.TotalSeconds, precision: 2);
            // משוחזר — אבל *לא* נחשב סנכרון טרי מול NTP.
            Assert.False(restored.IsSynced);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void PersistedOffset_IsRejected_WhenTooOld()
    {
        // היסט בן יומיים אינו אמין: השעון היה יכול להיות מתוקן בינתיים.
        string path = Path.Combine(Path.GetTempPath(), $"clk-{Guid.NewGuid():N}");
        try
        {
            long twoDaysAgo = DateTimeOffset.UtcNow.AddDays(-2).ToUnixTimeSeconds();
            File.WriteAllText(path, $"42.000 {twoDaysAgo}");

            var clock = new AgentClock();
            Assert.False(clock.TryLoadPersisted(path));
            Assert.Equal(TimeSpan.Zero, clock.Offset);   // ברירת מחדל בטוחה: בלי תיקון
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void PersistedOffset_IsRejected_WhenClockJumpedBackwards()
    {
        // זה תרחיש סוללת ה-RTC: השעון מתאפס אחורה, ולכן המדידה "מהעתיד".
        // היסט ישן במצב הזה היה מקלקל את הזמן במקום לתקן.
        string path = Path.Combine(Path.GetTempPath(), $"clk-{Guid.NewGuid():N}");
        try
        {
            long future = DateTimeOffset.UtcNow.AddHours(5).ToUnixTimeSeconds();
            File.WriteAllText(path, $"42.000 {future}");

            var clock = new AgentClock();
            Assert.False(clock.TryLoadPersisted(path));
            Assert.Equal(TimeSpan.Zero, clock.Offset);
        }
        finally { File.Delete(path); }
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("42")]
    [InlineData("")]
    public void PersistedOffset_CorruptFile_IsIgnored(string content)
    {
        string path = Path.Combine(Path.GetTempPath(), $"clk-{Guid.NewGuid():N}");
        try
        {
            File.WriteAllText(path, content);
            var clock = new AgentClock();
            Assert.False(clock.TryLoadPersisted(path));
            Assert.Equal(TimeSpan.Zero, clock.Offset);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void PersistedOffset_MissingFile_IsIgnored()
    {
        var clock = new AgentClock();
        Assert.False(clock.TryLoadPersisted(Path.Combine(Path.GetTempPath(), $"nope-{Guid.NewGuid():N}")));
    }

    // ===== הידוק מרווח הסנכרון =====
    //
    // בלי ההידוק, מרווח גדול מ-~24.8 ימים גורם ל-Task.Delay לזרוק
    // ArgumentOutOfRangeException. הלולאה היא משימת רקע מנותקת, ולכן החריגה
    // הופכת ל-unobserved ומשתיקה את סנכרון השעון לצמיתות — בלי שורה בלוג.
    [Theory]
    [InlineData(0, 1)]              // 0 → הרצפה
    [InlineData(-5, 1)]             // שלילי → הרצפה
    [InlineData(1, 1)]
    [InlineData(60, 60)]            // ברירת המחדל עוברת כמו שהיא
    [InlineData(1440, 1440)]        // 24 שעות — התקרה
    [InlineData(100000, 1440)]      // הערך שמפיל את Task.Delay — מהודק
    [InlineData(int.MaxValue, 1440)]
    public void NtpInterval_IsClampedToSaneRange(int input, int expected)
    {
        Assert.Equal(expected, ConfigStore.ClampNtpSyncIntervalMinutes(input));
    }

    [Fact]
    public void ClampedNtpInterval_IsAlwaysAcceptedByTaskDelay()
    {
        // ההוכחה שההידוק באמת סוגר את הפרצה: כל ערך מהודק חוקי ל-Task.Delay.
        foreach (int raw in new[] { -1, 0, 1, 60, 1440, 100000, int.MaxValue })
        {
            var interval = TimeSpan.FromMinutes(ConfigStore.ClampNtpSyncIntervalMinutes(raw));
            Assert.InRange(interval.TotalMilliseconds, 1, int.MaxValue);
        }
    }

    // ===== לקוח ה-NTP: אסור שיזרוק, בשום מצב =====

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("שרת.שלא.קיים.בכלל.פארקומט")]
    public async Task NtpClient_BadServer_ReturnsNullAndNeverThrows(string server)
    {
        // כישלון סנכרון הוא "נשארים על השעון המקומי" — לא תקלה שמפילה סוכן.
        TimeSpan? offset = await NtpClient.GetOffsetAsync(server, TimeSpan.FromSeconds(2));
        Assert.Null(offset);
    }

    [Fact]
    public async Task NtpClient_RespectsCancellation_WithoutThrowing()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        TimeSpan? offset = await NtpClient.GetOffsetAsync("pool.ntp.org", TimeSpan.FromSeconds(2), cts.Token);
        Assert.Null(offset);
    }
}
