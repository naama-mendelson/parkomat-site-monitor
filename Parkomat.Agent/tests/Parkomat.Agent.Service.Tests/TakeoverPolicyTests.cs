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

    // ============================================================
    // ⚠️ וגם ההשתלטות עצמה אסור לה להיכשל בשקט
    // ============================================================
    // ההריגה עלולה לא להצליח — תהליך תקוע בדרייבר, חוסר הרשאה. אם אז
    // יוצאים בשקט, האתר חוזר **בדיוק** למוות השקט שהקוד הזה נועד למנוע:
    // המשימה מגיעה כל חמש דקות, נחסמת, ויוצאת. לנצח, בלי סימן בשום מקום.
    [Fact]
    public void AFailedTakeoverIsRecorded()
    {
        // ⚠️ **הקטע נחתך בשני קצוות, ולא רק בהתחלה.** הגרסה הראשונה של
        // השער הזה חיפשה `LogFatal` מנקודת ההמתנה ועד סוף הקובץ — ומצאה
        // אותו במטפל החריגות הגלובלי שמתחת. מוטציה שהסירה את הרישום
        // **עברה ירוקה**. זו בדיוק אותה טעות שכבר תועדה כאן פעמיים:
        // עוגן שתופס משהו אחר שנראה נכון.
        string block = TakeoverBlock();
        Assert.Contains("LogFatal", block);
    }

    // ⚠️ **וההמתנה חייבת להיקרא, לא רק להתקיים.** מוטציה שהחליפה את
    // הקריאה ב-`new Mutex` ישיר השאירה את הפונקציה על מקומה — ועברה
    // ירוקה. קוד מת שנראה בדיוק כמו קוד עובד; אותו כשל בדיוק שתועד
    // ב-`ReportAutoStartHealth`.
    [Fact]
    public void TheMutexIsWaitedForRatherThanCheckedOnce()
    {
        Assert.Contains("WaitForSingleInstance(out isNew)", TakeoverBlock());

        string code = TrayProgram();
        int fn = code.IndexOf("static Mutex WaitForSingleInstance", StringComparison.Ordinal);
        Assert.True(fn >= 0, "אין פונקציית המתנה");

        // הלולאה וההשהיה הן ההמתנה עצמה. בלעדיהן זו בדיקה יחידה בשם אחר.
        string body = code[fn..Math.Min(code.Length, fn + 500)];
        Assert.Contains("for (", body);
        Assert.Contains("Thread.Sleep", body);
    }

    // ⚠️ הקטע שבין ההמתנה ל-Mutex לבין המשך העלייה הרגילה — כלומר בדיוק
    // הענף של "ההשתלטות נכשלה". `using var owned` הוא הגבול העליון, וכל
    // מה שמעבר לו שייך לעלייה תקינה ואינו רלוונטי לשער הזה.
    private static string TakeoverBlock()
    {
        string code = TrayProgram();
        int from = code.IndexOf("single = WaitForSingleInstance", StringComparison.Ordinal);
        Assert.True(from >= 0, "הקריאה להמתנה איננה — ההשתלטות אינה ממתינה ל-Mutex");
        int to = code.IndexOf("using var owned", from, StringComparison.Ordinal);
        Assert.True(to > from, "לא נמצא סוף הענף");
        return code[from..to];
    }

    // קורא את `Program.cs` בלי שורות הערה — הערה שמסבירה מנגנון הייתה
    // צובעת את השערים שלמעלה ירוקים בלי שהמנגנון קיים.
    private static string TrayProgram()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string prog = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Program.cs"));
        return string.Join("\n",
            prog.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));
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
