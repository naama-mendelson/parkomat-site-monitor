using System.Text.RegularExpressions;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Tray;
using Xunit;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// סוכן נוסף על אותו מחשב (1.0.62, 22/10/2026) — מעפילי אגוז: שני אתרים נפרדים (12282 ב-6.6.7.3, 1228 ב-6.6.6.3) על
/// מחשב אחד. שני סוכנים רגילים; השני מותקן ל-…\Parkomat\Agent-2 וגוזר את המופע מהתיקייה.
///
/// ⚠️ הכלל החשוב ביותר כאן: <b>הסוכן הרגיל לא משתנה</b> — אותם נתיבים, אותם שמות, ואותה התנהגות מול תהליכים,
/// חוץ מזה שהוא מתעלם מתהליכים של סוכן נוסף.
/// </summary>
public class AgentInstanceTests
{
    private const string Local = @"C:\Users\tech\AppData\Local\Parkomat";

    [Theory]
    [InlineData(Local + @"\Agent", "")]
    [InlineData(Local + @"\Agent-2", "2")]
    [InlineData(Local + @"\Agent-2\", "2")]
    [InlineData(Local + @"\agent-2", "2")]
    [InlineData(Local + @"\Agent-b2", "b2")]
    [InlineData(Local + @"\Agent-", "")]
    [InlineData(Local + @"\Agent-2 copy", "")]
    [InlineData(Local + @"\Agent-..", "")]
    [InlineData(Local + @"\Agent-12345678901234567", "")]
    [InlineData(@"C:\src\Parkomat.Agent.Service\bin\Debug", "")]
    [InlineData(@"C:\src\publish", "")]
    [InlineData("", "")]
    [InlineData(null, "")]
    public void TheInstanceComesFromTheInstallFolderName(string? root, string expected)
    {
        Assert.Equal(expected, AgentInstance.FromInstallRoot(root));
    }

    [Fact]
    public void TheInstanceOfAnExeIsTwoFoldersUp()
    {
        Assert.Equal("2", AgentInstance.FromExePath(Local + @"\Agent-2\service\Parkomat.Agent.Service.exe"));
        Assert.Equal("2", AgentInstance.FromExePath(Local + @"\Agent-2\mosquitto\mosquitto.exe"));
        Assert.Equal("", AgentInstance.FromExePath(Local + @"\Agent\tray\Parkomat.Agent.Tray.exe"));
        Assert.Equal("", AgentInstance.FromExePath(@"C:\Program Files\mosquitto\mosquitto.exe"));
        Assert.Equal("", AgentInstance.FromExePath(null));
    }

    [Fact]
    public void TheRegularAgentKeepsEveryNameAndTheSecondGetsASuffix()
    {
        Assert.Equal("", AgentInstance.Current);   // תהליך הבדיקות = הסוכן הרגיל — הבדיקות לא נוגעות בתיקייה של מופע אחר
        Assert.Equal("ParkomatAgentKeepAlive", AgentInstance.Suffixed("ParkomatAgentKeepAlive"));
        Assert.Equal("ParkomatAgentKeepAlive", AgentInstance.Suffixed("ParkomatAgentKeepAlive", ""));
        Assert.Equal("ParkomatAgentKeepAlive-2", AgentInstance.Suffixed("ParkomatAgentKeepAlive", "2"));
        Assert.Equal("Parkomat Agent", AgentInstance.ProductName(""));
        Assert.Equal("Parkomat Agent 2", AgentInstance.ProductName("2"));
        // השמות בפועל, בתהליך הרגיל — בדיוק כמו לפני 1.0.62
        Assert.Equal("ParkomatAgentKeepAlive", AutoStartHealth.TaskName);
        Assert.Equal("ParkomatAgentTray", AutoStartHealth.RunValueName);
        Assert.Equal("ParkomatAgentKeepAlive", KeepAliveTask.TaskName);
    }

    [Fact]
    public void EachAgentHasItsOwnDataFolderAndTheRegularOneIsUnchanged()
    {
        string common = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        Assert.Equal(Path.Combine(common, "Parkomat", "Agent"), AgentPaths.BaseFolderFor(""));
        Assert.Equal(Path.Combine(common, "Parkomat", "Agent-2"), AgentPaths.BaseFolderFor("2"));
        Assert.Equal(AgentPaths.BaseFolderFor(""), AgentPaths.BaseFolder);
        Assert.Equal(Path.Combine(AgentPaths.BaseFolder, "config.json"), AgentPaths.ConfigFile);
    }

    // ============================================================
    // מי שלי — הסוכן הרגיל: כמו היום, חוץ מתהליכים של סוכן נוסף; סוכן נוסף: רק מה שרץ מה-exe שלו
    // ============================================================
    private const string RegularAgent = Local + @"\Agent\service\Parkomat.Agent.Service.exe";
    private const string SecondAgent = Local + @"\Agent-2\service\Parkomat.Agent.Service.exe";
    private const string ThirdAgent = Local + @"\Agent-3\service\Parkomat.Agent.Service.exe";

    [Fact]
    public void TheRegularAgentOwnsWhatItOwnedBeforeExceptAnotherAgentsProcesses()
    {
        Assert.True(ProcessOwnership.IsOurs(RegularAgent, RegularAgent, ""));
        Assert.True(ProcessOwnership.IsOurs(null, RegularAgent, ""), "נתיב שלא נקרא — שלו, כמו היום (ניקוי התקנה ישנה)");
        Assert.True(ProcessOwnership.IsOurs(@"C:\Program Files\Parkomat\service\Parkomat.Agent.Service.exe", RegularAgent, ""),
            "התקנה ישנה בנתיב אחר — שלו, כמו היום");
        Assert.False(ProcessOwnership.IsOurs(SecondAgent, RegularAgent, ""), "הסוכן השני — לא שלו");
    }

    [Fact]
    public void ASecondAgentOwnsOnlyWhatRunsFromItsOwnExe()
    {
        Assert.True(ProcessOwnership.IsOurs(SecondAgent, SecondAgent, "2"));
        Assert.True(ProcessOwnership.IsOurs(SecondAgent.ToUpperInvariant(), SecondAgent, "2"), "בלי הבדל באותיות");
        Assert.False(ProcessOwnership.IsOurs(RegularAgent, SecondAgent, "2"), "הסוכן הרגיל — לא שלו");
        Assert.False(ProcessOwnership.IsOurs(ThirdAgent, SecondAgent, "2"));
        Assert.False(ProcessOwnership.IsOurs(null, SecondAgent, "2"), "נתיב שלא נקרא — לא נוגעים");
    }

    // ============================================================
    // הקוד שמשתמש בכלל — שער טקסט, כמו ביתר הקבצים כאן (ה-I/O של תהליכים אינו נבדק בריצה)
    // ============================================================
    private static DirectoryInfo AgentRoot()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "Parkomat.Agent.slnx"))) d = d.Parent;
        return d ?? throw new InvalidOperationException("Parkomat.Agent.slnx לא נמצא");
    }
    private static string Src(params string[] parts) =>
        File.ReadAllText(Path.Combine(new[] { AgentRoot().FullName, "src" }.Concat(parts).ToArray()));

    [Fact]
    public void TheTrayOnlySeesAndKillsItsOwnProcesses()
    {
        string sm = Src("Parkomat.Agent.Tray", "Services", "ServiceManager.cs");
        Assert.Contains("return procs.Any(p => ProcessPaths.IsOurs(p, ours));", sm);
        Assert.Contains("if (!ProcessPaths.IsOurs(p, ours)) continue;", sm);
        string tt = Src("Parkomat.Agent.Tray", "Services", "TrayTakeover.cs");
        Assert.Contains("Process.GetProcessesByName(AgentProcessName).Any(p => ProcessPaths.IsOurs(p, OurAgentExe))", tt);
        Assert.Contains("if (ProcessPaths.IsOurs(p, OurTrayExe)) found.Add(", tt);
        Assert.Contains("if (!ProcessPaths.IsOurs(p, OurTrayExe)) continue;", tt);
    }

    [Fact]
    public void EveryMachineWideNameCarriesTheInstance()
    {
        Assert.Contains("AgentInstance.Suffixed(\"Parkomat.Agent.Service.SingleInstance\")", Src("Parkomat.Agent.Service", "SingleInstance.cs"));
        Assert.Contains("AgentInstance.Suffixed(@\"Local\\Parkomat.Agent.Tray.SingleInstance\")", Src("Parkomat.Agent.Tray", "Program.cs"));
        Assert.Contains("AgentInstance.Suffixed(\"Mosquitto\")", Src("Parkomat.Agent.Core", "Configuration", "BridgeConfigWriter.cs"));
    }

    // ============================================================
    // המתקין: /DInstance=2 — שם, תיקייה, Run, משימה ונתונים עם הסיומת; סוגר רק את התהליכים שלו
    // ============================================================
    private static string Iss() => File.ReadAllText(Path.Combine(AgentRoot().FullName, "installer.iss")).Replace("\r\n", "\n");

    [Fact]
    public void TheInstallerBuildsASecondAgentWithItsOwnNames()
    {
        string iss = Iss();
        Assert.Matches(new Regex(@"#ifdef Instance\s*\n\s*#define MyAppName ""Parkomat Agent "" \+ Instance\s*\n\s*#define Sfx ""-"" \+ Instance\s*\n#else\s*\n\s*#define MyAppName ""Parkomat Agent""\s*\n\s*#define Sfx """""), iss);
        Assert.Contains(@"DefaultDirName={localappdata}\Parkomat\Agent{#Sfx}", iss);
        Assert.Contains("OutputBaseFilename=ParkomatAgentSetup-{#MyAppVersion}-agent{#Instance}", iss);
        Assert.Contains(@"ForceDirectories(ExpandConstant('{commonappdata}\Parkomat\Agent{#Sfx}'));", iss);
        Assert.Contains(@"SaveStringToFile(ExpandConstant('{commonappdata}\Parkomat\Agent{#Sfx}\reset-to-defaults.flag')", iss);
        Assert.DoesNotContain(@"{commonappdata}\Parkomat\Agent\", iss);   // כל נתיב נתונים — עם הסיומת
    }

    [Fact]
    public void ASecondAgentsInstallerNeverKillsTheFirstAgentByName()
    {
        string iss = Iss();
        var blocks = Regex.Matches(iss, @"#ifdef Instance\n(?<inst>.*?)\n#else\n(?<reg>.*?)\n#endif", RegexOptions.Singleline);
        var kills = blocks.Where(b => b.Groups["reg"].Value.Contains("taskkill")).ToList();
        Assert.Equal(2, kills.Count);   // [UninstallRun] ו-PrepareToInstall
        // שורות קוד בלבד — הערות (";" ב-Inno, "//" ב-Pascal) מזכירות את taskkill כדי להסביר למה לא
        static string CodeOnly(string block) => string.Join("\n", block.Split('\n')
            .Where(l => { string t = l.TrimStart(); return !t.StartsWith(';') && !t.StartsWith("//"); }));
        foreach (Match b in kills)
        {
            string inst = CodeOnly(b.Groups["inst"].Value);
            Assert.DoesNotContain("taskkill", inst);
            Assert.Contains("Where-Object", inst);
            Assert.Contains("{app}", inst);
        }
        // ואין taskkill מחוץ לחלק ה-#else של בלוק כזה
        string outside = Regex.Replace(iss, @"#ifdef Instance\n.*?\n#endif", "", RegexOptions.Singleline);
        Assert.DoesNotMatch(new Regex(@"^[^;\n]*taskkill", RegexOptions.Multiline), outside);
    }
}
