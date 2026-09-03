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

    [Fact]
    public void ThePasswordIsLoadedFromTheConfig()
    {
        // ⚠️ שדה שאינו נטען מוצג ריק גם כשהוא מוגדר — והטכנאי שילחץ שמור
        // **ימחק אותו** בלי לדעת.
        Assert.Matches(new Regex(@"_sbPass\.Text\s*=\s*c\.Supabase\.Password\s*;"), Form());
    }

    [Fact]
    public void ThePasswordIsSavedAndTrimmed()
    {
        // ⚠️ רווח שנדבק בהדבקה נראה כערך תקין בטופס, ו-Enabled היה נדלק על
        // סיסמה שאינה סיסמה — סוכן שמנסה לכתוב ונכשל בכל סבב.
        Assert.Matches(new Regex(@"Password\s*=\s*_sbPass\.Text\.Trim\(\)"), Form());
    }

    [Fact]
    public void TheOverridesSurviveASave()
    {
        // ⚠️ **הבדיקה שנולדה מהצמצום לשדה אחד.** הכתובת, המפתח ושם המשתמש
        // כבר אינם בטופס, אבל הם עדיין בקובץ ההגדרות — והם דלת היציאה.
        // OnSave בונה SiteConfig **חדש**, ולכן בלי הנשיאה הזו כל לחיצה על
        // "שמור" הייתה מוחקת אותם בשקט: אתר שהופנה ל-Postgres אחר היה חוזר
        // לברירת המחדל ברגע שמישהו שינה כתובת PLC.
        string src = Form();
        Assert.Matches(new Regex(@"_sbOverrides\s*=\s*c\.Supabase\s*;"), src);
        foreach (string prop in new[] { "Url", "AnonKey", "Email" })
            Assert.Matches(new Regex($@"{prop}\s*=\s*_sbOverrides\.{prop}"), src);
    }

    [Fact]
    public void TheSiteCodeReachesTheSupabaseConfig()
    {
        // ⚠️ שם המשתמש נגזר מקוד האתר. בלי ההשמה הזו ב-OnSave, השמירה
        // הייתה מייצרת הגדרות עם קוד ריק — Enabled=false עד הטעינה הבאה,
        // כלומר "שמרתי סיסמה ולא קרה כלום".
        Assert.Matches(new Regex(@"SiteId\s*=\s*siteId,[\s\S]{0,200}?Password\s*=\s*_sbPass"),
            Form());
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
        // ⚠️ בלי המשפט הזה, טכנאי שרואה שדה ריק מניח שמשהו חסר וממלא אותו
        // בניחוש — כלומר מפעיל בטעות אתר שלא היה אמור לעבור.
        Assert.Contains("מחיקתה מכבה", Form());
    }

    [Fact]
    public void TheThreeDerivedFieldsAreGoneFromTheForm()
    {
        // ⚠️ **הבדיקה שמונעת את החזרתם.** כתובת ומפתח זהים בכל 16 האתרים,
        // ושם המשתמש נגזר מקוד האתר. שדה שהתשובה בו ידועה מראש אינו גמישות
        // אלא הזדמנות לשגיאת הקלדה שמתגלה רק כשאתר מפסיק לדווח.
        string src = Form();
        foreach (string field in new[] { "_sbUrl", "_sbKey", "_sbEmail" })
            Assert.DoesNotContain(field, src);
    }
}
