using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ריסון ההפעלות-מחדש של ה-watchdog.
///
/// ==========================================================
/// למה זה קוד שחייב בדיקות, ולא "עוד backoff"
/// ==========================================================
/// ה-watchdog של ה-Tray רץ כל 5 שניות ומפעיל מחדש כל תהליך שאינו רץ. עד
/// 1.0.15 זה היה בזבוז בלבד. מ-1.0.15 ה-detector פותח פעולה גם בקריאה
/// הראשונה שנוחתת באמצע מחזור, החותם שלה הוא "עכשיו", ומפתח ה-dedup בשרת
/// בנוי על החותם המדווח — ולכן **כל הפעלה מחדש מייצרת שורת פעולה חדשה**.
///
/// אתר עם MODE תקוע שהסוכן שלו קורס בלופ היה מייצר 17,280 פעולות פיקטיביות
/// ביום, ומכיוון שמכנה אחוז הכשל הוא מספר הפעולות — **אתר שבור היה מקבל ציון
/// בריא יותר** ככל שהוא נשבר יותר.
///
/// השעון מוזרק, ולכן כל זה נבדק בלי תהליכים אמיתיים ובלי להמתין בזמן אמת.
/// </summary>
public class RestartPolicyTests
{
    /// <summary>שעון נשלט לבדיקות — מקדמים אותו ידנית.</summary>
    private sealed class FakeClock
    {
        public DateTime UtcNow { get; private set; } = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public void Advance(TimeSpan by) => UtcNow += by;
        public void Advance(int seconds) => Advance(TimeSpan.FromSeconds(seconds));
    }

    // ===== סולם ההמתנה — פונקציה טהורה =====

    [Theory]
    [InlineData(0, 0)]        // הקריסה הראשונה מטופלת מיד, בלי דחייה
    [InlineData(1, 5)]
    [InlineData(2, 10)]
    [InlineData(3, 20)]
    [InlineData(4, 40)]
    [InlineData(5, 80)]
    [InlineData(6, 160)]
    [InlineData(7, 300)]      // 320 — מהודק לתקרה
    [InlineData(8, 300)]
    public void DelaySecondsFor_DoublesUpToTheCap(int consecutive, int expected)
    {
        Assert.Equal(expected, RestartPolicy.DelaySecondsFor(consecutive));
    }

