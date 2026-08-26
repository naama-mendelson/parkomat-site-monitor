using System;
using System.IO;
using Xunit;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ==========================================================
/// ⚠️ ההתקנה נכשלה בשטח ועבדה במעבדה
/// ==========================================================
/// מחשב אתר טרי הוא Windows בלי כלום. Mosquitto נבנה עם MSVC, וכל
/// הבינאריים שלו מייבאים <c>VCRUNTIME140.dll</c> — שמגיע רק עם חבילת
/// ה-Visual C++ Redistributable. במחשב הפיתוח היא מותקנת, ולכן זה עבד
/// כאן ונכשל באתר עם:
///
///     mosquitto.exe - System Error
///     The code execution cannot proceed because VCRUNTIME140.dll was not found.
///
/// ⚠️ **ולא מריצים vc_redist.exe.** ההתקנה היא PrivilegesRequired=lowest
/// במכוון — בלי UAC, לתיקיית המשתמש. חבילה מערכתית שדורשת מנהל הייתה
/// שוברת בדיוק את מה שמאפשר להתקין באתר בלי לקרוא למחלקת IT.
///
/// הפתרון הוא app-local: העותק יושב ליד mosquitto.exe, ו-Windows מחפש
/// שם קודם. הבדיקה שומרת על שני חלקיו — שהקובץ קיים בריפו, ושהמתקין
/// באמת שולח אותו ליעד הנכון.
/// </summary>
public class InstallerDependencyTests
{
    private static string RepoRoot()
    {
        string dir = Path.GetDirectoryName(typeof(InstallerDependencyTests).Assembly.Location)!;
        for (int i = 0; i < 8; i++)
        {
            if (File.Exists(Path.Combine(dir, "installer.iss"))) return dir;
            dir = Path.GetFullPath(Path.Combine(dir, ".."));
        }
        throw new FileNotFoundException("installer.iss לא נמצא מעל תיקיית הבדיקות");
    }

    [Fact]
    public void VcRuntime_IsVendoredInTheRepo()
    {
        string dll = Path.Combine(RepoRoot(), "vendor", "vcruntime", "VCRUNTIME140.dll");

        Assert.True(File.Exists(dll),
            "VCRUNTIME140.dll חסר מ-vendor/vcruntime — ההתקנה תיכשל בכל מחשב נקי");

        // שפוי: קובץ ריק/פלייסהולדר עובר על File.Exists ונכשל רק בשטח.
        Assert.True(new FileInfo(dll).Length > 50_000, "הקובץ קטן מדי מכדי להיות ה-DLL האמיתי");
    }

    [Fact]
    public void Installer_ShipsItNextToMosquitto()
    {
        string iss = File.ReadAllText(Path.Combine(RepoRoot(), "installer.iss"));

        Assert.Contains("VCRUNTIME140.dll", iss);

        // ⚠️ **היעד הוא מה שמכריע.** app-local עובד רק אם ה-DLL יושב באותה
        // תיקייה כמו mosquitto.exe; העתקה ל-{app} לבדו לא תעזור בכלום,
        // והשגיאה בשטח תיראה בדיוק אותו דבר.
        Assert.Matches(
            @"Source:[^\r\n]*VCRUNTIME140\.dll[^\r\n]*DestDir:\s*""\{app\}\\mosquitto""",
            iss);
    }

    [Fact]
    public void Installer_DoesNotRequireAdmin()
    {
        string iss = File.ReadAllText(Path.Combine(RepoRoot(), "installer.iss"));

        // ⚠️ זה מה שהופך את app-local לנחוץ מלכתחילה. אם מישהו יעלה את
        // ההרשאות, כדאי שיֵדע שהוא מבטל החלטה ולא מתקן הגדרה.
        Assert.Contains("PrivilegesRequired=lowest", iss);
    }
}
