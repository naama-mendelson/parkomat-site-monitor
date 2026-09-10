using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>כשל ה-PLC נרשם עם החריגה, לא רק עם הטקסט שלה.</b>
///
/// <para>באתר 2222 חזרה <c>Index was outside the bounds of the array</c>
/// מאות פעמים. במסלול הקריאה שלנו אין שום אינדוקס לא-מוגן — הגישה
/// היחידה היא לפי היסט, אחרי בדיקת אורך — כלומר החריגה נזרקת
/// <b>בתוך NModbus</b>. בלי stack trace אין דרך לדעת באיזו שכבה, וניחוש
/// המנגנון כבר נכשל פעמיים.</para>
///
/// <para>⚠️ <b>ו-<c>Worker</c> רשם <c>ex.Message</c> בלבד</b>, כלומר
/// הנתון היחיד שהיה עונה על השאלה נזרק לפני שנכתב לקובץ.</para>
/// </summary>
public class PlcFailureDetailTests
{
    private static string WorkerSource()
    {
        string dir = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && dir.Length > 3; i++)
        {
            string candidate = Path.Combine(dir, "src", "Parkomat.Agent.Service", "Worker.cs");
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            dir = Path.GetDirectoryName(dir)!;
        }

        // ⚠️ "לא נמצא" הוא **כשל**, לא דילוג. שער מדולג הוא בדיוק זה
        // שיסחף בלי שאיש ישים לב.
        throw new FileNotFoundException("Worker.cs לא נמצא — השער אינו יכול לבדוק כלום");
    }

    // ⚠️ ההערות נשלפות לפני הבדיקה. אחרת העוגן היה נתפס בהערה שמסבירה
    // את הכלל במקום בקוד שמקיים אותו — הדפוס שכבר הכשיל שישה שערים
    // בפרויקט הזה.
    private static string WithoutComments(string src)
    {
        src = Regex.Replace(src, @"/\*.*?\*/", "", RegexOptions.Singleline);
        return Regex.Replace(src, @"//[^\n]*", "");
    }

    [Fact]
    public void TheFirstPlcFailureIsLoggedWithTheExceptionObject()
    {
        string code = WithoutComments(WorkerSource());

        Match m = Regex.Match(code, @"LogWarning\(\s*([^;]*?)""PLC read failed");

        Assert.True(m.Success, "לא נמצאה קריאת LogWarning עבור 'PLC read failed'");

        // ⚠️ הטענה היא שהארגומנט הראשון הוא **החריגה**. בלעדיו נכתבת
        // שורה אחת בלי stack trace, וזה בדיוק המצב שהשאיר את 2222 בלי
        // תשובה במשך יום.
        Assert.Equal("ex, ", m.Groups[1].Value.Trim() + " ");
    }
}
