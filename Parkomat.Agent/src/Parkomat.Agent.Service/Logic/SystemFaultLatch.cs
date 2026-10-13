namespace Parkomat.Agent.Service.Logic;

/// <summary>
/// טקסט התקלה של מערכת אחת באתר דו-מערכתי — מתי לקרוא אותו מהבקר, ומה להציג.
///
/// <para>
/// ⚠️ <b>למה זה קיים.</b> באתר דו-מערכתי מצב האתר הוא "הטוב מבין השתיים" (SiteStateAggregator),
/// והטקסט נקרא רק כשהמצב המאוחד הוא תקלה. לכן מערכת אחת שנפלה בזמן שהשנייה עובדת הופיעה על הכרטיס
/// כ"מערכת 2: תקלה" — בלי מילה על מה קרה. בעלת המוצר, 13/10/2026: "ברגע שקיימת תקלה אני רוצה שיהיה כתוב
/// מה התקלה" — הצגה בזמן אמת על הכרטיס בלבד, בלי היסטוריה (מצב האתר, הזמינות ואחוז הכשל לא משתנים).
/// </para>
///
/// <para>
/// ⚠️ <b>מתי קוראים.</b> הקריאה ממתינה ליציבות הטקסט (עד שנייה) וכותבת שורה ללוג, ולכן לא בכל דגימה:
/// מיד כשמערכת נכנסת לתקלה; שוב כל <see cref="Retry"/> כל עוד לא התקבל טקסט; ורענון כל
/// <see cref="Refresh"/> כל עוד התקלה נמשכת — אם התקלה עצמה התחלפה. כשאין מערכת בתקלה — נמחק.
/// </para>
///
/// <para>טהור: הזמן מוזרק, אין קריאה לבקר. Worker קורא ל-<see cref="Due"/> ו-<see cref="Set"/>.</para>
/// </summary>
public sealed class SystemFaultLatch
{
    public static readonly TimeSpan Retry = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan Refresh = TimeSpan.FromMinutes(5);

    private bool _active;
    private string? _text;
    private DateTimeOffset _lastRead = DateTimeOffset.MinValue;

    /// <summary>הטקסט להצגה, או null כשאין מערכת בתקלה / עוד לא נקרא.</summary>
    public string? Text => _active ? _text : null;

    /// <summary>
    /// נקרא בכל דגימה. מחזיר true כשהגיע הזמן לקרוא את הטקסט מהבקר (והקורא יעביר את התוצאה ל-<see cref="Set"/>).
    /// </summary>
    public bool Due(bool anySystemInError, DateTimeOffset now)
    {
        if (!anySystemInError)
        {
            // ⚠️ מנקים הכול: טקסט שנשאר מתקלה קודמת היה מוצמד לתקלה הבאה עד הקריאה הבאה
            _active = false;
            _text = null;
            _lastRead = DateTimeOffset.MinValue;
            return false;
        }

        if (!_active)
        {
            _active = true;
            _lastRead = now;
            return true;
        }

        TimeSpan wait = _text is null ? Retry : Refresh;
        if (now - _lastRead < wait) return false;
        _lastRead = now;
        return true;
    }

    /// <summary>
    /// תוצאת הקריאה. ⚠️ ריק אינו מוחק טקסט שכבר נקרא: קריאה שנכשלה היא היעדר מידע, לא "התקלה נעלמה"
    /// (אותו כלל כמו ב-ReadFaultTextOrNullAsync). ותוצאה שהגיעה אחרי שהתקלה כבר הסתיימה — נזרקת.
    /// </summary>
    public void Set(string? text)
    {
        if (!_active || string.IsNullOrWhiteSpace(text)) return;
        _text = text.Trim();
    }
}
