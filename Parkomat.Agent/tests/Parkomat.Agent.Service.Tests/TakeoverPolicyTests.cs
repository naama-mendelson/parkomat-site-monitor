using System.Text.RegularExpressions;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// מופע שני של ה-Tray — לצאת בשקט, או להשתלט.
///
/// <para>⚠️ <b>החור שזה סוגר: אף אחד לא משגיח על המשגיח.</b> ה-Tray מפעיל
/// מחדש את הסוכן ואת Mosquitto; המשימה המתוזמנת מפעילה מחדש את ה-Tray.
/// אבל <c>Program.Main</c> סיים מופע שני <b>בשקט</b> ברגע שה-Mutex תפוס,
/// ולכן Tray תקוע — התהליך חי, הלולאה עומדת — חסם את המשימה כל חמש דקות
/// לנצח. האתר מת, ובמנהל המשימות רואים "טריי רץ".</para>
///
/// <para>⚠️ והשאלה הנשאלת היא על <b>הסוכן</b>, לא על ה-Tray: אין דרך
/// חיצונית לדעת אם לולאת ה-Tray מסתובבת, ואין צורך. קובץ החיוּת נכתב בכל
/// סיבוב של הסוכן, ולכן "הסוכן עומד זמן רב" הוא בדיוק המצב שבו Tray
/// מתפקד כבר היה מפעיל אותו מחדש.</para>
/// </summary>
public class TakeoverPolicyTests
{
    private const int Poll = 1000;
    private static int Wedged => RestartPolicy.WedgedAfterSeconds(Poll);
    private static int Threshold => TakeoverPolicy.TakeoverAfterSeconds(Poll);

    // ------------------------------------------------------------
    // המצב התקין — ולא נוגעים בו
    // ------------------------------------------------------------
    [Fact]
    public void AHealthyTrayIsLeftAlone()
    {
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(agentProcessAlive: true, livenessAgeSeconds: 2, Poll));
    }

    // ============================================================
    // ⚠️ הסף גדול פי שלושה מסף התקיעה, ובכוונה
    // ============================================================
    // ה-Tray עצמו מפעיל מחדש את הסוכן ברגע שהוא תקוע. סף זהה היה גורם
    // למופע שני להשתלט **באמצע התאוששות תקינה** — כלומר להרוג טריי
    // שעושה בדיוק את עבודתו, ואז לחזור על זה כל חמש דקות.
    [Fact]
    public void ATrayInTheMiddleOfARestartIsNotKilled()
    {
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(false, Wedged + 1, Poll));
    }

    [Fact]
    public void TheThresholdIsThreeTimesWedged()
    {
        Assert.Equal(Wedged * 3, Threshold);
        Assert.Equal(3, TakeoverPolicy.WedgedMultiplier);
    }

    // ------------------------------------------------------------
    // שני המצבים שמצדיקים השתלטות
    // ------------------------------------------------------------
    // ⚠️ הסוכן מת והטריי לא הפעיל אותו מחדש — זה כל תפקידו.
    [Fact]
    public void ADeadAgentThatWasNotRestartedMeansTheTrayIsNotWorking()
    {
        Assert.Equal(TakeoverPolicy.Action.TakeOver,
            TakeoverPolicy.Decide(agentProcessAlive: false, Threshold + 1, Poll));
    }

    // ⚠️ והסוכן חי אבל הלולאה עומדת, והטריי לא הרג אותו — אותה מסקנה.
    // בלי המקרה הזה, סוכן תקוע (לא מת) היה נשאר תקוע לנצח: התהליך קיים,
    // אז שום דבר לא נראה חסר.
    [Fact]
    public void AWedgedAgentThatWasNotKilledMeansTheSame()
    {
        Assert.Equal(TakeoverPolicy.Action.TakeOver,
            TakeoverPolicy.Decide(agentProcessAlive: true, Threshold + 1, Poll));
    }

    // ------------------------------------------------------------
    // ⚠️ ושני מצבים שבהם ספק חייב להוביל ליציאה
    // ------------------------------------------------------------
    // אין קובץ חיוּת: התקנה טרייה שטרם השלימה סיבוב, או גרסה ישנה שאינה
    // כותבת אותו. השתלטות כאן הייתה הופכת כל הפעלה של המשימה להריגת
    // הטריי — לולאת הרג כל חמש דקות, בדיוק ההפך מהמטרה.
    [Fact]
    public void NoLivenessFileMeansNoTakeover()
    {
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(false, null, Poll));
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(true, null, Poll));
    }

    // ⚠️ גיל שלילי = שעון שקפץ אחורה (NTP, אזור זמן) והקובץ נראה מהעתיד.
    // הריגת טריי תקין בגלל תיקון שעון היא מלכודת מוכרת בפרויקט הזה.
    [Theory]
    [InlineData(-1)]
    [InlineData(-100000)]
    public void AClockThatWentBackwardsDoesNotKillAnything(long age)
    {
        Assert.Equal(TakeoverPolicy.Action.Exit, TakeoverPolicy.Decide(false, age, Poll));
        Assert.Equal(TakeoverPolicy.Action.Exit, TakeoverPolicy.Decide(true, age, Poll));
    }

    // ------------------------------------------------------------
    // ⚠️ וההחלטה חייבת להיות מחוברת — לא רק להתקיים
    // ------------------------------------------------------------
    // מדיניות טהורה שאיש אינו קורא לה נראית בדיוק כמו מדיניות שעובדת.
    // בדיוק אותה מוטציה שעברה בשקט היום ב-`ReportAutoStartHealth`.
    [Fact]
    public void TheSecondInstanceActuallyAsks()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string prog = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Program.cs"));
        // ⚠️ שורות הערה מוסרות: הערה שמסבירה את המנגנון הייתה צובעת את
        // הבדיקה ירוקה בלי שהוא קיים.
        string code = string.Join("\n",
            prog.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        Assert.Matches(new Regex(@"TrayTakeover\.ShouldTakeOver\(\)"), code);
        Assert.Matches(new Regex(@"TrayTakeover\.KillExistingTray\(\)"), code);

        // ⚠️ **והיציאה העיוורת חייבת להיעלם.** `if (!isNew) return;` בלי
        // תנאי הוא בדיוק הקוד שיצר את החור.
        Assert.DoesNotMatch(new Regex(@"if \(!isNew\)\s*\n?\s*return;"), code);
    }

    // ⚠️ הריגת הסוכן ו-Mosquitto יחד עם הטריי הייתה מייצרת נתק מיותר
    // באתר שאולי דיווח כל הזמן. המופע החדש ימצא אותם וישגיח עליהם.
    [Fact]
    public void OnlyTheTrayIsKilled()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string takeover = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Services", "TrayTakeover.cs"));
        string code = string.Join("\n",
            takeover.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        Assert.Contains("GetProcessesByName(TrayProcessName)", code);
        Assert.DoesNotContain("Kill(entireProcessTree: true)", code);
        // הסוכן נקרא רק כדי **לשאול** אם הוא חי, לא כדי להרוג אותו.
        Assert.DoesNotContain("GetProcessesByName(AgentProcessName)\n            {", code);
    }
}
