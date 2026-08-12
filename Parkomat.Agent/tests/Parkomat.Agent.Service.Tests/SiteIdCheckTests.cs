using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// בדיקת זהות האתר — הכלל שמונע את הכשל השקט.
///
/// ============================================================
/// מה זה מונע
/// ============================================================
/// בלי מזהה, נושאי ה-MQTT יוצאים `sites//state` — נושא **תקין לחלוטין**
/// מבחינת הפרוטוקול, שהשרת אינו מנוי אליו ולעולם לא יראה.
///
/// ⚠️ וכל שאר השכבות מדווחות הצלחה **אמיתית**: הבקר עונה, החיבור המוצפן
/// ל-HiveMQ עולה, סמל ה-Tray צבעוני. אף אחת מהן אינה בודקת *לאן*.
///
/// בשטח זה נראה כתעלומה ולא כתקלה — "בבקר יש תקשורת, בדשבורד אין" — וזה
/// בדיוק מה שקרה בז'בוטינסקי 91 ועלה שעה של חיפוש בכיוון הלא נכון.
/// </summary>
public class SiteIdCheckTests
{
    private static SiteConfig WithId(string? id) => new() { SiteId = id! };

    [Fact]
    public void ValidId_Passes_AndShowsTheId()
    {
        var r = SiteIdRule.Check("1399");

        Assert.True(r.IsValid);
        // ⚠️ המזהה עצמו מוצג, ולא רק "תקין": טכנאי צריך לראות ש-**זה** האתר
        // שהוא נמצא בו. מזהה של אתר אחר עובר כל בדיקה טכנית ועדיין שגוי.
        Assert.Contains("1399", r.Message);
    }

    [Fact]
    public void EmptyId_Fails()
    {
        Assert.False(SiteIdRule.Check("").IsValid);
    }

    [Fact]
    public void WhitespaceOnlyId_Fails()
    {
        // ⚠️ רווח בודד אינו "ריק" עבור string.IsNullOrEmpty, אבל הוא בהחלט
        // מזהה חסר. הוא גם היה יוצר את הנושא `sites/ /state`.
        Assert.False(SiteIdRule.Check("   ").IsValid);
    }

    [Fact]
    public void NullId_Fails_AndDoesNotThrow()
    {
        // config פגום או שדה שנמחק ידנית מה-JSON. חייב להיכשל בשקט ולא
        // להפיל את חלון הבדיקה — הטכנאי צריך לראות את התשובה, לא קריסה.
        var r = SiteIdRule.Check(null);
        Assert.False(r.IsValid);
    }

    [Theory]
    [InlineData("13/99")]      // '/' מפצל את הנושא לרמה נוספת
    [InlineData("1399+")]      // '+' הוא תו-כלליות של רמה אחת
    [InlineData("#1399")]      // '#' הוא תו-כלליות של כל השאר
    [InlineData("13 99")]      // רווח — לא תואם את הקוד הרשום אצלנו
    public void IdWithMqttStructuralChars_Fails(string id)
    {
        // ⚠️ אלה **אינם** תווים לא חוקיים ב-MQTT — הם תווים בעלי משמעות
        // מבנית. מזהה שמכיל אותם יוצר נושא תקין שאינו הנושא של האתר, ולכן
        // הכשל שלו זהה למזהה ריק: שידור מוצלח שאיש אינו שומע.
        var r = SiteIdRule.Check(id);

        Assert.False(r.IsValid);
        Assert.Contains(id, r.Message);   // מראים לטכנאי מה בדיוק כתוב
    }

    [Fact]
    public void SurroundingSpaces_AreTrimmed_NotRejected()
    {
        // הדבקה מתוך מסמך גוררת רווח בקצה. זו טעות הקלדה, לא מזהה שגוי —
        // ודחייה כאן הייתה מתסכלת בלי סיבה.
        var r = SiteIdRule.Check("  1399  ");

        Assert.True(r.IsValid);
        Assert.Contains("1399", r.Message);
    }
}
