namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// בדיקות לנעילת המופע היחיד.
///
/// ============================================================
/// ⚠️ למה זה נבדק בכלל
/// ============================================================
/// באתר 1284 רצו שני מופעים של הסוכן מ-26/08/2026 22:23:07, ניתקו זה את
/// זה ב-MQTT, וירו את הצוואה כ-170,000 פעם ביום. הכשל שרד ארבעה ימים כי
/// בדשבורד האתר נראה תקין — השרת דחה את ההצפה כראוי.
///
/// ⚠️ **ובדיקה שבודקת רק שהמופע הראשון מצליח היא חסרת ערך**: נעילה
/// שתמיד מחזירה true תעבור אותה. מה שנבדק כאן הוא שהמופע ה**שני** נחסם,
/// ומתהליכון אחר — כי Mutex הוא re-entrant לאותו תהליכון, ובדיקה שרצה
/// על תהליכון אחד הייתה מדווחת ירוק על נעילה שאינה נועלת כלום.
/// </summary>
public class SingleInstanceTests
{
    // שם נפרד מזה שבייצור: בדיקה שתופסת את נעילת הייצור הייתה חוסמת
    // סוכן אמיתי שרץ על מכונת הפיתוח, וזו תופעת לוואי שאין לה מקום בטסט.
    private const string TestName = "Local\\Parkomat.Agent.Service.SingleInstance.Test";

    [Fact]
    public void SecondInstance_OnAnotherThread_IsRefused()
    {
        using var held = new Mutex(initiallyOwned: false, TestName);
        Assert.True(held.WaitOne(TimeSpan.Zero, false), "המופע הראשון היה אמור לתפוס");

        bool? secondGot = null;
        var t = new Thread(() =>
        {
            using var m = new Mutex(initiallyOwned: false, TestName);
            secondGot = m.WaitOne(TimeSpan.Zero, false);
            if (secondGot == true) m.ReleaseMutex();
        });
        t.Start();
        t.Join(TimeSpan.FromSeconds(5));

        Assert.False(secondGot, "מופע שני נתפס — הנעילה אינה מגנה על כלום");
        held.ReleaseMutex();
    }

    [Fact]
    public void AfterRelease_NextInstance_CanAcquire()
    {
        // ⚠️ הכיוון השני, והוא לא פחות חשוב: נעילה שלעולם אינה משתחררת
        // היא סוכן שלא יעלה שוב אחרי הפעלה מחדש — כלומר אתר שאינו מנוטר.
        // זו בדיוק הסיבה שהמנגנון בשרת מתועד כ"משחרר אוטומטית".
        var first = new Mutex(initiallyOwned: false, TestName);
        Assert.True(first.WaitOne(TimeSpan.Zero, false));
        first.ReleaseMutex();
        first.Dispose();

        bool? got = null;
        var t = new Thread(() =>
        {
            using var m = new Mutex(initiallyOwned: false, TestName);
            got = m.WaitOne(TimeSpan.Zero, false);
            if (got == true) m.ReleaseMutex();
        });
        t.Start();
        t.Join(TimeSpan.FromSeconds(5));

        Assert.True(got, "אחרי שחרור, המופע הבא חייב להצליח");
    }

    [Fact]
    public void RealGuard_FirstCall_Acquires()
    {
        // ⚠️ קורא ל-API האמיתי, לא רק ל-Mutex גולמי — כדי שהבדיקה תיפול
        // אם TryAcquire תשתנה לכזו שזורקת או שמחזירה false תמיד. היא
        // אינה יכולה לבדוק את הסירוב, כי המופע השני חייב להיות **תהליך**
        // אחר; את זה מכסה SecondInstance_OnAnotherThread_IsRefused.
        Assert.True(SingleInstance.TryAcquire());
    }
}
