using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>חלון "בדוק חיבור" בדק את מה שאינו רלוונטי, ולא את מה שכן.</b>
///
/// <para>הוא הריץ PLC ו-HiveMQ בלבד, ובמקביל לא הייתה שום בדיקה למסלול
/// הישיר — כלומר באתר ישיר-בלבד המסך היה אדום על הדבר שאינו בשימוש,
/// ושותק לגמרי על הדבר היחיד שקובע אם האתר מדווח.</para>
///
/// <para>⚠️ <b>1.0.57: HiveMQ יצא מהחלון לגמרי.</b> ‏master — הקורא היחיד
/// שלו — כבוי מ-17/09/2026. באתר 2431 (04/10) המסך הציג שגיאת DNS אדומה
/// על HiveMQ, ובדיקת Supabase נחתכה מתחתית החלון שגובהו היה קבוע.</para>
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
    // ⚠️ אין HiveMQ במסך — לא בדיקה, לא קבוצה, לא חבילה
    // ============================================================
    [Fact]
    public void HiveMqIsNoLongerTested()
    {
        string form = Form();
        Assert.DoesNotContain("TestHiveMqAsync", form);
        Assert.DoesNotContain("HiveMQ", form);

        string tester = Tester();
        Assert.DoesNotContain("TestHiveMqAsync", tester);
        Assert.DoesNotContain("MQTTnet", tester);
    }

    // ⚠️ **החבילה עצמה, לא רק הקוד.** חבילה שנשארה ב-csproj אחרי שהקוד
    // שהשתמש בה נמחק היא הזמנה להחזיר אותו "כי זה כבר שם".
    [Fact]
    public void TheTrayNoLongerShipsAnMqttClient()
    {
        string csproj = Read("Parkomat.Agent.Tray", "Parkomat.Agent.Tray.csproj");
        Assert.DoesNotMatch(new Regex(@"<PackageReference\s+Include=""MQTTnet"""), csproj);
    }

    // ============================================================
    // ⚠️ כל קבוצה נראית — החלון גדל לפי התוכן
    // ============================================================
    // הגובה היה קבוע (520×280) — מקום לשלוש קבוצות מתוך ארבע, והרביעית
    // הייתה בדיוק Supabase. הודעה שגולשת לשתי שורות הייתה חותכת שוב.
    [Fact]
    public void TheWindowSizesToItsContent()
    {
        string code = Form();
        Assert.DoesNotMatch(new Regex(@"\bClientSize\s*="), code);
        Assert.DoesNotMatch(new Regex(@"(?<![\w.])Size\s*=\s*new Size\(\s*\d+\s*,\s*[1-9]"), code);

        // ⚠️ **ברמת החלון — משפט שמסתיים ב-`;`.** בתוך מאתחל אובייקט
        // (`AutoSize = true,`) זה הפאנל, וחלון קבוע סביבו עדיין חותך.
        Assert.Matches(new Regex(@"(?m)^\s*AutoSize\s*=\s*true\s*;"), code);
        Assert.Matches(new Regex(@"(?m)^\s*AutoSizeMode\s*=\s*AutoSizeMode\.GrowAndShrink\s*;"), code);
    }

    // ⚠️ **מספר השורות בטבלה = מספר הקבוצות.** TableLayoutPanel עם
    // RowCount קטן ממספר הפקדים מוסיף שורות בעצמו או דוחס — וזו בדיוק
    // הדרך שבה קבוצה "קיימת בקוד" ואינה נראית.
    [Fact]
    public void EveryCheckGroupHasARow()
    {
        string code = Form();
        int groups = Regex.Matches(code, @"content\.Controls\.Add\(BuildCheckGroup\(").Count;
        Match rows = Regex.Match(code, @"RowCount\s*=\s*(\d+)");

        Assert.Equal(3, groups);
        Assert.True(rows.Success, "RowCount איננו");
        Assert.Equal(groups, int.Parse(rows.Groups[1].Value));
        Assert.Contains("BuildCheckGroup(\"דיווח לדשבורד (Supabase)\", _supaResult)", code);
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

    // ⚠️ **אדום, ולא "מדולג" — הפוך ממה שהיה כאן עד 1.0.56.** כשהיה
    // HiveMQ, אתר בלי סיסמה פשוט לא הפעיל מסלול נוסף. מאז ש-master כבוי
    // זה המסלול היחיד שמגיע לדשבורד: אתר בלי סיסמה אינו מדווח לשום מקום,
    // והטכנאי חייב לגלות את זה כשהוא עוד עומד באתר.
    [Fact]
    public void AnUnconfiguredDirectPathIsRedAndSaysWhy()
    {
        string code = Tester();
        int i = code.IndexOf("TestSupabaseAsync", StringComparison.Ordinal);
        string body = code[i..Math.Min(code.Length, i + 900)];

        Assert.Matches(new Regex(@"!sb\.Enabled\)[\s\S]{0,120}?Success\s*=\s*false"), body);
        Assert.Contains("סיסמת Supabase", body);
        Assert.Contains("אינו מדווח", body);
    }

    // ⚠️ **כשל רשת מוסבר, לא מועתק.** "The requested name is valid, but no
    // data of the requested type was found" (2431, 04/10) אינו אומר לטכנאי
    // מה לבדוק. הסיווג עצמו נבדק בהרצה ב-NetworkFailureTests; כאן — שהוא
    // אכן בשימוש, כי סיווג שאיש אינו קורא לו נראה בדיוק כמו סיווג שעובד.
    [Fact]
    public void ANetworkFailureIsExplainedNotCopied()
    {
        string code = Tester();
        int i = code.IndexOf("TestSupabaseAsync", StringComparison.Ordinal);
        string body = code[i..Math.Min(code.Length, i + 3500)];

        Assert.Matches(new Regex(@"catch\s*\(Exception ex\)[\s\S]{0,250}?NetworkFailure\.Describe\(ex\)"), body);
    }
}
