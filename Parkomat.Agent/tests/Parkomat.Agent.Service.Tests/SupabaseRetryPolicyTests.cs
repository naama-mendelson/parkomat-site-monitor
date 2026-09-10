using System.Text.RegularExpressions;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>הלולאה החמה — נמדדה באתר 1326 ב-09/09/2026.</b>
///
/// <para>שער השליחה נפתח בכל סבב שבו התור אינו ריק, כלומר כל שנייה.
/// הסיסמה שם הייתה פסולה, ההודעות חזרו לתור, והתור לא התרוקן לעולם:
/// <b>~78,000 בקשות ביום מאתר אחד</b>, ו-Supabase החזירה
/// <c>429 over_request_rate_limit</c> לסירוגין — כלומר השרת כבר הגן על
/// עצמו מפני הסוכן שלנו.</para>
///
/// <para>⚠️ וזה אינו ייחודי לסיסמה: כל כשל מתמשך מייצר את אותה לולאה.</para>
/// </summary>
public class SupabaseRetryPolicyTests
{
    // ------------------------------------------------------------
    // הסולם עצמו
    // ------------------------------------------------------------
    [Fact]
    public void NoFailuresMeansNoWait()
    {
        Assert.Equal(0, SupabaseRetryPolicy.DelaySeconds(0));
        Assert.Equal(0, SupabaseRetryPolicy.DelaySeconds(-3));
    }

    [Fact]
    public void TheFirstFailureWaitsAndTheNextOnesDouble()
    {
        Assert.Equal(5,  SupabaseRetryPolicy.DelaySeconds(1));
        Assert.Equal(10, SupabaseRetryPolicy.DelaySeconds(2));
        Assert.Equal(20, SupabaseRetryPolicy.DelaySeconds(3));
        Assert.Equal(40, SupabaseRetryPolicy.DelaySeconds(4));
    }

    // ⚠️ **תקרה, ולא גדילה ללא גבול.** ההמתנה חלה גם על הפעימה, ו-
    // `mark_silent_agents` מסמנת אתר מנותק אחרי שלוש דקות בלי פעימה.
    // תקרה גבוהה מדי הייתה משאירה אתר שהתאושש מסומן מנותק זמן רב אחרי
    // שהתקשורת חזרה.
    [Fact]
    public void TheWaitIsCappedAtFiveMinutes()
    {
        Assert.Equal(300, SupabaseRetryPolicy.MaxDelaySeconds);
        Assert.Equal(300, SupabaseRetryPolicy.DelaySeconds(50));
        Assert.Equal(300, SupabaseRetryPolicy.DelaySeconds(1000));
    }

    // ⚠️ **מונה ענק אינו מייצר המתנה שלילית.** `Math.Pow` או הזזת ביטים
    // על מונה של אתר שנכשל יממה שלמה היו עולים על גדות `int` לערך שלילי —
    // כלומר "לנסות מיד", ההפך הגמור מהכוונה, ודווקא במקרה הקיצוני.
    [Fact]
    public void AHugeFailureCountNeverProducesANegativeWait()
    {
        foreach (int n in new[] { 60, 1000, 100_000, int.MaxValue })
        {
            int d = SupabaseRetryPolicy.DelaySeconds(n);
            Assert.InRange(d, 0, SupabaseRetryPolicy.MaxDelaySeconds);
        }
    }

    // ------------------------------------------------------------
    // ⚠️ כשל קבוע — קפיצה לתקרה, לא טיפוס אליה
    // ------------------------------------------------------------
    [Theory]
    [InlineData(400, "{\"error_code\":\"invalid_credentials\",\"msg\":\"Invalid login credentials\"}")]
    // ⚠️ הטקסט הזה מכיל **רק** את קוד השגיאה, בלי "Invalid login". בלעדיו,
    // מוטציה שמחקה את הבדיקה על `invalid_credentials` עברה ירוקה — הסעיף
    // השני של התנאי כיסה אותה בכל מקרי הבדיקה.
    [InlineData(400, "{\"error_code\":\"invalid_credentials\"}")]
    [InlineData(401, "invalid_grant")]
    [InlineData(403, "Invalid login credentials")]
    [InlineData(429, "{\"error_code\":\"over_request_rate_limit\"}")]
    public void CredentialsAndRateLimitsAreTreatedAsPermanent(int status, string error)
    {
        Assert.True(SupabaseRetryPolicy.IsPermanent(status, error));
        Assert.Equal(SupabaseRetryPolicy.MaxDelaySeconds,
            SupabaseRetryPolicy.DelaySeconds(
                SupabaseRetryPolicy.NextFailureCount(0, status, error)));
    }

