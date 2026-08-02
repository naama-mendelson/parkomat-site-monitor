using Parkomat.Agent.Core.Configuration;
using Xunit;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הבדיקות של החלטת ה-watchdog. הראשונה היא הבאג עצמו — נתק PLC שנראה
/// כתקיעה — ובלעדיה כל שאר הכיסוי עדיין היה עובר בירוק.
/// </summary>
public class WatchdogPolicyTests
{
    private const int Poll = 1000;                       // ברירת המחדל
    private const int Fresh = 10;                        // חלון רעננות בקצב הזה
    private const int Wedged = 30;                       // סף תקיעה בקצב הזה

    // ==========================================================
    // הבאג: נתק PLC אינו תקיעה
    // ==========================================================
    // הסוכן חי, הלולאה מסתובבת, אבל הבקר לא נענה — ולכן פעימת הלב מתיישנת.
    // קודם זה הוביל להריגה אחרי 30 שניות, בעוד שהסוכן צריך ~42 כדי לשדר
    // state=error. ההריגה איפסה את המונה, ולכן error לא שודר לעולם.
    [Theory]
    [InlineData(31)]    // רגע אחרי הסף הישן — כאן בדיוק נהרג קודם
    [InlineData(45)]    // אחרי שהספיק לדווח error
    [InlineData(600)]   // נתק ממושך: ממשיך לדווח, לא נהרג
    public void PlcOutage_WithALiveLoop_IsNotTreatedAsWedged(long heartbeatAge)
    {
        var action = WatchdogPolicy.Decide(
            processAlive: true,
            heartbeatAgeSeconds: heartbeatAge,   // הבקר לא נענה מזמן
            livenessAgeSeconds: 1,               // אבל הלולאה מסתובבת
            pollIntervalMs: Poll);

        Assert.Equal(WatchdogAction.None, action);
    }

    // ==========================================================
    // מה שהיה נכון קודם, וחייב להישאר נכון
    // ==========================================================
    [Fact]
    public void TrulyWedgedAgent_IsStillKilled()
    {
        // הלולאה עצמה עצרה — thread שמת, deadlock, קריאה תלויה. זה מה
        // שהמנגנון נועד לתפוס מלכתחילה, וההפרדה לא ויתרה עליו.
        var action = WatchdogPolicy.Decide(
            processAlive: true,
            heartbeatAgeSeconds: Wedged + 100,
            livenessAgeSeconds: Wedged + 1,
            pollIntervalMs: Poll);

        Assert.Equal(WatchdogAction.KillAndStart, action);
    }

    [Fact]
    public void DeadProcess_IsStarted()
    {
        var action = WatchdogPolicy.Decide(false, null, null, Poll);
        Assert.Equal(WatchdogAction.Start, action);
    }

    [Fact]
    public void HealthyAgent_IsReportedHealthy()
    {
        var action = WatchdogPolicy.Decide(true, 2, 1, Poll);
        Assert.Equal(WatchdogAction.NoteHealthy, action);
    }

    [Fact]
    public void HeartbeatExactlyAtTheEdgeOfTheWindow_IsStillHealthy()
    {
        // גבול כולל: חלון של 10 שניות פירושו ש-10 עדיין טרי. חצי-פתוח כאן
        // היה מרצד בין בריא ללא-בריא בכל שנייה עגולה.
        var action = WatchdogPolicy.Decide(true, Fresh, 1, Poll);
        Assert.Equal(WatchdogAction.NoteHealthy, action);
    }

    [Fact]
    public void WedgedExactlyAtTheThreshold_IsNotYetWedged()
    {
        // הסף הוא "מעל", לא "שווה" — עקבי עם ההתנהגות הקודמת.
        var action = WatchdogPolicy.Decide(true, 100, Wedged, Poll);
        Assert.Equal(WatchdogAction.None, action);
    }

    // ==========================================================
    // ברירות מחדל בטוחות: בספק — לא הורגים
    // ==========================================================
    [Fact]
    public void FreshInstall_WithNoFilesYet_IsLeftAlone()
    {
        // התקנה טרייה: התהליך עלה ועוד לא הספיק סבב. הריגה כאן הייתה
        // מכניסה כל התקנה חדשה ללופ.
        var action = WatchdogPolicy.Decide(true, null, null, Poll);
        Assert.Equal(WatchdogAction.None, action);
    }

    [Fact]
    public void OldAgentThatDoesNotWriteLiveness_IsLeftAlone()
    {
        // סוכן מגרסה ישנה: כותב heartbeat אך לא חיוּת. עדיף לא לגעת מאשר
        // להרוג אותו בלולאה על סמך מדידה שאין לנו.
        var action = WatchdogPolicy.Decide(true, 999, null, Poll);
        Assert.Equal(WatchdogAction.None, action);
    }

    [Fact]
    public void ClockJumpedBackwards_IsNotWedged()
    {
        // גיל שלילי = חותם "מהעתיד". שינוי שעון אינו תקלה של הסוכן.
        var action = WatchdogPolicy.Decide(true, -50, -50, Poll);
        Assert.Equal(WatchdogAction.None, action);
    }

    [Fact]
    public void DeadProcess_WinsOverEverything()
    {
        // תהליך שאינו קיים — אין מה למדוד, פשוט מפעילים.
        var action = WatchdogPolicy.Decide(false, 1, 1, Poll);
        Assert.Equal(WatchdogAction.Start, action);
    }

    // ==========================================================
    // הספים נגזרים מקצב הדגימה, ולא קבועים
    // ==========================================================
    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    [InlineData(10000)]
    [InlineData(60000)]
    public void ThresholdsFollowThePollInterval(int pollMs)
    {
        int fresh = HeartbeatPolicy.FreshnessWindowSeconds(pollMs);
        int wedged = RestartPolicy.WedgedAfterSeconds(pollMs);

        Assert.Equal(WatchdogAction.NoteHealthy,
            WatchdogPolicy.Decide(true, fresh, 1, pollMs));
        Assert.Equal(WatchdogAction.None,
            WatchdogPolicy.Decide(true, fresh + 1, 1, pollMs));
        Assert.Equal(WatchdogAction.KillAndStart,
            WatchdogPolicy.Decide(true, wedged + 1, wedged + 1, pollMs));
    }
}
