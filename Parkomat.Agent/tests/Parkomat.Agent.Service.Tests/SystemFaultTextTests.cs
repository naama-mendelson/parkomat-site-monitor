using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Supabase;
using Parkomat.Agent.Service.Logic;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// טקסט התקלה של מערכת אחת באתר דו-מערכתי (13/10/2026: "ברגע שקיימת תקלה אני רוצה שיהיה כתוב מה התקלה").
/// מצב האתר המאוחד אינו משתנה — זה לתצוגה בכרטיס בלבד, ולכן נבדק: מתי קוראים מהבקר, למי מוצמד הטקסט, ומה
/// יוצא לרשת.
/// </summary>
public class SystemFaultLatchTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 13, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void NoFault_NothingToRead_NoText()
    {
        var l = new SystemFaultLatch();
        Assert.False(l.Due(false, T0));
        Assert.Null(l.Text);
    }

    [Fact]
    public void EnteringFault_ReadsAtOnce_ThenNotEverySample()
    {
        var l = new SystemFaultLatch();
        Assert.True(l.Due(true, T0));
        l.Set("מנהל דולים - דלתות חניון פתוחות:");
        Assert.Equal("מנהל דולים - דלתות חניון פתוחות:", l.Text);
        // ⚠️ הקריאה ממתינה עד שנייה וכותבת ללוג — לא בכל דגימה
        Assert.False(l.Due(true, T0.AddSeconds(1)));
        Assert.False(l.Due(true, T0.AddMinutes(4)));
        // רענון — אם התקלה עצמה התחלפה
        Assert.True(l.Due(true, T0 + SystemFaultLatch.Refresh));
    }

    [Fact]
    public void NoTextYet_RetriesEvery30Seconds()
    {
        var l = new SystemFaultLatch();
        Assert.True(l.Due(true, T0));
        l.Set(null);                                   // הבקר עוד לא כתב
        Assert.Null(l.Text);
        Assert.False(l.Due(true, T0.AddSeconds(10)));
        Assert.True(l.Due(true, T0 + SystemFaultLatch.Retry));
        l.Set("שאטל לא באוטומט");
        Assert.Equal("שאטל לא באוטומט", l.Text);
    }

    [Fact]
    public void FailedRead_DoesNotEraseKnownText()
    {
        var l = new SystemFaultLatch();
        l.Due(true, T0);
        l.Set("דלתות פתוחות");
        l.Due(true, T0 + SystemFaultLatch.Refresh);
        l.Set("");                                     // קריאה שנכשלה — היעדר מידע, לא "התקלה נעלמה"
        Assert.Equal("דלתות פתוחות", l.Text);
    }

    [Fact]
    public void FaultEnds_TextCleared_AndNextFaultStartsFresh()
    {
        var l = new SystemFaultLatch();
        l.Due(true, T0);
        l.Set("תקלה ראשונה");
        Assert.False(l.Due(false, T0.AddMinutes(1)));
        Assert.Null(l.Text);
        // ⚠️ תוצאה שמגיעה אחרי שהתקלה הסתיימה — נזרקת, ולא מוצמדת לתקלה הבאה
        l.Set("מאוחר");
        Assert.Null(l.Text);
        Assert.True(l.Due(true, T0.AddMinutes(2)));     // תקלה חדשה — קוראים מיד
        Assert.Null(l.Text);
    }
}

public class SystemFaultSnapshotTests
{
    [Fact]
    public void Text_IsAttachedOnlyToTheSystemInFault()
    {
        // מערכת 1 מוכנה (MODE 1), מערכת 2 בתקלה (MODE 5) — כמו בפלורנטין
        var s = TwoSystemDetector.Snapshot(1, "", 5, "133", "דלתות חניון פתוחות");
        Assert.Null(s[0].Fault);
        Assert.Equal("דלתות חניון פתוחות", s[1].Fault);
    }

    [Fact]
    public void BothInFault_BothCarryTheText_NoneInFault_NoText()
    {
        var both = TwoSystemDetector.Snapshot(5, "", 5, "", "תקלה");
        Assert.All(both, u => Assert.Equal("תקלה", u.Fault));
        var none = TwoSystemDetector.Snapshot(1, "", 2, "9", "שארית");
        Assert.All(none, u => Assert.Null(u.Fault));
    }

    [Fact]
    public void Payload_CarriesTheText_InHebrew_NotEscaped()
    {
        var s = TwoSystemDetector.Snapshot(1, "", 5, "133", "מנהל דולים - דלתות חניון פתוחות:");
        string body = BatchPayload.Serialize(Array.Empty<BatchItem>(), "1.0.58", BatchPayload.Systems(s));
        Assert.Contains("\"fault\":\"מנהל דולים - דלתות חניון פתוחות:\"", body);
        // המערכת שעובדת — בלי טקסט
        Assert.DoesNotMatch("\"unit\":1[^}]*\"fault\":\"", body);
    }
}

public class SystemFaultLatchUnitsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 13, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void WhichSystemsAreInFault_Changes_ReadAgainAtOnce_AndDropTheOldText()
    {
        // נמצא בסקירה: 1 נופלת (טקסט א'), 2 נופלת לפני ש-1 חזרה, ואז 1 חוזרת — "יש תקלה" לא התחלף, והכרטיס הציג
        // "מערכת 2: א'" עד 5 דקות. עכשיו כל שינוי בקבוצה הוא תקלה חדשה.
        var l = new SystemFaultLatch();
        Assert.True(l.Due("1", T0));
        l.Set("א");
        Assert.True(l.Due("1,2", T0.AddSeconds(5)));     // גם 2 נפלה — קוראים שוב
        Assert.Null(l.Text);                             // הטקסט הישן לא נשאר עד שתגיע התשובה
        l.Set("ב");
        Assert.True(l.Due("2", T0.AddSeconds(10)));      // 1 חזרה — קוראים שוב
        l.Set("ב");
        Assert.Equal("ב", l.Text);
        Assert.False(l.Due("2", T0.AddSeconds(11)));     // אותה קבוצה — לא בכל דגימה
        Assert.False(l.Due("", T0.AddSeconds(12)));
        Assert.Null(l.Text);
    }
}
