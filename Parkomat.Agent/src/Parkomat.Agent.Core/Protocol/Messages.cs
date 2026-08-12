using System.Text.Json.Serialization;

namespace Parkomat.Agent.Core.Protocol;

/// <summary>
/// הודעת state שנשלחת ל-topic: sites/{code}/state — בכל שינוי מצב.
/// פורמט מדויק שהשרת מצפה לו: { "timestamp": <unix seconds>, "state": "ready" }
/// </summary>
public class StateMessage
{
    /// <summary>חותם זמן ביוניקס-שניות (לא מילישניות!).</summary>
    [JsonPropertyName("timestamp")]
    public long Timestamp { get; set; }

    /// <summary>המצב. מתורגם אוטומטית למחרוזת הנכונה (ready/operating/...).</summary>
    [JsonPropertyName("state")]
    public SiteState State { get; set; }

    /// <summary>
    /// תיאור התקלה כפי שהבקר חושף אותו. ריק/חסר כשאין תקלה.
    ///
    /// ============================================================
    /// למה זה שדה אופציונלי ולא חלק קבוע מהחוזה
    /// ============================================================
    /// ⚠️ **תאימות לאחור בשני הכיוונים, וזו לא תיאוריה:** הסוכן מותקן ידנית
    /// על מחשבים באתרי החניה, והם לא יתעדכנו כולם באותו יום.
    ///
    ///   • סוכן חדש מול שרת ישן — השרת מתעלם משדה שאינו מכיר.
    ///   • סוכן ישן מול שרת חדש — השדה חסר, והשרת רואה null.
    ///
    /// NullValueHandling: השדה **מושמט** כשהוא ריק ולא נשלח כמחרוזת ריקה.
    /// כך הודעת state רגילה נשארת בדיוק בגודל שהייתה — 99% מההודעות אינן
    /// תקלות, ואין סיבה שכולן יגדלו.
    /// </summary>
    [JsonPropertyName("faultText")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FaultText { get; set; }
}

/// <summary>
/// הודעת operation שנשלחת ל-topic: sites/{code}/operation —
/// בתחילת פעולה (start) ובסיומה (end).
/// שימי לב: גם הודעה זו *חייבת* לכלול state תקין — אחרת השרת דוחה אותה.
/// </summary>
public class OperationMessage
{
    /// <summary>חותם זמן ביוניקס-שניות.</summary>
    [JsonPropertyName("timestamp")]
    public long Timestamp { get; set; }

    /// <summary>"start" בתחילת הפעולה, "end" בסיומה.</summary>
    [JsonPropertyName("start_end")]
    public string StartEnd { get; set; } = "";

    /// <summary>"entry" להכנסה, "exit" להוצאה.</summary>
    [JsonPropertyName("entry_exit")]
    public string EntryExit { get; set; } = "";

    /// <summary>
    /// מספר הכרטיס. כשאין כרטיס — מחרוזת ריקה "" (לא null!),
    /// כי השרת משתמש בשדה הזה במפתח ה-dedup.
    /// </summary>
    [JsonPropertyName("user")]
    public string User { get; set; } = "";

    /// <summary>
    /// המונה המצטבר הגולמי מהבקר. נשלח בעיקר בהודעת ה-end.
    /// השרת מחשב לבד את ה-delta ומזהה reset — אנחנו רק מעבירים כמו שקראנו.
    /// </summary>
    [JsonPropertyName("cycle_counter")]
    public int CycleCounter { get; set; }

    /// <summary>המצב בזמן הפעולה (בדרך כלל operating). חובה, אחרת נדחה.</summary>
    [JsonPropertyName("state")]
    public SiteState State { get; set; }
}