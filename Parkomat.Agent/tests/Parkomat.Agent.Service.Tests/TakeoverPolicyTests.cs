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

    // טריי שרץ מזמן — כלומר היה לו זמן לתקן ולא תיקן.
    private static long Mature => Threshold + 60;

    // ------------------------------------------------------------
    // המצב התקין — ולא נוגעים בו
    // ------------------------------------------------------------
    [Fact]
    public void AHealthyTrayIsLeftAlone()
    {
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(agentProcessAlive: true, livenessAgeSeconds: 2, Poll, Mature));
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
            TakeoverPolicy.Decide(false, Wedged + 1, Poll, Mature));
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
            TakeoverPolicy.Decide(agentProcessAlive: false, Threshold + 1, Poll, Mature));
    }

    // ⚠️ והסוכן חי אבל הלולאה עומדת, והטריי לא הרג אותו — אותה מסקנה.
    // בלי המקרה הזה, סוכן תקוע (לא מת) היה נשאר תקוע לנצח: התהליך קיים,
    // אז שום דבר לא נראה חסר.
    [Fact]
    public void AWedgedAgentThatWasNotKilledMeansTheSame()
    {
        Assert.Equal(TakeoverPolicy.Action.TakeOver,
            TakeoverPolicy.Decide(agentProcessAlive: true, Threshold + 1, Poll, Mature));
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
            TakeoverPolicy.Decide(false, null, Poll, Mature));
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(true, null, Poll, Mature));
    }

    // ⚠️ גיל שלילי = שעון שקפץ אחורה (NTP, אזור זמן) והקובץ נראה מהעתיד.
    // הריגת טריי תקין בגלל תיקון שעון היא מלכודת מוכרת בפרויקט הזה.
    [Theory]
    [InlineData(-1)]
    [InlineData(-100000)]
    public void AClockThatWentBackwardsDoesNotKillAnything(long age)
    {
        Assert.Equal(TakeoverPolicy.Action.Exit, TakeoverPolicy.Decide(false, age, Poll, Mature));
        Assert.Equal(TakeoverPolicy.Action.Exit, TakeoverPolicy.Decide(true, age, Poll, Mature));
    }

    // ============================================================
    // ⚠️ מרוץ האתחול — הבאג שהיה קורה בכל עלייה של כל אתר
    // ============================================================
    // קובץ החיוּת נמחק **רק בכיבוי יזום** מהתפריט. הפסקת חשמל ואתחול
    // Windows משאירים אותו עם חותם ישן, ולכן מיד אחרי עלייה גילו הוא
    // משך ההשבתה — שעות. ובאותו רגע עולים שני טריי: מפתח `Run` מרים
    // אחד, והמפעיל בכניסה של המשימה מרים שני.
    //
    // בלי השומר, השני היה רואה "הסוכן אינו רץ וקובץ החיוּת בן שעות"
    // ומשתלט — כלומר הורג את הטריי שברגע זה מפעיל את הסוכן. בכל אתחול.
    [Fact]
    public void TheBootRaceDoesNotKillTheTrayThatIsStartingTheAgent()
    {
        const long outageHours = 4 * 60 * 60;   // המכונה הייתה כבויה ארבע שעות

        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(agentProcessAlive: false, outageHours, Poll,
                                  existingTrayAgeSeconds: 2));
    }

    // ואותו דבר גם כשהסוכן כבר עלה אבל טרם כתב את הסבב הראשון.
    [Fact]
    public void ATrayThatJustStartedIsGivenTheSameTimeWeJudgeTheAgentBy()
    {
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(true, Threshold + 1, Poll, Threshold - 1));

        // ורגע אחרי הסף — כן משתלטים, אחרת השומר היה חוסם לנצח.
        Assert.Equal(TakeoverPolicy.Action.TakeOver,
            TakeoverPolicy.Decide(true, Threshold + 1, Poll, Threshold + 1));
    }

    // ⚠️ וגיל לא ידוע ⇒ לא משתלטים. אותו נכשל-סגור כמו בהיעדר קובץ
    // חיוּת: החלטה להרוג טריי חייבת להישען על ידיעה.
    [Fact]
    public void AnUnknownTrayAgeMeansNoTakeover()
    {
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(false, Threshold + 1, Poll, existingTrayAgeSeconds: null));
    }

    // ============================================================
    // ⚠️ בחירת הטריי הקיים — שלוש מוטציות עברו כאן ירוקות
    // ============================================================
    // ההיגיון ישב בשכבת ה-I/O, שאין לה ולא יכולה להיות לה בדיקה
    // התנהגותית. הוצא החוצה כפונקציה טהורה, וכל טענה בו נבדקת.
    private static readonly DateTime Now = new(2026, 9, 9, 12, 0, 0, DateTimeKind.Local);

    // ⚠️ הוותיק ולא הצעיר: השאלה היא האם **מישהו** כבר היה כאן מספיק
    // זמן כדי לתקן. בחירת הצעיר הייתה חוסמת השתלטות לנצח בכל פעם
    // שמופע חדש עולה לידו.
    [Fact]
    public void TheOldestProcessWinsNotTheYoungest()
    {
        var procs = new[]
        {
            (Id: 100, StartedAt: Now.AddSeconds(-5)),
            (Id: 200, StartedAt: Now.AddSeconds(-3600)),
            (Id: 300, StartedAt: Now.AddSeconds(-60)),
        };

        Assert.Equal(3600, TakeoverPolicy.OldestOtherAgeSeconds(procs, selfId: 999, Now));
    }

    // ⚠️ התהליך הקורא נושא את אותו שם וגילו אפס. בלי ההחרגה כל בדיקה
    // הייתה מסתיימת ב"טריי צעיר", וההשתלטות לא הייתה קורית לעולם.
    [Fact]
    public void WeAreNeverOurOwnExistingTray()
    {
        var procs = new[] { (Id: 42, StartedAt: Now.AddSeconds(-7200)) };

        Assert.Null(TakeoverPolicy.OldestOtherAgeSeconds(procs, selfId: 42, Now));
    }

    [Fact]
    public void NoOtherProcessMeansUnknown()
    {
        Assert.Null(TakeoverPolicy.OldestOtherAgeSeconds([], selfId: 1, Now));
    }

    // ⚠️ ותהליך "מהעתיד" (שעון שקפץ) נותן גיל שלילי — קטן מהסף, ולכן
    // מוביל ליציאה. נכשל-סגור, בלי ענף נפרד.
    [Fact]
    public void AProcessFromTheFutureDoesNotTriggerATakeover()
    {
        var procs = new[] { (Id: 7, StartedAt: Now.AddSeconds(3600)) };
        long? age = TakeoverPolicy.OldestOtherAgeSeconds(procs, selfId: 1, Now);

        Assert.NotNull(age);
        Assert.True(age < 0);
        Assert.Equal(TakeoverPolicy.Action.Exit,
            TakeoverPolicy.Decide(false, Threshold + 1, Poll, age));
    }

    // ⚠️ **והגיל חייב להגיע להחלטה.** מוטציה שהחליפה את הקריאה בקבוע
    // עברה ירוקה — פונקציה טהורה שאיש אינו מזין לה את הערך האמיתי
    // נראית בדיוק כמו כזו שעובדת.
    [Fact]
    public void TheRealTrayAgeIsWhatReachesTheDecision()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string src = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Services", "TrayTakeover.cs"));
        string code = string.Join("\n",
            src.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        // ⚠️ **אתר הקריאה, לא ההגדרה.** הגרסה הראשונה של השער חיפשה את
        // השם `OldestOtherTrayAgeSeconds()` — והוא מופיע בהגדרת הפונקציה
        // עצמה, ולכן מוטציה שהחליפה את הקריאה בקבוע עברה ירוקה. זו הפעם
        // השלישית היום שעוגן תופס הגדרה במקום שימוש.
        Assert.Contains("trayAge = OldestOtherTrayAgeSeconds()", code);
        Assert.Contains("TakeoverPolicy.Decide(agentAlive, age, poll, trayAge)", code);

        // ואיסוף התהליכים חייב באמת לאסוף: לולאה עם גוף ריק משאירה את
        // הקריאה ל-GetProcessesByName במקומה ואינה עושה דבר.
        Assert.Contains("Process.GetProcessesByName(TrayProcessName)", code);
        Assert.Contains("found.Add((p.Id, p.StartTime))", code);
        Assert.Contains("TakeoverPolicy.OldestOtherAgeSeconds(", code);
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
