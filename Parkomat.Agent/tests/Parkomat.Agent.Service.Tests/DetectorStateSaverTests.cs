using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// <b>מתי</b> נכתב זיכרון הגלאי — ולמה "רק על שינוי" לא הספיק.
///
/// <para>⚠️ <b>הבאג.</b> ‏<c>DetectorState.MaxAge</c> (10 דקות) נמדד מהחותם
/// שבקובץ, והקובץ נכתב <b>רק כש-MODE או הכרטיס זזו</b>. כלומר הגיל שנמדד
/// היה "כמה זמן עבר מהשינוי האחרון", ולא "כמה זמן עבר מאז שראינו את המצב".
/// MODE שתקוע על 2 יותר מעשר דקות — בדיוק האתר התקוע שהשחזור נבנה בשבילו —
/// ואז הפעלה מחדש: המצב נפסל כ"ישן", והקריאה הראשונה פותחת <b>תפעול
/// פיקטיבי</b>. ומכנה אחוז הכשל הוא מספר התפעולים.</para>
///
/// <para>⚠️ <b>והפתרון אינו כתיבה בכל דגימה</b> — זה מה שהבלוק הדו-מערכתי
/// עשה, ארבע פעולות דיסק בשנייה על מחשב שמריץ גם את המחסום. כותבים על
/// שינוי, ובלי שינוי — פעם ב-<see cref="DetectorStateSaver.RefreshInterval"/>.</para>
///
/// <para>כל הבדיקות בתיקייה זמנית; אף אחת אינה נוגעת ב-ProgramData.</para>
/// </summary>
public sealed class DetectorStateSaverTests : IDisposable
{
    private readonly string _dir;
    private readonly string _path;

    public DetectorStateSaverTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "pk-dss-" + Guid.NewGuid().ToString("N"));
        _path = Path.Combine(_dir, "detector-state");
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    // ============================================================
    // ⚠️ הבאג עצמו, כפי שהוא קורה באתר
    // ============================================================
    [Fact]
    public void AModeStuckLongerThanMaxAgeIsStillRestoredAfterARestart()
    {
        var saver = new DetectorStateSaver(_path);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        DateTimeOffset enteredMode2 = now - DetectorState.MaxAge - TimeSpan.FromMinutes(20);

        // הבקר נכנס ל-MODE 2 לפני חצי שעה ולא זז מאז; הסוכן דגם כל הזמן.
        for (DateTimeOffset t = enteredMode2; t <= now; t += TimeSpan.FromSeconds(1))
            saver.Observe(2, "555", t);

        // ...ועכשיו הפעלה מחדש.
        DetectorState? restored = DetectorState.TryLoad(_path);

        Assert.NotNull(restored);
        Assert.Equal(2, restored!.PreviousMode);
        Assert.Equal("555", restored.OperationCard);
    }

    // ⚠️ והחסם עדיין חוסם את מה שהוא נועד לחסום: סוכן **שהיה למטה** יותר
    // מ-MaxAge. הרענון קורה רק בזמן שדוגמים, ולכן הוא אינו מאריך מצב שאיש
    // לא ראה.
    [Fact]
    public void StateFromAnAgentThatWasDownLongerThanMaxAgeIsStillRejected()
    {
        var saver = new DetectorStateSaver(_path);
        DateTimeOffset lastSeen = DateTimeOffset.UtcNow - DetectorState.MaxAge - TimeSpan.FromMinutes(1);

        saver.Observe(2, "555", lastSeen);

        Assert.Null(DetectorState.TryLoad(_path));
    }

    // ============================================================
    // כמה כתיבות — ההחלטה עצמה
    // ============================================================
    [Fact]
    public void TheFirstObservationIsWritten()
    {
        var saver = new DetectorStateSaver(_path);
        Assert.True(saver.Observe(1, "", DateTimeOffset.UtcNow));
        Assert.True(File.Exists(_path));
    }

    [Fact]
    public void AnUnchangedStateIsNotRewrittenOnEveryPoll()
    {
        var saver = new DetectorStateSaver(_path);
        DateTimeOffset t0 = DateTimeOffset.UtcNow;
        saver.Observe(1, "", t0);

        int writes = 0;
        for (int s = 1; s < (int)DetectorStateSaver.RefreshInterval.TotalSeconds; s++)
            if (saver.Observe(1, "", t0.AddSeconds(s))) writes++;

        Assert.Equal(0, writes);
    }

    [Fact]
    public void AnUnchangedStateIsRefreshedOnceTheIntervalPasses()
    {
        var saver = new DetectorStateSaver(_path);
        DateTimeOffset t0 = DateTimeOffset.UtcNow;
        saver.Observe(1, "", t0);

        Assert.True(saver.Observe(1, "", t0 + DetectorStateSaver.RefreshInterval));
    }

    [Theory]
    [InlineData(2, "")]     // MODE זז
    [InlineData(1, "42")]   // הכרטיס זז
    public void AChangeIsWrittenAtOnce(int mode, string card)
    {
        var saver = new DetectorStateSaver(_path);
        // ⚠️ בעבר ולא "עכשיו": TryLoad פוסל חותם מהעתיד, וחותם של t0+1s
        // על שעון אמיתי הוא בדיוק כזה.
        DateTimeOffset t0 = DateTimeOffset.UtcNow.AddMinutes(-1);
        saver.Observe(1, "", t0);

        Assert.True(saver.Observe(mode, card, t0.AddSeconds(1)));
        Assert.Equal(mode, DetectorState.TryLoad(_path)!.PreviousMode);
    }

    // ⚠️ השעון קפץ אחורה: "עבר זמן שלילי" אינו סיבה להפסיק לרענן לנצח.
    // בלי זה חותם מהעתיד היה מקפיא את הקובץ עד שהשעון ישיג אותו — ו-TryLoad
    // פוסל חותם מהעתיד ממילא.
    [Fact]
    public void AClockThatJumpedBackwardsStillRefreshes()
    {
        var saver = new DetectorStateSaver(_path);
        DateTimeOffset t0 = DateTimeOffset.UtcNow;
        saver.Observe(1, "", t0);

        Assert.True(saver.Observe(1, "", t0.AddHours(-1)));
    }

    // ============================================================
    // ⚠️ היחס שחייב להחזיק בין שלושת המספרים
    // ============================================================
    // מצב שנכתב לכל היותר לפני RefreshInterval, ועוד ההמתנה הארוכה ביותר של
    // ה-Tray לפני הפעלה מחדש, חייב להיות צעיר מ-MaxAge. אחרת הפעלה מרוסנת
    // של אתר תקוע נופלת מחוץ לחלון — והתפעול הפיקטיבי חוזר בשקט.
    [Fact]
    public void RefreshPlusTheLongestRestartBackoffStaysInsideMaxAge()
    {
        TimeSpan worst = DetectorStateSaver.RefreshInterval
                       + TimeSpan.FromSeconds(RestartPolicy.MaxDelaySeconds);

        Assert.True(worst < DetectorState.MaxAge,
            $"רענון ({DetectorStateSaver.RefreshInterval}) + המתנה ({RestartPolicy.MaxDelaySeconds}s) " +
            $"אינם נכנסים ב-MaxAge ({DetectorState.MaxAge})");
    }
}