    [Theory]
    [InlineData(16)]
    [InlineData(17)]          // מעבר לשמירה מפני גלישת ההזזה
    [InlineData(64)]
    [InlineData(1000)]
    [InlineData(int.MaxValue)]
    public void DelaySecondsFor_NeverOverflows_NorExceedsTheCap(int consecutive)
    {
        int delay = RestartPolicy.DelaySecondsFor(consecutive);

        // חיובי ובתוך התקרה. הזזה של 1<<n עם n גדול הייתה מחזירה ערך שלילי
        // או אפס, וההמתנה הייתה נעלמת בדיוק במקרה הגרוע ביותר.
        Assert.InRange(delay, 0, RestartPolicy.MaxDelaySeconds);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public void DelaySecondsFor_NegativeCount_IsTreatedAsImmediate(int consecutive)
    {
        Assert.Equal(0, RestartPolicy.DelaySecondsFor(consecutive));
    }

    // ===== הריסון עצמו =====

    [Fact]
    public void FirstRestart_IsImmediate()
    {
        // קריסה בודדת חייבת להיות מטופלת מיד. ריסון שמעכב גם את הניסיון
        // הראשון היה הופך תקלה חולפת להשבתה של 5 שניות בכל אתר.
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        Assert.Equal(0, throttle.NextDelaySeconds);
        Assert.True(throttle.TryTake());
        Assert.Equal(1, throttle.ConsecutiveRestarts);
        Assert.Equal(clock.UtcNow, throttle.LastRestartUtc);
    }

    [Fact]
    public void SecondRestart_IsBlocked_UntilTheDelayElapsed()
    {
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        Assert.True(throttle.TryTake());          // מיידי
        Assert.Equal(5, throttle.NextDelaySeconds);

        // ה-watchdog פועם כל 5 שניות; ארבע שניות אחרי — עוד לא.
        clock.Advance(4);
        Assert.False(throttle.TryTake());
        Assert.Equal(1, throttle.ConsecutiveRestarts);   // ניסיון שנדחה אינו נספר

        clock.Advance(1);                          // בדיוק על הגבול — מותר
        Assert.True(throttle.TryTake());
        Assert.Equal(2, throttle.ConsecutiveRestarts);
    }

    [Fact]
    public void RejectedAttempts_DoNotAdvanceTheCounter()
    {
        // קריטי: אחרת כל פעימה של ה-watchdog הייתה מקדמת את המונה, ההמתנה
        // הייתה מזנקת לתקרה תוך שניות, וסוכן שקרס פעם אחת היה תקוע 5 דקות.
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        Assert.True(throttle.TryTake());

        for (int i = 0; i < 100; i++)
            Assert.False(throttle.TryTake());

        Assert.Equal(1, throttle.ConsecutiveRestarts);
        Assert.Equal(5, throttle.NextDelaySeconds);
    }

    [Fact]
    public void BackoffGrows_AcrossConsecutiveRestarts()
    {
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        // הפערים בפועל בין הפעלה להפעלה: 0, 5, 10, 20, 40, 80, 160, ואז תקרה.
        int[] expectedGaps = { 0, 5, 10, 20, 40, 80, 160, 300, 300 };

        foreach (int gap in expectedGaps)
        {
            if (gap > 0)
            {
                clock.Advance(gap - 1);
                Assert.False(throttle.TryTake());   // שנייה לפני — חסום
                clock.Advance(1);
            }

            Assert.True(throttle.TryTake());
        }

        Assert.Equal(expectedGaps.Length, throttle.ConsecutiveRestarts);
    }

    // ===== התרחיש שבגללו הקוד קיים =====

    [Fact]
    public void CrashLoop_OverAnHour_IsCutFromHundredsOfRestartsToAHandful()
    {
        // סימולציה נאמנה: ה-watchdog פועם כל 5 שניות במשך שעה, והסוכן מת
        // בכל פעם מיד. כל הפעלה כזו = שורת פעולה פיקטיבית בשרת.
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        const int tickSeconds = 5;
        const int oneHour = 3600;

        int restarts = 0;
        for (int t = 0; t < oneHour; t += tickSeconds)
        {
            if (throttle.TryTake())
                restarts++;
            clock.Advance(tickSeconds);
        }

        int unthrottled = oneHour / tickSeconds;   // 720 — ההתנהגות הקודמת
        Assert.Equal(720, unthrottled);

        // בפועל מתכנס ל-~17 (התקרה היא 300 שניות → לכל היותר 12 לשעה אחרי
        // שלב ההתחלה). לא נועלים על מספר מדויק כדי שכוונון של הקבועים לא
        // יפיל את הבדיקה בהודעה מבלבלת — מה שנבדק הוא סדר הגודל.
        Assert.InRange(restarts, 1, 20);
        Assert.True(restarts * 40 < unthrottled,
            $"הריסון חייב לחתוך לפחות פי 40; בפועל {restarts} מול {unthrottled}");
    }

    [Fact]
    public void CrashLoop_SteadyState_NeverExceedsTheCapRate()
    {
        // אחרי שהגיעו לתקרה, אין שתי הפעלות קרובות מ-MaxDelaySeconds.
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        DateTime? previous = null;
        var gaps = new List<double>();

        for (int t = 0; t < 7200; t += 5)
        {
            if (throttle.TryTake())
            {
                if (previous is DateTime p)
                    gaps.Add((clock.UtcNow - p).TotalSeconds);
                previous = clock.UtcNow;
            }
            clock.Advance(5);
        }

        // חמשת הפערים האחרונים כבר בתקרה.
        foreach (double gap in gaps.TakeLast(5))
            Assert.Equal(RestartPolicy.MaxDelaySeconds, gap, precision: 3);
    }

    // ===== חזרה לבריאות =====

    [Fact]
    public void NoteHealthy_ResetsTheThrottle_AfterASustainedHealthyPeriod()
    {
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        Assert.True(throttle.TryTake());
        clock.Advance(5);
        Assert.True(throttle.TryTake());
        Assert.Equal(2, throttle.ConsecutiveRestarts);

        // דקה של בריאות — עוד לא מספיק. תקלה שחוזרת מיד היא אותה תקלה.
        clock.Advance(60);
        throttle.NoteHealthy();
        Assert.Equal(2, throttle.ConsecutiveRestarts);

        // מעבר ל-HealthyResetAfter — הסוכן באמת התייצב.
        clock.Advance(RestartPolicy.HealthyResetAfter);
        throttle.NoteHealthy();
        Assert.Equal(0, throttle.ConsecutiveRestarts);
        Assert.Null(throttle.LastRestartUtc);

        // ולכן התקלה הבאה מטופלת מיד, ולא יורשת המתנה של 5 דקות.
        Assert.Equal(0, throttle.NextDelaySeconds);
        Assert.True(throttle.TryTake());
    }

    [Fact]
    public void NoteHealthy_OnAThrottleThatNeverRestarted_IsANoOp()
    {
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        clock.Advance(TimeSpan.FromDays(1));
        throttle.NoteHealthy();

        Assert.Equal(0, throttle.ConsecutiveRestarts);
        Assert.Null(throttle.LastRestartUtc);
        Assert.True(throttle.TryTake());   // עדיין מיידי
    }

    [Fact]
    public void RecoveredAgent_ThatCrashesAgainMuchLater_IsHandledImmediately()
    {
        // התרחיש שההערה בקוד מזהירה ממנו: בלי איפוס, סוכן שקרס פעם אחת לפני
        // יומיים היה נשאר עם ההמתנה המקסימלית לנצח.
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        for (int i = 0; i < 8; i++)
        {
            clock.Advance(RestartPolicy.MaxDelaySeconds);
            throttle.TryTake();
        }
        Assert.Equal(RestartPolicy.MaxDelaySeconds, throttle.NextDelaySeconds);

        // יומיים של בריאות (ה-watchdog קורא NoteHealthy בכל פעימה).
        clock.Advance(TimeSpan.FromDays(2));
        throttle.NoteHealthy();

        Assert.Equal(0, throttle.ConsecutiveRestarts);
        Assert.True(throttle.TryTake());
    }

    [Fact]
    public void Reset_ClearsEverything_ForExplicitUserActions()
    {
        // "הפעל" / "עצור" / "החל הגדרות" — המשתמש מבקש ניסיון עכשיו.
        var clock = new FakeClock();
        var throttle = new RestartThrottle(() => clock.UtcNow);

        throttle.TryTake();
        clock.Advance(5);
        throttle.TryTake();
        Assert.False(throttle.TryTake());   // כרגע חסום

        throttle.Reset();

        Assert.Equal(0, throttle.ConsecutiveRestarts);
        Assert.Null(throttle.LastRestartUtc);
        Assert.Equal(0, throttle.NextDelaySeconds);
        Assert.True(throttle.TryTake());    // ומיד אפשר
    }

    [Fact]
    public void DefaultConstructor_UsesTheRealClock()
    {
        // אין רגרסיה בשימוש הרגיל של ServiceManager (בלי הזרקה).
        var throttle = new RestartThrottle();

        Assert.Equal(0, throttle.ConsecutiveRestarts);
        Assert.True(throttle.TryTake());
        Assert.False(throttle.TryTake());   // ההמתנה של 5 שניות תופסת מיד
    }

    // ===== סף התקיעה =====

    [Theory]
    [InlineData(1000)]
    [InlineData(500)]
    [InlineData(5000)]
    public void WedgedAfterSeconds_IsThreeFreshnessWindows(int pollMs)
    {
        // מקור אמת אחד: הסף נגזר מ-HeartbeatPolicy ולא מקבוע משוכפל, כדי
        // ששינוי בחלון הרעננות לא ייצור שתי הגדרות סותרות של "טרי".
        Assert.Equal(
            RestartPolicy.WedgedHeartbeatWindows * HeartbeatPolicy.FreshnessWindowSeconds(pollMs),
            RestartPolicy.WedgedAfterSeconds(pollMs));
    }

    [Fact]
    public void WedgedAfterSeconds_IsComfortablyAboveASingleWindow()
    {
        // חלון בודד נחשב "לא טרי" גם בדגימה איטית או בכמה קריאות PLC שנכשלו,
        // ולהרוג את הסוכן על זה גרוע מלא לעשות כלום.
        int window = HeartbeatPolicy.FreshnessWindowSeconds(1000);
        int wedged = RestartPolicy.WedgedAfterSeconds(1000);

        Assert.True(wedged >= 3 * window);
        Assert.True(wedged >= 30, $"סף התקיעה בדגימת ברירת המחדל חייב להיות חצי דקה לפחות; בפועל {wedged}s");
    }
}
