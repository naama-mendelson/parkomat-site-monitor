using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ==========================================================
/// ⚠️ "מושבת" בלי מילה — שתי תקלות שונות תחת שם אחד
/// ==========================================================
/// כשהבקר אינו נענה, הסוכן משדר <c>state=error</c>. זו ההתנהגות הנכונה:
/// אתר שאיננו רואים הוא בעיה, ו-<c>no_comm</c> נמצא **מחוץ למשוואת הזמינות**
/// לגמרי — העברה לשם הייתה מעלימה את התקלה מהמדדים במקום להסביר אותה.
///
/// ⚠️ מה שהיה חסר הוא התיאור. עד כה שודר Error עירום, ולכן על המסך הופיע
/// "מושבת" בלי מילה, ואי אפשר היה להבחין בין:
///
///   • **המכונה נשברה**    — צריך טכנאי באתר
///   • **אין לנו קשר אליה** — צריך רשת, ואולי המכונה עובדת מצוין
///
/// נמדד בשרת: 12 מקטעי תקלה בשבוע בלי תיאור ובלי מעבר MODE שנרשם, ובהם
/// שלושה שנמשכו 210–230 דקות. שתי הסיבות דורשות שתי פעולות שונות לגמרי,
/// והמסך נתן להן שם אחד.
///
/// ⚠️ הבדיקה על המקור ולא בהרצה: הענף הזה נמצא בתוך לולאת ה-Worker ודורש
/// PLC שאינו נענה כדי להגיע אליו. אותה תבנית כמו WatchdogVsPlcErrorTests,
/// שגם הוא שומר על קבועים ולא על התנהגות בזמן ריצה.
/// </summary>
public class PlcUnreachableTextTests
{
    private static string WorkerSource()
    {
        // מהתיקייה של ה-DLL חזרה אל שורש הריפו — bin/Debug/net10.0
        string dir = Path.GetDirectoryName(typeof(PlcUnreachableTextTests).Assembly.Location)!;
        for (int i = 0; i < 8; i++)
        {
            string candidate = Path.Combine(dir, "src", "Parkomat.Agent.Service", "Logic", "..", "Worker.cs");
            candidate = Path.GetFullPath(candidate);
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            dir = Path.GetFullPath(Path.Combine(dir, ".."));
        }
        throw new FileNotFoundException("Worker.cs לא נמצא מעל תיקיית הבדיקות");
    }

    [Fact]
    public void ErrorOnPlcTimeout_CarriesAFaultText()
    {
        string src = WorkerSource();

        // הענף שמשדר תקלה בגלל בקר שאינו נענה
        Match block = Regex.Match(
            src,
            @"var errorState = new StateMessage\s*\{(?<body>[^}]*)\}",
            RegexOptions.Singleline);

        Assert.True(block.Success, "הענף שמשדר error על ניתוק בקר לא נמצא ב-Worker.cs");

        string body = block.Groups["body"].Value;
        Assert.Contains("State = SiteState.Error", body);

        // ⚠️ הטענה: התקלה **אומרת** מה היא. Error עירום הוא בדיוק הבאג.
        Assert.Contains("FaultText", body);
    }

    [Fact]
    public void FaultText_IsAConstant_NotAnInlineString()
    {
        string src = WorkerSource();

        // ⚠️ קבוע ולא נוסח חופשי: השרת שומר את המחרוזת כמות שהיא ב-fault_text,
        // וזה מה שמאפשר לשאול אחר כך "כמה מזמן ההשבתה היה בכלל ניתוק".
        // נוסח שמשתנה בין גרסאות שובר את ההפרדה הזו רטרואקטיבית.
        Assert.Matches(@"const string PlcUnreachableFault\s*=", src);
        Assert.Contains("FaultText = PlcUnreachableFault", src);
    }

    [Fact]
    public void StateStaysError_NotNoComm()
    {
        string src = WorkerSource();
        Match block = Regex.Match(
            src,
            @"var errorState = new StateMessage\s*\{(?<body>[^}]*)\}",
            RegexOptions.Singleline);

        // ⚠️ ההפך מהתיקון המתבקש-לכאורה. no_comm מוציא את הזמן מהמכנה ומהמונה
        // כאחד, ולכן העברה לשם הייתה **מעלימה** את הבעיה מהדוחות. הכלל: אתר
        // שצריך להיות בתקלה — נשאר בתקלה.
        Assert.DoesNotContain("SiteState.NoComm", block.Groups["body"].Value);
    }
}
