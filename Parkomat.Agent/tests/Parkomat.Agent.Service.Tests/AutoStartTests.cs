using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ההפעלה האוטומטית — <b>שני</b> מנגנונים, ולא אחד.
///
/// <para>⚠️ <b>נמדד באתר 1089 ב-09/09/2026, מיומני האירועים של Windows:</b>
/// שני אירועי 1074 (הפעלה מחדש יזומה) בהפרש שלוש דקות, 02:59 ו-03:04 —
/// חתימת עדכון Windows. המשתמש היה מחובר (<c>query user</c> → Active
/// מ-03:04), הערך ב-<c>Run</c> היה קיים ותקין, <b>והטריי לא עלה חמש
/// שעות.</b></para>
///
/// <para>⚠️ באתחול של עדכון, Windows מחזירה את המשתמש לסשן כדי לסיים את
/// העדכון — אבל רצף העלייה של אפליקציות המשתמש לא מתבצע כרגיל. התוצאה:
/// <b>אתר מת לגמרי אחרי כל עדכון, עד שמישהו מגיע פיזית.</b> פעם בחודש,
/// ב-21 אתרים, בשעות הלילה.</para>
///
/// <para>משימה מתוזמנת מופעלת ע"י שירות Task Scheduler, שאינו תלוי ברצף
/// הזה. <b>שני המנגנונים נשארים</b>: <c>Run</c> מרים מיד בכניסה רגילה,
/// והמשימה תופסת את המקרים שהוא מפספס.</para>
/// </summary>
public class AutoStartTests
{
    private static string Installer()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "installer.iss")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!.FullName, "installer.iss"));
    }

    // ⚠️ שורות הערה מוסרות. השער הזה מחפש **הוראות** במתקין, והערה
    // שמסבירה את המנגנון הייתה צובעת אותו ירוק בלי שהמנגנון קיים —
    // טעות שנעשתה כבר שלוש פעמים בשערים אחרים בפרויקט הזה.
    private static string Code() =>
        string.Join("\n", Installer().Split('\n').Where(l => !l.TrimStart().StartsWith(";")));

    [Fact]
    public void TheRunKeyIsStillThere()
    {
        // ⚠️ המשימה **מוסיפה** ואינה מחליפה: בכניסה רגילה `Run` מרים
        // מיד, בעוד שהמשימה עלולה להמתין עד חמש דקות. הסרתו הייתה
        // מחליפה כשל נדיר בהשהיה יומיומית.
        Assert.Matches(new Regex(@"ValueName:\s*""ParkomatAgentTray"""), Code());
    }

    // ============================================================
    // ⚠️ המשימה מוגדרת בקוד, אחרי שהמתקין יצר אותה שבורה בשקט
    // ============================================================
    // נמדד ב-09/09/2026 מול Task Scheduler אמיתי, ולא הוסק מקריאה:
    // `schtasks /Create /SC ONLOGON` מחזיר **Access is denied** למשתמש
    // שאינו מנהל — בכל ארבע הווריאציות שנוסו (`/RU user`, `/RU domain\\user`,
    // `/IT`, וללא). ההתקנה הזו היא PrivilegesRequired=lowest בכוונה,
    // והפקודה רצה `runhidden` בלי בדיקת שגיאה: ההתקנה הייתה מדווחת
    // הצלחה, והמשימה לא הייתה נוצרת **באף אתר**.
    [Fact]
    public void TheInstallerNoLongerCreatesTheTask()
    {
        Assert.DoesNotMatch(new Regex(@"schtasks\.exe""[^\n]*/Create"), Code());
    }

    // ⚠️ אבל המחיקה בהסרה נשארת: היא עובדת בלי מנהל (מוחקים משימה של
    // עצמך), ובלעדיה הסרה משאירה משימה שמריצה קובץ שנמחק, לנצח.
    [Fact]
    public void TheTaskIsRemovedOnUninstall()
    {
        Assert.Matches(new Regex(@"/Delete\s+/TN\s+""""ParkomatAgentKeepAlive"""""), Code());
    }

    // ⚠️ **ומשימה אחת עם שני מפעילים, לא שתי משימות.** `schtasks` אינו
    // יודע לתת שני מפעילים למשימה אחת, ולכן הניסיון הקודם היה שתי
    // משימות — והשנייה היא זו שנדחתה בהרשאות.
    [Fact]
    public void OneTaskCarriesBothTriggers()
    {
        string xml = Xml();
        Assert.Contains("<LogonTrigger>", xml);
        Assert.Contains("<TimeTrigger>", xml);
        Assert.Contains("<Interval>PT5M</Interval>", xml);
    }

    // ============================================================
    // ⚠️ שלוש ברירות מחדל של schtasks שמשביתות את המשימה בשקט
    // ============================================================
    // כולן נקראו מה-XML ש-schtasks עצמו ייצר, לא שוערו.

    // מחשב אתר על UPS מדווח "סוללה". עם ברירת המחדל המשימה **אינה רצה
    // כלל** — בדיוק באוכלוסיית האתרים שהמנגנון נבנה בשבילה, ובדיוק
    // בזמן הפסקת חשמל, שהיא האירוע שהתחיל את כל העבודה הזו.
    [Fact]
    public void BatteriesDoNotStopIt()
    {
        string xml = Xml();
        Assert.Contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", xml);
        Assert.Contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", xml);
    }

    // ⚠️ **זו החמורה מכולן.** המשימה נחשבת "רצה" כל עוד הטריי שהיא
    // הפעילה חי. עם `IgnoreNew`, טריי **תקוע** משאיר אותה רצה לנצח, כל
    // הפעלה הבאה נבלעת, ו-`TakeoverPolicy` לעולם אינו מקבל הזדמנות —
    // כלומר ברירת המחדל הזו מבטלת בשקט את כל המנגנון שנבנה מעליה.
    [Fact]
    public void EveryFiveMinutesActuallyRunsAgain()
    {
        Assert.Contains("<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>", Xml());
    }

    // בלי זה הטריי נהרג אחרי 72 שעות ע"י Task Scheduler עצמו.
    [Fact]
    public void TheTrayIsNotKilledAfterThreeDays()
    {
        Assert.Contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", Xml());
    }

    // ⚠️ **וההגדרה חייבת להיכתב, לא רק להתקיים.** מדיניות טהורה שאיש
    // אינו קורא לה נראית בדיוק כמו מדיניות שעובדת — אותה מוטציה שעברה
    // בשקט ב-`ReportAutoStartHealth` וב-`WaitForSingleInstance`.
    [Fact]
    public void TheTaskIsWrittenOnEveryTrayStart()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string prog = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Program.cs"));
        string code = string.Join("\n",
            prog.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        Assert.Matches(new Regex(@"^\s*KeepAliveTask\.Ensure\(\);", RegexOptions.Multiline), code);
    }

    // ה-XML נבנה מהמקור עצמו, כדי שהשערים למעלה יבדקו את מה שנשלח
    // ל-Task Scheduler ולא ניסוח שנכתב בבדיקה.
    private static string Xml()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string src = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Services", "KeepAliveTask.cs"));

        // ⚠️ רק גוף ה-XML, לא ההערות מעליו: הערה שמזכירה `Parallel` הייתה
        // צובעת את השער ירוק בלי שהערך קיים ב-XML. אותה טעות בדיוק כבר
        // נעשתה בשערים אחרים בפרויקט הזה.
        int i = src.IndexOf("<?xml", StringComparison.Ordinal);
        Assert.True(i >= 0, "לא נמצא ה-XML");
        int j = src.IndexOf("</Task>", i, StringComparison.Ordinal);
        Assert.True(j > i, "ה-XML אינו שלם");
        return src[i..j];
    }

    // ============================================================
    // ⚠️ והבדיקה חייבת להיקרא, לא רק להתקיים
    // ============================================================
    // מוטציה שהסירה את `ReportAutoStartHealth()` מעליית ה-Worker **עברה
    // בשקט**: כל בדיקות ההערכה נשארו ירוקות, כי הן בודקות פונקציה טהורה
    // שאיש כבר לא קורא לה. קוד מת שנראה בדיוק כמו קוד עובד.
    [Fact]
    public void TheHealthCheckIsActuallyCalledAtStartup()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string worker = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Worker.cs"));
        // ⚠️ שורות הערה מוסרות: הערה שמסבירה את הקריאה הייתה צובעת את
        // הבדיקה ירוקה בלי שהקריאה קיימת — טעות שנעשתה כבר שלוש פעמים
        // בשערים אחרים בפרויקט הזה.
        string code = string.Join("\n",
            worker.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        Assert.Matches(new Regex(@"^\s*ReportAutoStartHealth\(\);", RegexOptions.Multiline), code);
    }

    [Fact]
    public void RepeatedStartsAreHarmless()
    {
        // ⚠️ **המשימה בטוחה רק בזכות המאפיין הזה.** בלי ה-Mutex היא
        // הייתה מייצרת טריי חדש כל חמש דקות — עשרות תהליכים ביום, כל
        // אחד מנסה להשגיח על הסוכן ועל Mosquitto.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string tray = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Program.cs"));
        Assert.Matches(new Regex(@"new Mutex\("), tray);
        Assert.Matches(new Regex(@"Parkomat\.Agent\.Tray\.SingleInstance"), tray);
    }
}