    // ⚠️ **ו-400 שאינו הזדהות אינו קבוע.** 400 הוא גם "הודעה פגומה", וזה
    // כשל שמשתנה בין הודעה להודעה: הודעה אחת פגומה אינה סיבה להאט את כל
    // האתר לחמש דקות. לכן הבדיקה על הטקסט ולא רק על הקוד.
    [Fact]
    public void AMalformedMessageIsNotPermanent()
    {
        Assert.False(SupabaseRetryPolicy.IsPermanent(400, "malformed batch item"));
        Assert.False(SupabaseRetryPolicy.IsPermanent(500, "internal error"));
        Assert.False(SupabaseRetryPolicy.IsPermanent(0, "network unreachable"));
        Assert.False(SupabaseRetryPolicy.IsPermanent(400, null));
    }

    // ⚠️ **לא מוותרים לצמיתות.** הטכנאי יכול לתקן את הסיסמה בטופס בכל
    // רגע; סוכן שהפסיק לנסות היה דורש הפעלה מחדש כדי לשים לב.
    [Fact]
    public void APermanentFailureStillRetriesEventually()
    {
        int n = SupabaseRetryPolicy.NextFailureCount(0, 400, "invalid_credentials");
        Assert.InRange(SupabaseRetryPolicy.DelaySeconds(n), 1, SupabaseRetryPolicy.MaxDelaySeconds);
    }

    // המונה אינו גדל בלי גבול, אחרת הוא עצמו היה עולה על גדותיו.
    [Fact]
    public void TheCounterItselfIsBounded()
    {
        int n = 0;
        for (int i = 0; i < 10_000; i++) n = SupabaseRetryPolicy.NextFailureCount(n, 500, "x");
        Assert.InRange(n, 1, SupabaseRetryPolicy.FailuresAtCeiling);
    }

    // ============================================================
    // ⚠️ וההחלטה חייבת להיות מחוברת — לא רק להתקיים
    // ============================================================
    // מדיניות טהורה שאיש אינו קורא לה נראית בדיוק כמו מדיניות שעובדת.
    // אותה מוטציה שעברה בשקט היום ב-`ReportAutoStartHealth`, ב-
    // `WaitForSingleInstance` וב-`OldestOtherTrayAgeSeconds`.
    [Fact]
    public void TheGateActuallyWaits()
    {
        string code = WorkerCode();

        // השער חוסם עד שהזמן הגיע.
        Assert.Matches(new Regex(@"DateTimeOffset\.UtcNow >= supaNextAttempt"), code);
        // הכשל מקדם את המונה ודוחה את הניסיון הבא.
        Assert.Matches(new Regex(@"SupabaseRetryPolicy\.NextFailureCount\("), code);
        Assert.Matches(new Regex(@"supaNextAttempt = DateTimeOffset\.UtcNow\.AddSeconds\("), code);
    }

    // ============================================================
    // ⚠️ וההצלחה מאפסת — ונבדק **בתוך ענף ההצלחה בלבד**
    // ============================================================
    // הגרסה הראשונה של השער חיפשה את שתי ההשמות בכל הקובץ — והן מופיעות
    // גם ב**הצהרת** המשתנים (`int supaFailures = 0;`,
    // `var supaNextAttempt = DateTimeOffset.MinValue;`). מוטציה שהסירה את
    // האיפוס מענף ההצלחה עברה ירוקה, כי ההצהרה סיפקה את ההתאמה.
    // זו הפעם החמישית היום שעוגן תופס הצהרה במקום שימוש.
    //
    // ובלי האיפוס: אתר שהתאושש נשאר עם המתנה של חמש דקות לנצח, כי שום
    // הצלחה אינה מורידה אותה.
    [Fact]
    public void SuccessClearsTheBackoff()
    {
        string code = WorkerCode();

        int ok = code.IndexOf("if (res.Ok)\n                        {", StringComparison.Ordinal);
        Assert.True(ok >= 0, "ענף ההצלחה לא נמצא");
        int elseAt = code.IndexOf("else", ok, StringComparison.Ordinal);
        Assert.True(elseAt > ok, "לא נמצא סוף ענף ההצלחה");

        string success = code[ok..elseAt];
        Assert.Contains("supaFailures = 0;", success);
        Assert.Contains("supaNextAttempt = DateTimeOffset.MinValue;", success);
    }

    // ⚠️ שורות הערה מוסרות: ההערות ב-Worker מסבירות את המנגנון כמעט
    // במילים של הקוד, והיו צובעות כל שער כאן ירוק בלי שהוא קיים.
    private static string WorkerCode()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string worker = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Worker.cs"));
        return string.Join("\n",
            worker.Split('\n').Select(l => l.TrimEnd('\r'))
                  .Where(l => !l.TrimStart().StartsWith("//")));
    }
}
