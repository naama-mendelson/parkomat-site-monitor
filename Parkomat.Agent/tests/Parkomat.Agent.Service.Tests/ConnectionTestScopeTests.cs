using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>חלון "בדוק חיבור" בדק את מה שאינו רלוונטי, ולא את מה שכן.</b>
///
/// <para>הוא הריץ PLC ו-HiveMQ בלבד, ו-HiveMQ **תמיד** — גם באתר שכובה
/// ממנו בכוונה. שם התוצאה הייתה לנצח "החיבור ל-HiveMQ נכשל", וזו אזהרה
/// שקרית: היא שולחת טכנאי לתקן ברוקר תקין. אותו נימוק בדיוק שבגללו שלב
/// הברוקר ב-<c>Worker</c> מדולג במקום לזרוק.</para>
///
/// <para>⚠️ <b>ובמקביל לא הייתה שום בדיקה למסלול הישיר</b> — כלומר באתר
/// ישיר-בלבד המסך היה אדום על הדבר שאינו בשימוש, ושותק לגמרי על הדבר
/// היחיד שקובע אם האתר מדווח.</para>
/// </summary>
public class ConnectionTestScopeTests
{
    private static string Read(params string[] parts)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string src = File.ReadAllText(
            Path.Combine(new[] { dir!.FullName, "src" }.Concat(parts).ToArray()));

        // ⚠️ שורות הערה מוסרות: ההערות שם מסבירות את המנגנון כמעט
        // במילות הקוד, והיו צובעות כל שער כאן ירוק בלי שהוא קיים.
        return string.Join("\n",
            src.Split('\n').Select(l => l.TrimEnd('\r'))
               .Where(l => !l.TrimStart().StartsWith("//") && !l.TrimStart().StartsWith("///")));
    }

    private static string Form() =>
        Read("Parkomat.Agent.Tray", "Forms", "StatusForm.cs");

    private static string Tester() =>
        Read("Parkomat.Agent.Tray", "Services", "ConnectionTester.cs");

    // ============================================================
    // ⚠️ HiveMQ נבדק רק כשהוא בשימוש
    // ============================================================
    [Fact]
    public void HiveMqIsNotTestedAtASiteThatSwitchedItOff()
    {
        string code = Form();

        // הבדיקה מותנית — ולא נקראת ישירות.
        Assert.Matches(new Regex(@"config\.MqttEnabled[\s\S]{0,200}?TestHiveMqAsync"), code);

        // ⚠️ **והתנאי הוא `MqttEnabled` ולא `Mqtt.Disabled`.** הנגזרת
        // היא שמגינה: אתר בלי סיסמת Supabase נשאר על MQTT יהיה מה
        // שכתוב בקובץ, ובדיקה לפי הדגל הגולמי הייתה מדלגת דווקא באתר
        // שכן תלוי בברוקר.
        Assert.DoesNotMatch(new Regex(@"config\.Mqtt\.Disabled"), code);
    }

    // ⚠️ "מדולג" אינו "נכשל" ואינו "הצליח". תווית ירוקה על בדיקה שלא
    // רצה היא שקר, ואדומה שולחת לתקן משהו תקין.
    [Fact]
    public void ASkippedCheckGetsItsOwnColour()
    {
        string code = Form();

        // ⚠️ **בתוך `SetSkipped`, לא איפשהו בקובץ.** הגרסה הראשונה בדקה
        // ש-`SetNeutral` מופיע — והוא מופיע גם ב**הגדרה** שלו עצמו,
        // ולכן מוטציה שהחליפה את הקריאה ב-`SetResult(target, true, ...)`
        // עברה ירוקה. זו הפעם השישית היום שעוגן תופס הגדרה במקום שימוש.
        int i = code.IndexOf("static Task SetSkipped", StringComparison.Ordinal);
        Assert.True(i >= 0, "SetSkipped איננה");

        // ⚠️ **חלון קצר, לגוף המתודה בלבד.** חיתוך עד ה-`private static`
        // הבא בלע גם את `ShowWhenDone` — שמכילה `SetResult` בצדק גמור —
        // והשער נפל על קוד תקין. גבול שנשען על "המתודה הבאה" שביר בדיוק
        // כמו עוגן שתופס הגדרה במקום שימוש.
        string body = code[i..Math.Min(code.Length, i + 200)];
        Assert.Contains("SetNeutral(", body);
        Assert.DoesNotContain("SetResult(", body);
    }

    // ============================================================
    // ⚠️ והמסלול הישיר **כן** נבדק
    // ============================================================
    [Fact]
    public void TheDirectPathIsActuallyTested()
    {
        Assert.Contains("TestSupabaseAsync", Tester());

        string code = Form();
        // ⚠️ הקריאה, לא רק הקיום — מדיניות שאיש אינו קורא לה נראית
        // בדיוק כמו מדיניות שעובדת. אותה מוטציה שעברה בשקט היום
        // בארבעה מקומות אחרים.
        Assert.Matches(new Regex(@"ConnectionTester\.TestSupabaseAsync\("), code);
        Assert.Matches(new Regex(@"_supaResult"), code);
    }

    // ⚠️ **בדיקה שאינה כותבת דבר.** היא חייבת להיות בטוחה ללחיצה
    // חוזרת: כתיבת שורה אמיתית מהטריי הייתה מזהמת נתוני לקוח בכל
    // "בדוק שוב". הזדהות לבדה מוכיחה את כל השרשרת שמעניינת.
    [Fact]
    public void TheDirectTestNeverWrites()
    {
        string code = Tester();
        int i = code.IndexOf("TestSupabaseAsync", StringComparison.Ordinal);
        Assert.True(i >= 0);

        string body = code[i..Math.Min(code.Length, i + 2500)];
        Assert.Contains("grant_type=password", body);
        Assert.DoesNotContain("ingest_batch", body);
        Assert.DoesNotContain("/rest/v1/", body);
    }

    // ⚠️ ומסלול כבוי נאמר במפורש ולא כ"נכשל": אתר שלא הוזנה בו סיסמה
    // אינו תקול — הוא פשוט לא הופעל, וזו תשובה אחרת לגמרי לטכנאי.
    [Fact]
    public void AnUnconfiguredDirectPathSaysSoInsteadOfFailing()
    {
        string code = Tester();
        int i = code.IndexOf("TestSupabaseAsync", StringComparison.Ordinal);
        string body = code[i..Math.Min(code.Length, i + 900)];

        Assert.Matches(new Regex(@"!sb\.Enabled"), body);
        Assert.Contains("סיסמת Supabase", body);
    }
}
