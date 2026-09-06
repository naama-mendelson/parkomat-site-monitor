using System.Reflection;
using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// מספר הגרסה זהה בכל מקום שמצהיר עליו.
///
/// ⚠️ <b>הפער שזה סוגר היה קיים בפועל:</b> שני ה-csproj אמרו <c>1.0.20</c>
/// ו-<c>installer.iss</c> אמר <c>1.0.21</c> — כלומר ה-installer הכריז על
/// גרסה שהבינאריים שבתוכו אינם נושאים.
///
/// ⚠️ <b>ולמה זה לא קוסמטי.</b> <c>installer.iss</c> עצמו מתעד את הסיבה:
/// מספר הגרסה הוא הדרך <b>היחידה</b> לדעת איזה סוכן מותקן באיזה אתר —
/// הסוכן אינו משדר את גרסתו בשום topic, ולוח הבקרה של Windows הוא המקום
/// היחיד שרואים אותה. גרסה שאינה תואמת הופכת את "האם האתר הזה כבר עודכן?"
/// לבלתי ניתנת לתשובה, וזה בדיוק המצב שבו מעדכנים אתר פעמיים ומדלגים על אחר.
///
/// ⚠️ <b>ולמה בדיקה ולא הגדרה משותפת.</b> <c>Directory.Build.props</c> מאחד
/// את שני ה-csproj, אבל <c>installer.iss</c> הוא Inno Setup ולא MSBuild —
/// אין דרך לחבר אותו. מה שאי אפשר לאחד, נועלים.
/// </summary>
public class AgentVersionTests
{
    private static DirectoryInfo AgentRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "installer.iss")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!;
    }

    private static string InstallerVersion()
    {
        string iss = File.ReadAllText(Path.Combine(AgentRoot().FullName, "installer.iss"));
        var m = Regex.Match(iss, @"#define\s+MyAppVersion\s+""([\d.]+)""");
        Assert.True(m.Success, "לא נמצא MyAppVersion ב-installer.iss");
        return m.Groups[1].Value;
    }

    private static string PropsVersion()
    {
        string props = File.ReadAllText(Path.Combine(AgentRoot().FullName, "Directory.Build.props"));
        var m = Regex.Match(props, @"<Version>([\d.]+)</Version>");
        Assert.True(m.Success, "לא נמצא Version ב-Directory.Build.props");
        return m.Groups[1].Value;
    }

    [Fact]
    public void InstallerAndBuildAgreeOnTheVersion()
    {
        Assert.Equal(PropsVersion(), InstallerVersion());
    }

    [Fact]
    public void TheCompiledAssemblyCarriesThatVersion()
    {
        // ⚠️ **הבדיקה החזקה מבין השלוש.** השתיים האחרות משוות שני קבצי
        // טקסט; זו שואלת את הבינארי שנבנה בפועל. Directory.Build.props
        // שלא נטען (למשל אם מישהו יזיז אותו) היה משאיר את הקבצים תואמים
        // ואת ה-DLL עם 1.0.0 — כלומר בדיוק הפער שהבדיקה באה למנוע.
        var asm = typeof(Parkomat.Agent.Core.Configuration.SiteConfig).Assembly;
        string? built = asm.GetName().Version?.ToString(3);

        Assert.Equal(PropsVersion(), built);
    }

    [Fact]
    public void TheInstallerFileItselfIsStamped()
    {
        // ⚠️ AppVersion עונה על "איזו גרסה מותקנת באתר". זו עונה על שאלה
        // שנשאלת קודם: טכנאי עם שלושה ParkomatAgentSetup.exe בתיקיית
        // ההורדות — איזה מהם החדש? בלי VersionInfoVersion מאפייני הקובץ
        // ריקים, והתשובה היחידה היא תאריך השינוי — שמשתנה בכל העתקה.
        string iss = File.ReadAllText(Path.Combine(AgentRoot().FullName, "installer.iss"));
        Assert.Matches(new Regex(@"VersionInfoVersion={#MyAppVersion}"), iss);
    }

    [Fact]
    public void UninstallNeverDeletesTheSitesIdentity()
    {
        // ============================================================
        // ⚠️ שורה אחת במתקין שעלתה יום שלם של אבחון
        // ============================================================
        // `[UninstallDelete]` הכיל `{commonappdata}\Parkomat` — כלומר הסרה
        // מחקה את **כל** נתוני הסוכן, ובהם `config.json`: מזהה האתר, סיסמת
        // HiveMQ, וסיסמת Supabase.
        //
        // ⚠️ נמדד באתר 2438: אחרי התקנה הלוג אמר `Config loaded for site ''`
        // ואחריו SITE ID IS INVALID — הסוכן הפסיק לשדר לגמרי. וסיסמת
        // Supabase מוצגת **פעם אחת בהנפקה**, כך שאין מאיפה להעתיק אותה.
        //
        // ⚠️ וזה גם מה שהפך את האבחון לרדיפה אחרי הזנב: כל התיקונים
        // ב-`ConfigStore` שומרים שדות מקובץ — והקובץ כבר לא היה שם.
        //
        // בדיקה על הטקסט כי אין דרך אחרת: `installer.iss` הוא Inno Setup
        // ואינו ניתן להרצה מכאן. אותו שיקול כמו ביתר הבדיקות בקובץ הזה.
        string iss = File.ReadAllText(Path.Combine(AgentRoot().FullName, "installer.iss"));
        int section = iss.IndexOf("[UninstallDelete]", StringComparison.Ordinal);
        Assert.True(section > 0, "לא נמצא [UninstallDelete]");

        int next = iss.IndexOf("\n[", section + 1, StringComparison.Ordinal);
        string body = next > 0 ? iss[section..next] : iss[section..];

        foreach (string line in body.Split('\n'))
        {
            string t = line.Trim();
            if (t.StartsWith(';') || !t.StartsWith("Type:", StringComparison.Ordinal)) continue;

            // מחיקה גורפת של תיקיית ProgramData — בכל צורה שהיא
            Assert.False(
                t.Contains("{commonappdata}\\Parkomat\"", StringComparison.Ordinal) ||
                t.Contains("{commonappdata}\\Parkomat\\Agent\"", StringComparison.Ordinal),
                $"הסרה מוחקת את כל נתוני הסוכן, כולל זהות האתר: {t}");

            Assert.DoesNotContain("config.json", t);
            Assert.DoesNotContain("\\logs", t);
        }
    }

    [Fact]
    public void TheInstallerFileNameCarriesTheVersion()
    {
        // ============================================================
        // ⚠️ מאפייני קובץ אינם מספיקים — נמדד, ועלה שעה
        // ============================================================
        // הבדיקה שמעליה מוודאת ש-VersionInfoVersion מוטבע, וזו הייתה
        // התשובה ל"איזה מהם החדש". היא נכונה ולא מספיקה: **אף אחד אינו
        // פותח מאפיינים לפני שהוא לוחץ פעמיים.**
        //
        // ב-06/09/2026 נבנו 1.0.25 ו-1.0.26 לאותו נתיב בדיוק, אחת מהן
        // הותקנה באתר 2438, ולא הייתה שום דרך לדעת בדיעבד איזו. השאלה
        // העובדתית "האם תיקון האיפוס עבד?" הפכה לבלתי-פתירה, ונענתה
        // בניחושים על גבי לוגים — שהם עצמם לא דיווחו גרסה.
        //
        // שם הקובץ הוא המקום היחיד שנראה **לפני** ההתקנה ואחריה, ושורד
        // העתקה, שליחה בוואטסאפ, ותיקיית הורדות עם שלושה קבצים.
        Assert.Matches(new Regex(@"OutputBaseFilename=\S*\{#MyAppVersion\}"), iss2());

        static string iss2()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "installer.iss")))
                dir = dir.Parent;
            Assert.NotNull(dir);
            return File.ReadAllText(Path.Combine(dir!.FullName, "installer.iss"));
        }
    }

    [Fact]
    public void NoProjectDeclaresItsOwnVersion()
    {
        // ⚠️ csproj שמכריז Version משלו **גובר** על Directory.Build.props,
        // בשקט. זה בדיוק איך הפער נוצר בפעם הראשונה.
        foreach (string csproj in Directory.GetFiles(
                     Path.Combine(AgentRoot().FullName, "src"), "*.csproj",
                     SearchOption.AllDirectories))
        {
            string text = File.ReadAllText(csproj);
            // ⚠️ רק <Version> עצמאי. PackageReference Version="…" הוא תכונה
            // ולא אלמנט, ולכן אינו נתפס.
            Assert.DoesNotMatch(new Regex(@"<Version>[\d.]+</Version>"), text);
        }
    }
}
