using System.Text.Json.Serialization;

namespace Parkomat.Agent.Core.Protocol;

/// <summary>
/// חמשת מצבי המערכת, בדיוק כפי שהשרת (Master) מקבל ואוכף.
/// שימי לב: אלה *לא* מספרי ה-MODE של ה-PLC — הם התוצאה אחרי תרגום.
/// כל ערך ממופה למחרוזת המדויקת שהשרת דורש (אותיות קטנות, no_comm עם קו תחתון).
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<SiteState>))]
public enum SiteState
{
    /// <summary>מוכן / idle — האתר תקין וממתין.</summary>
    [JsonStringEnumMemberName("ready")]
    Ready,

    /// <summary>בפעולה — מתבצע סייקל חניה פעיל (הכנסה או הוצאה).</summary>
    [JsonStringEnumMemberName("operating")]
    Operating,

    /// <summary>תקלה — האתר מושבת/בתקלה.</summary>
    [JsonStringEnumMemberName("error")]
    Error,

    /// <summary>בתחזוקה — האתר לא באוטומט.</summary>
    [JsonStringEnumMemberName("maintenance")]
    Maintenance,

    /// <summary>אין תקשורת — נגזר בשרת דרך LWT. משמש רק בהודעת הצוואה.</summary>
    [JsonStringEnumMemberName("no_comm")]
    NoComm
}