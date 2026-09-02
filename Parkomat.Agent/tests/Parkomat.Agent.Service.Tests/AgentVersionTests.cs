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
