using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// טופס ההגדרות באמת טוען ושומר את פרטי הכתיבה הישירה.
///
/// ⚠️ <b>למה בדיקה מבנית.</b> אין כאן DOM ואין WinForms בריצת הבדיקות
/// (הטופס יושב בפרויקט <c>net10.0-windows</c>), ולכן היא מוכיחה את
/// <b>החיווט</b> ולא את הרינדור — בדיוק כמו <c>admin-gate.test.js</c> בשרת.
///
/// ⚠️ <b>והכשל שהיא מונעת שקט לגמרי:</b> שדה שמוצג ונטען אך אינו נשמר
/// נראה עובד — הטכנאי מקליד, לוחץ שמור, והחלון נסגר. רק בסבב הבא מתברר
/// שהכתיבה עדיין כבויה, בלי שום הודעה שמסבירה למה.
/// </summary>
public class SettingsFormWiringTests
{
    private static string Form()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string path = Path.Combine(dir!.FullName, "src", "Parkomat.Agent.Tray",
            "Forms", "SettingsForm.cs");
        Assert.True(File.Exists(path), $"קובץ חסר: {path}");
        return File.ReadAllText(path);
    }

    // ארבעת השדות שמרכיבים את SupabaseConfig.Enabled.
    private static readonly (string Field, string ConfigProp)[] Fields =
    [
        ("_sbUrl", "Url"),
        ("_sbKey", "AnonKey"),
        ("_sbEmail", "Email"),
        ("_sbPass", "Password"),
    ];

    [Fact]
    public void EveryFieldIsLoadedFromTheConfig()
    {
        // ⚠️ שדה שאינו נטען מוצג ריק גם כשהוא מוגדר — והטכנאי שילחץ שמור
        // **ימחק אותו** בלי לדעת.
        string src = Form();
        foreach (var (field, prop) in Fields)
            Assert.Matches(new Regex($@"{field}\.Text\s*=\s*c\.Supabase\.{prop}\s*;"), src);
    }

    [Fact]
    public void EveryFieldIsSavedBackToTheConfig()
    {
        string src = Form();
        foreach (var (field, prop) in Fields)
            Assert.Matches(new Regex($@"{prop}\s*=\s*{field}\.Text"), src);
    }

    [Fact]
    public void EveryFieldIsTrimmedOnSave()
    {
        // ⚠️ רווח שנדבק בהדבקה נראה כערך תקין בטופס, ו-Enabled היה נדלק על
        // הגדרות שאינן שלמות — סוכן שמנסה לכתוב ונכשל בכל סבב.
        string src = Form();
        foreach (var (field, prop) in Fields)
            Assert.Matches(new Regex($@"{prop}\s*=\s*{field}\.Text\.Trim\(\)"), src);
    }

    [Fact]
    public void ThePasswordIsMaskedLikeTheMqttOne()
    {
        // הסיסמה מונפקת פעם אחת ואינה ניתנת לשחזור. הצגתה גלויה על מסך
        // במשרד היא בדיוק סוג הדליפה שהזהות-לכל-אתר נועדה לצמצם.
        Assert.Matches(new Regex(@"_sbPass\.UseSystemPasswordChar\s*=\s*true"), Form());
    }

    [Fact]
    public void TheGroupIsActuallyShown()
    {
        // ⚠️ קבוצה שנבנתה ולא נוספה ללייאאוט אינה מייצרת שגיאה — היא פשוט
        // לא נראית, והשדות נשארים ריקים לנצח.
        string src = Form();
        Assert.Contains("private GroupBox BuildSupabaseGroup()", src);
        Assert.Matches(new Regex(@"layout\.Controls\.Add\(BuildSupabaseGroup\(\)\)"), src);
    }

    [Fact]
    public void TheFormSaysThatEmptyMeansOff()
    {
        // ⚠️ בלי המשפט הזה, טכנאי שרואה ארבעה שדות ריקים מניח שמשהו חסר
        // וממלא אותם בניחוש — כלומר מפעיל בטעות אתר שלא היה אמור לעבור.
        Assert.Contains("השאירו ריק", Form());
    }
}
