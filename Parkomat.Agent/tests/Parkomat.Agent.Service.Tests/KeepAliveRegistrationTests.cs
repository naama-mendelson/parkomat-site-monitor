using System.Diagnostics;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>הרישום עצמו — מול Task Scheduler אמיתי, לא מול מחרוזת.</b>
///
/// <para>כל שאר השערים על המשימה בודקים את ה-XML כטקסט. הם לא היו תופסים
/// כלום מהדברים שבאמת מכשילים רישום: קידוד קובץ שמשבש את הטקסט העברי,
/// ארגומנט שלא עבר נכון, או קוד יציאה שאיש לא בדק.
/// זה בדיוק סוג הכשל שכבר עלה כאן פעם אחת — <c>/SC ONLOGON</c> החזיר
/// <c>Access is denied</c>, והפקודה רצה <c>runhidden</c> בלי לבדוק, ולכן
/// "ההתקנה הצליחה" בעוד המשימה לא נוצרה מעולם.</para>
///
/// <para>⚠️ <b>ושם המשימה כאן זמני ובכוונה.</b> הבדיקה לא נוגעת במשימה
/// האמיתית — היא רושמת שם משלה, קוראת בחזרה, ומוחקת. אחרת הרצת בדיקות על
/// מחשב מותקן הייתה מפילה את המשימה של אותו מחשב על נתיב ה-testhost.</para>
/// </summary>
public class KeepAliveRegistrationTests : IDisposable
{
    private const string ProbeTask = "ParkomatKeepAliveSelfTest";

    public KeepAliveRegistrationTests() => Delete();
    public void Dispose() => Delete();

    private static void Delete() => Run("/Delete", "/TN", ProbeTask, "/F");

