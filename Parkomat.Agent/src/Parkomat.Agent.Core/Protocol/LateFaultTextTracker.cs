namespace Parkomat.Agent.Core.Protocol;

/// <summary>מה לעשות בסבב הנוכחי לגבי תיאור התקלה שטרם הגיע.</summary>
public enum LateFaultTextStep
{
    /// <summary>אין למה לחכות — לא לקרוא מהבקר.</summary>
    Idle,

    /// <summary>לקרוא עכשיו את רגיסטר התיאור.</summary>
    ReadNow,

    /// <summary>להפסיק לחכות: המצב כבר אינו תקלה, או שנגמרו הדגימות.</summary>
    GiveUp,
}

/// <summary>
/// ============================================================
/// התיאור שהגיע באיחור — ההחלטה בלבד, בלי רשת ובלי בקר
/// ============================================================
/// <para>הבקר כותב את טקסט התקלה <b>אחרי</b> ה-MODE, ולכן כמחצית מהודעות
/// ה-error יוצאות בלי תיאור כלל. המנגנון הזה ממשיך לדגום אחרי הודעה כזו
/// ומשלים את התיאור בשידור נפרד.</para>
///
/// <para>⚠️ <b>למה מחלקה נפרדת, ולא עוד עשרים שורות ב-Worker.</b> עד היום
/// ההחלטה הזו ישבה בתוך לולאה של 1,500 שורות שאף בדיקה אינה מריצה — נמדד
/// בביקורת 23/09/2026: <b>117 מתוך 587 הבדיקות קוראות קוד מקור כטקסט</b>,
/// ו-<c>Worker.cs</c>, שבו יושבת כל ההחלטה אם אתר מדווח, אינו מורץ אף פעם.
/// התוצאה הייתה ששני באגים רצופים — 1.0.53 ו-1.0.55 — נשלחו לשטח כשהחבילה
/// ירוקה. מה שאפשר לבודד, אפשר להריץ.</para>
///
/// <para>⚠️ <b>ואין כאן שום ידיעה על MQTT, וזו הנקודה.</b> כל המנגנון ישב
/// בתוך <c>if (config.MqttEnabled)</c>, כלומר באתר שה-MQTT כבוי בו הוא לא
/// רץ מעולם. מחלקה שאינה יודעת מה זה ברוקר אינה יכולה לחזור לשם.</para>
/// </summary>
public sealed class LateFaultTextTracker
{
    /// <summary>
    /// ⚠️ 120 דגימות — כשתי דקות בקצב ברירת המחדל. התיאור מגיע תוך שניות
    /// בודדות כשהוא מגיע; התקרה קיימת כדי שתקלה ממושכת לא תקרא את רגיסטר
    /// הטקסט בלולאה אינסופית, לא כדי לתת לו זמן.
    /// </summary>
    public const int DefaultMaxPolls = 120;

    private readonly int _maxPolls;
    private bool _awaiting;
    private int _polls;

    public LateFaultTextTracker(int maxPolls = DefaultMaxPolls) => _maxPolls = maxPolls;

    /// <summary>האם ממתינים כרגע לתיאור.</summary>
    public bool Awaiting => _awaiting;

    /// <summary>כמה דגימות כבר נעשו בהמתנה הנוכחית.</summary>
    public int Polls => _polls;

    /// <summary>
    /// נקראת בכל סבב שבו המוח הפיק <b>שינוי מצב</b>.
    ///
    /// <para>⚠️ תקלה שכבר יצאה עם תיאור אינה דורכת כלום — אין מה להשלים.
    /// ומצב שאינו תקלה <b>מכבה</b> המתנה קודמת, כי התיאור שהיה נקרא עכשיו
    /// שייך לתקלה שנגמרה, ושליחתו הייתה מדביקה תיאור שגוי למקטע הבא.</para>
    /// </summary>
    public void OnStateProduced(SiteState state, string? faultText)
    {
        _awaiting = state == SiteState.Error && string.IsNullOrEmpty(faultText);
        _polls = 0;
    }

    /// <summary>
    /// נקראת <b>בכל סבב</b>, גם כשלא היה שינוי מצב — התיאור מגיע סבבים
    /// אחדים אחרי השינוי, ואז כבר אין <c>result.State</c>.
    /// </summary>
    /// <param name="currentState">
    /// המצב הנגזר מה-MODE שנקרא בסבב הזה.
    /// <para>⚠️ <b>מקבל <c>null</c>, וזה לא סתם התאמת טיפוס.</b>
    /// ‏<c>ModeTranslator.FromMode</c> מחזיר <c>null</c> על MODE שאינו מוכר —
    /// הבקר באתחול, או כתובת רגיסטר שהוקלדה שגוי. מצב כזה <b>מפסיק</b> את
    /// ההמתנה, בדיוק כמו התאוששות: אין תקלה ידועה שאפשר להשלים לה תיאור,
    /// והמשך דגימה של 80 רגיסטרים בכל סבב הוא עומס על בקר שממילא לא בריא.</para>
    /// </param>
    public LateFaultTextStep Next(SiteState? currentState)
    {
        if (!_awaiting) return LateFaultTextStep.Idle;

        // ⚠️ סדר הבדיקות אינו אדיש: המונה עולה **רק** כשהמצב עדיין תקלה.
        // בדיקה הפוכה הייתה שורפת את התקרה על סבבים שבהם ממילא אין מה לקרוא.
        if (currentState != SiteState.Error || ++_polls > _maxPolls)
        {
            _awaiting = false;
            return LateFaultTextStep.GiveUp;
        }

        return LateFaultTextStep.ReadNow;
    }

    /// <summary>נקראת כשהקריאה מהבקר החזירה טקסט — ההמתנה נגמרה.</summary>
    public void OnTextFound() => _awaiting = false;
}
