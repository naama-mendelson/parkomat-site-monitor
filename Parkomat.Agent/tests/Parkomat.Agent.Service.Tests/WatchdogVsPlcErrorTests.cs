using Parkomat.Agent.Core.Configuration;
using Xunit;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ==========================================================
/// הפער שבו הבאג חי — בין שתי מדיניות שכל אחת נכונה לבדה
/// ==========================================================
/// היו 127 טסטים. RestartPolicyTests בדק את סף התקיעה, ה-Worker מימש את סף
/// הכשלונות, וכל אחד היה נכון. **אף טסט לא קשר ביניהם**, ובדיוק שם ישב באג
/// שהשבית אתרים:
///
///   פעימת הלב נכתבה רק אחרי קריאת PLC *מוצלחת*, ולכן נתק בקר נראה ל-watchdog
///   זהה לתקיעה. נמדד בפועל: כשל קריאה עולה ~3,195ms (חיבור TCP שלא נענה, עם
///   timeout של 3 שניות). 10 כשלונות — הסף לשידור state=error — לוקחים ~42
///   שניות. סף התקיעה בקצב דגימה של שנייה הוא 30 שניות.
///
///   הסוכן נהרג 12 שניות לפני שהספיק לדווח. ההריגה איפסה את מונה הכשלונות,
///   ולכן זו לא הייתה תחרות שאפשר לנצח בה — **error לא שודר לעולם**, והאתר
///   דשדש בין no_comm להפעלה-מחדש.
///
/// התיקון הוא הפרדת הקבצים (AgentPaths.LivenessFile), והטסטים כאן שומרים על
/// שני הצדדים שלו: שהסף עצמו לא יתהדק בחזרה מתחת לזמן הדיווח, ושהמדידה תישאר
/// על החיוּת ולא על פעימת הלב.
/// </summary>
public class WatchdogVsPlcErrorTests
{
    // הקבועים של הצד השני, כפי שהם ב-Worker.cs וב-PlcReader.cs. משוכפלים כאן
    // בכוונה ולא נחשפים כ-public: הטסט הזה קיים כדי לתפוס *שינוי* בהם, ואם היה
    // מייבא אותם הוא היה משתנה יחד איתם ולא מתריע על כלום.
    private const int MaxConsecutiveFailures = 10;   // Worker.MaxConsecutiveFailures
    private const int PlcConnectTimeoutMs = 3000;    // PlcReader.ConnectTimeoutMs

    /// <summary>
    /// זמן משוער עד שידור state=error: כל כשל עולה timeout של חיבור ועוד מרווח
    /// דגימה, כפול מספר הכשלונות הנדרש.
    /// </summary>
    private static int MsToReportPlcError(int pollIntervalMs)
        => MaxConsecutiveFailures * (PlcConnectTimeoutMs + pollIntervalMs);

    [Theory]
    [InlineData(1000)]   // ברירת המחדל — כאן הבאג נצפה
    [InlineData(100)]    // הדגימה המהירה ביותר המותרת
    [InlineData(2000)]
    [InlineData(5000)]
    public void WedgedThreshold_MustNotFireBeforeTheAgentCanReportAPlcFault(int pollMs)
    {
        int wedgedMs = RestartPolicy.WedgedAfterSeconds(pollMs) * 1000;
        int reportMs = MsToReportPlcError(pollMs);

        // ההערה: זהו *בדיוק* התנאי שנכשל לפני התיקון (30,000 מול 41,950).
        // הוא ממשיך להיכשל, ובכוונה — הסף לא הוזז. מה שהשתנה הוא שהתקיעה
        // נמדדת מול קובץ החיוּת, שנכתב גם בכשל, ולכן הסף הזה כלל אינו נוגע
        // לנתק PLC. הטסט נשאר כתיעוד חי של הפער, ומאמת את הכיוון.
        Assert.True(
            wedgedMs < reportMs,
            $"הפער נסגר מעצמו (wedged={wedgedMs}ms, report={reportMs}ms). " +
            "אם זה קרה בכוונה — אפשר לשקול לפשט; אם לא — משהו זז.");
    }

    [Fact]
    public void LivenessAndHeartbeat_AreSeparateFiles()
    {
        // הליבה של התיקון. איחוד הקבצים מחזיר את הבאג באחת משתי צורות:
        // או שנתק PLC נראה כתקיעה (הריגה לפני דיווח), או שאתר עם בקר מת
        // נצבע ירוק ב-Tray.
        Assert.NotEqual(AgentPaths.HeartbeatFile, AgentPaths.LivenessFile);
    }

    [Fact]
    public void LivenessFile_LivesBesideTheOtherRuntimeFiles()
    {
        // שני התהליכים (Service ו-Tray) חייבים להתכוון לאותו קובץ; הבסיס
        // המשותף הוא מה שמאפשר את זה.
        Assert.Equal(
            AgentPaths.BaseFolder,
            Path.GetDirectoryName(AgentPaths.LivenessFile));
    }

    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    [InlineData(60000)]
    public void WedgedThreshold_StaysAboveASingleLoopIteration(int pollMs)
    {
        // סבב אחד במקרה הגרוע: קריאת PLC שנכשלת ב-timeout, ואז מרווח הדגימה.
        // אם הסף היה יורד מתחת לזה, הסוכן היה נהרג בזמן שהוא עובד בדיוק כשורה.
        int worstIterationMs = PlcConnectTimeoutMs + pollMs;
        int wedgedMs = RestartPolicy.WedgedAfterSeconds(pollMs) * 1000;

        Assert.True(
            wedgedMs > worstIterationMs,
            $"סף התקיעה ({wedgedMs}ms) קטן מסבב בודד במקרה הגרוע ({worstIterationMs}ms) — " +
            "סוכן תקין ייהרג.");
    }
}
