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

    [Fact]
    public void AScheduledTaskAlsoStartsIt()
    {
        string code = Code();
        Assert.Matches(new Regex(@"schtasks\.exe"), code);
        Assert.Matches(new Regex(@"/Create\s+/TN\s+""""ParkomatAgentKeepAlive"""""), code);
    }

    [Fact]
    public void ItRepeatsRatherThanRunningOnceAtLogon()
    {
        // ⚠️ **זו כל הנקודה.** משימה שרצה רק בכניסה הייתה נכשלת בדיוק
        // באותו מצב שבו `Run` נכשל. הריצה החוזרת היא מה שמחזיר אתר
        // שהתאתחל בלי שאיש נכנס אליו, וגם תופסת קריסה באמצע היום.
        Assert.Matches(new Regex(@"/SC\s+MINUTE\s+/MO\s+5"), Code());
    }

    [Fact]
    public void TheTaskIsRemovedOnUninstall()
    {
        // ⚠️ בלי זה הסרה משאירה משימה שמנסה להריץ קובץ שנמחק, כל חמש
        // דקות, לנצח — ומייצרת שגיאה שאיש לא ידע לקשר לכלום.
        Assert.Matches(new Regex(@"/Delete\s+/TN\s+""""ParkomatAgentKeepAlive"""""), Code());
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