    private static (int code, string output) Run(params string[] args)
    {
        var psi = new ProcessStartInfo(
            Path.Combine(Environment.SystemDirectory, "schtasks.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string a in args) psi.ArgumentList.Add(a);

        using Process p = Process.Start(psi)!;
        string o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit(30000);
        return (p.ExitCode, o);
    }

    /// <summary>
    /// הטענה המרכזית: הקוד שנשלח לאתרים באמת יוצר משימה — בלי הרשאות
    /// מנהל, שזו כל הסיבה שהוא נכתב מחדש.
    /// </summary>
    [Fact]
    public void TheRegistrationActuallyCreatesATask()
    {
        Assert.True(Parkomat.Agent.Tray.KeepAliveTask.Register(ProbeTask),
            "הרישום נכשל — schtasks לא החזיר 0");

        (int code, string xml) = Run("/Query", "/TN", ProbeTask, "/XML");
        Assert.Equal(0, code);

        // ⚠️ נקרא **מה-Scheduler**, לא מהקובץ שנכתב: מה שנשלח ומה שנשמר
        // אינם בהכרח זהים, ורק מה שנשמר הוא מה שירוץ באתר.
        Assert.Contains("<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>", xml);
        Assert.Contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", xml);
        Assert.Contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", xml);
        Assert.Contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", xml);
        Assert.Contains("<StartWhenAvailable>true</StartWhenAvailable>", xml);
        Assert.Contains("<LogonTrigger>", xml);
        Assert.Contains("<TimeTrigger>", xml);
        Assert.Contains("<Interval>PT5M</Interval>", xml);
    }

    /// <summary>
    /// ⚠️ <b>הרצה חוזרת חייבת להצליח.</b> הרישום קורה בכל עליית טריי, ולכן
    /// משימה שכבר קיימת היא המצב הרגיל ולא חריג. בלי <c>/F</c> הקריאה
    /// השנייה נכשלת — ואז "מתקנת את עצמה" הופך ל"עובד רק בהתקנה נקייה".
    /// </summary>
    [Fact]
    public void RegisteringTwiceIsNotAnError()
    {
        Assert.True(Parkomat.Agent.Tray.KeepAliveTask.Register(ProbeTask));
        Assert.True(Parkomat.Agent.Tray.KeepAliveTask.Register(ProbeTask));
    }

    /// <summary>
    /// ⚠️ <b>והכשל חייב להיות ניתן לזיהוי.</b> שם משימה פסול נדחה ע"י
    /// schtasks; אם <c>Register</c> הייתה מחזירה <c>true</c> בכל מקרה, כל
    /// השערים למעלה היו ירוקים גם על רישום שלא קרה — וזה בדיוק הכשל
    /// המקורי, רק בשכבה אחרת.
    /// </summary>
    [Fact]
    public void AFailedRegistrationIsReportedAsFailure()
    {
        Assert.False(Parkomat.Agent.Tray.KeepAliveTask.Register("bad\\name/with:chars"));
    }

    /// <summary>
    /// ⚠️ <b>הטקסט העברי חייב לשרוד את הדרך ל-Task Scheduler.</b>
    ///
    /// <para>מוטציה שהחליפה את הכתיבה ל-UTF-8 <b>עברה ירוקה</b>, וזה גילה
    /// ששני דברים שהנחתי אינם נכונים: <c>schtasks</c> כן בולע קובץ UTF-8,
    /// והשערים שבדקו רק תגיות אנגליות לא ראו הבדל. אבל ה-XML מכריז
    /// <c>encoding="UTF-16"</c>, ולכן בייטים בקידוד אחר משנים את הטקסט
    /// העברי — וזה הדבר היחיד בקובץ שאפשר להבחין בו.</para>
    /// </summary>
    [Fact]
    public void TheHebrewDescriptionSurvives()
    {
        Assert.True(Parkomat.Agent.Tray.KeepAliveTask.Register(ProbeTask));

        (int code, string xml) = Run("/Query", "/TN", ProbeTask, "/XML");
        Assert.Equal(0, code);
        Assert.Contains("מרים את Parkomat Agent Tray בכניסה וכל חמש דקות", xml);
    }

    /// <summary>
    /// ⚠️ <b>והרישום ברקע חייב באמת לרשום.</b> מוטציה שהשאירה את ה-thread
    /// ריק עברה ירוקה — כי הבדיקה מדדה רק שהקריאה חוזרת מהר. thread שאינו
    /// עושה דבר חוזר מהר מאוד. אותו כשל בדיוק שכבר תועד פעמיים היום.
    /// </summary>
    [Fact]
    public void EnsureActuallyRegistersInTheBackground()
    {
        Parkomat.Agent.Tray.KeepAliveTask.Ensure(ProbeTask);

        bool created = false;
        for (int i = 0; i < 60 && !created; i++)
        {
            Thread.Sleep(250);
            created = Run("/Query", "/TN", ProbeTask).code == 0;
        }

        Assert.True(created, "Ensure חזרה — אבל המשימה לא נוצרה מעולם");
    }

    /// <summary>
    /// ⚠️ <b>ואינו חוסם את עליית הטריי.</b> הוא יושב על מסלול העלייה,
    /// ו-<c>schtasks</c> תקוע היה מונע מהאייקון להופיע — מנגנון שנועד
    /// להחזיר אתר לחיים שמונע ממנו לעלות.
    ///
    /// <para>⚠️ <b>והטענה נבדקת במבנה ולא בשעון.</b> מדידת זמן עברה על
    /// גרסה חוסמת, פשוט מפני ש-<c>schtasks</c> מהיר במעבדה — סף זמן כאן
    /// היה בדיקה שתלויה במהירות המכונה, כלומר בדיקה שמאשרת ולא בודקת.</para>
    /// </summary>
    [Fact]
    public void TheRegistrationDoesNotRunOnTheCallingThread()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string src = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Tray", "Services", "KeepAliveTask.cs"));
        string code = string.Join("\n",
            src.Split('\n').Where(l => !l.TrimStart().StartsWith("///")));

        int i = code.IndexOf("static void Ensure(", StringComparison.Ordinal);
        Assert.True(i >= 0, "Ensure איננה");
        int j = code.IndexOf("static bool Register(", i, StringComparison.Ordinal);
        Assert.True(j > i, "לא נמצא סוף הגוף");

        string body = code[i..j];
        Assert.Contains("new Thread(", body);
        Assert.Contains("IsBackground = true", body);
        Assert.Contains("Start()", body);
    }
}
