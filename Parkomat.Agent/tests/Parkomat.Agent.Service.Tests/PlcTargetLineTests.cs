using System.Text.RegularExpressions;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>השורה הזו שיקרה באתר אמיתי, ב-10/09/2026.</b>
///
/// <para>היא הודפסה כך:</para>
/// <code>PLC target: UDP 03:192.168.0.250 | FC=0x502</code>
///
/// <para>קוד הפונקציה (03) נחת במקום הכתובת, והפורט (502) נחת במקום קוד
/// הפונקציה — שני ארגומנטים במקום הלא נכון בקריאה ללוגר עם שמונה
/// ארגומנטים. <b>הקומפיילר אינו בודק התאמה בין מצייני מקום לארגומנטים</b>,
/// ולכן זה עבר בשקט.</para>
///
/// <para>⚠️ <b>ודווקא כאן זה מסוכן.</b> תעבורה שגויה או פקודת קריאה שגויה
/// נכשלות <b>בדיוק כמו כתובת שגויה</b> — timeout, בלי רמז. השורה הזו היא
/// התשובה היחידה לשאלה "מה הסוכן מנסה לקרוא", והיא זו ששיקרה.</para>
/// </summary>
public class PlcTargetLineTests
{
    private static SiteConfig Config(string transport, int fc) => new()
    {
        SiteId = "1367",
        PollIntervalMs = 1000,
        Plc = new PlcConfig
        {
            IpAddress = "192.168.0.250",
            Port = 502,
            Transport = transport,
            FunctionCode = fc,
            ModeRegister = 106,
            CardRegister = 107,
            CycleRegister = 105,
        },
    };

    // ============================================================
    // ⚠️ המקרה שנצפה בשטח — מילה במילה
    // ============================================================
    [Fact]
    public void TheLineFromTheFieldIsFormattedCorrectly()
    {
        string line = PlcTargetLine.Format(Config("udp", 3));

        Assert.Equal(
            "PLC target: UDP 192.168.0.250:502 | FC=0x03 | "
            + "registers MODE=106 Card=107 Cycle=105 | poll=1000ms",
            line);
    }

    // ⚠️ **הכתובת והפורט צמודים, והפורט הוא מספר.** הבאג הופיע בדיוק
    // כאן: `03:192.168.0.250` — ערך שאינו כתובת, לפני נקודתיים.
    [Fact]
    public void TheAddressAndPortSitTogetherAndNothingElseDoes()
    {
        string line = PlcTargetLine.Format(Config("tcp", 4));

        Assert.Matches(new Regex(@"\b192\.168\.0\.250:502\b"), line);
        // הצורה השבורה: משהו קצר לפני נקודתיים ואחריו כתובת.
        Assert.DoesNotMatch(new Regex(@"\b0[34]:\d"), line);
    }

    // ⚠️ **קוד הפונקציה הוא 03 או 04 — לעולם לא פורט.** זו הצורה השנייה
    // של אותו באג: `FC=0x502`.
    [Theory]
    [InlineData(3, "FC=0x03")]
    [InlineData(4, "FC=0x04")]
    public void TheFunctionCodeIsTwoDigitsAndNeverAPort(int fc, string expected)
    {
        string line = PlcTargetLine.Format(Config("udp", fc));

        Assert.Contains(expected, line);
        Assert.DoesNotContain("FC=0x502", line);
        // ⚠️ בדיוק שתי ספרות: מי שמשווה מול modpoll מחפש "FC3"/"0x03",
        // וזה גם הניסוח בתיעוד של יצרני הבקרים.
        Assert.Matches(new Regex(@"FC=0x\d{2}\b"), line);
    }

    // ⚠️ והתעבורה — הדבר שאיפוס הגדרות מחזיר ל-TCP, ושכשלונו נראה
    // בלוג בדיוק כמו אתר TCP תקין.
    [Theory]
    [InlineData("udp", "UDP")]
    [InlineData("tcp", "TCP")]
    [InlineData("", "TCP")]          // ערך ריק נבלע ל-TCP — התנהגות מתועדת
    [InlineData("UDP ", "UDP")]      // trim + lowercase
    public void TheTransportIsNamedExplicitly(string configured, string shown)
    {
        string line = PlcTargetLine.Format(Config(configured, 4));
        Assert.Matches(new Regex($@"PLC target: {shown} "), line);
    }

    // ⚠️ **וכל שלושת הרגיסטרים מופיעים בשמם.** שלושה מספרים בלי תווית
    // הם שלוש הזדמנויות לקרוא את הלא נכון — וכאן בדיוק MODE ו-Cycle
    // אינם עוקבים (106 ו-105), כך שסדר שגוי נראה סביר לגמרי.
    [Fact]
    public void EveryRegisterIsLabelled()
    {
        string line = PlcTargetLine.Format(Config("udp", 3));

        Assert.Contains("MODE=106", line);
        Assert.Contains("Card=107", line);
        Assert.Contains("Cycle=105", line);
    }

    // ============================================================
    // ⚠️ והשורה חייבת להיות מנוסחת כאן — לא בתוך הלוגר
    // ============================================================
    // כל עוד היא הייתה מחרוזת עם שמונה ארגומנטים בתוך `LogInformation`,
    // לא הייתה שום דרך לבדוק אותה: הקומפיילר אינו מתאים ביניהם, ואף
    // בדיקה לא יכולה לקרוא את התוצאה.
    [Fact]
    public void TheWorkerLogsTheFormattedLineAndDoesNotRebuildIt()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string worker = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Worker.cs"));
        string code = string.Join("\n",
            worker.Split('\n').Select(l => l.TrimEnd('\r'))
                  .Where(l => !l.TrimStart().StartsWith("//")));

        Assert.Matches(new Regex(@"PlcTargetLine\.Format\(config\)"), code);
        // הצורה הישנה, עם מצייני המקום, אסור לה לחזור.
        Assert.DoesNotMatch(new Regex(@"""PLC target: \{Transport\}"), code);
    }
}
