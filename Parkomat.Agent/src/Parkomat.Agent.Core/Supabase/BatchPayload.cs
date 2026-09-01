using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;
using System.Text.Json.Serialization;
using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Core.Supabase;

/// <summary>פריט אחד באצווה שנשלחת ל-<c>public.ingest_batch</c>.</summary>
public sealed class BatchItem
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("occurred_at")] public string OccurredAt { get; set; } = "";

    // --- state ---
    [JsonPropertyName("status")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Status { get; set; }

    [JsonPropertyName("fault_text")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FaultText { get; set; }

    // --- operation ---
    [JsonPropertyName("start_end")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? StartEnd { get; set; }

    [JsonPropertyName("entry_exit")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? EntryExit { get; set; }

    [JsonPropertyName("card")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Card { get; set; }

    [JsonPropertyName("state")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? State { get; set; }

    [JsonPropertyName("reported_at")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ReportedAt { get; set; }

    [JsonPropertyName("cycle")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Cycle { get; set; }
}

/// <summary>
/// ממיר הודעות סוכן למטען של <c>public.ingest_batch</c>. <b>טהור</b>.
///
/// <para>
/// ⚠️ <b>זהו החוזה מול השרת</b>, והוא נבדק בשני צדדים: כאן ביחידה, ובשרת
/// ב-<c>check-agent-write</c> שקורא לפונקציה דרך הרשת עם אותה צורה בדיוק.
/// שדה שנקרא כאן בשם אחר אינו נכשל — הוא מגיע כ-<c>NULL</c>, וההודעה
/// נכתבת חסרה. זה בדיוק הכשל השקט שהחוזה מול MQTT כבר תיעד על
/// <c>user</c> שחייב להיות <c>""</c> ולא <c>null</c>.
/// </para>
///
/// <para>
/// ⚠️ <b>חותם הזמן הוא ISO-8601 ב-UTC</b>, ולא unix seconds כמו ב-MQTT.
/// השרת שומר תאריכים כ-TEXT ומשווה אותם <b>לקסיקלית</b>, ולכן הפורמט חייב
/// להיות אחיד לכל אורכו — שלוש ספרות מילישנייה וסיומת Z. פורמט אחר עדיין
/// "עובד" ומייצר סדר שגוי בהשוואות טווח.
/// </para>
/// </summary>
public static class BatchPayload
{
    private const string Iso = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    // ⚠️ **מקודד עברית כמות שהיא, ולא כ-\uXXXX.** ברירת המחדל של
    // System.Text.Json בורחת מכל תו שאינו ASCII, וזה JSON תקין לחלוטין —
    // אבל תיאור תקלה בעברית תופח פי שישה, ובעיקר: הוא נשמר כך ב-
    // ingest_drops.payload. מי שיחקור הודעה שנזרקה בעוד חצי שנה יראה
    // \u05DE\u05D9\u05D8 במקום "מיטה 5", וזו בדיוק השורה שהוא בא לקרוא.
    //
    // ⚠️ UnicodeRanges.All ולא UnsafeRelaxed: הראשון מתיר יוניקוד ושומר
    // על הבריחה של < > & — המטען אמנם הולך ל-API ולא ל-HTML, אבל ויתור
    // על הגנה "כי כאן זה לא רלוונטי" הוא בדיוק מה שמתגלה כרלוונטי אחר כך.
    private static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };

    /// <summary>חותם unix (שניות) → ISO-8601 UTC, בדיוק בפורמט שהשרת כותב.</summary>
    public static string Stamp(long unixSeconds) =>
        DateTimeOffset.FromUnixTimeSeconds(unixSeconds)
            .UtcDateTime.ToString(Iso, CultureInfo.InvariantCulture);

    public static BatchItem From(StateMessage m) => new()
    {
        Kind = "state",
        Status = SiteStateJson.Name(m.State),
        OccurredAt = Stamp(m.Timestamp),
        // ⚠️ מחרוזת ריקה נשלחת כ-null: השרת עושה NULLIF ממילא, ושליחת ""
        // הייתה כותבת תיאור תקלה ריק במקום להשאיר את השדה פנוי לתיאור
        // שיגיע באיחור.
        FaultText = string.IsNullOrEmpty(m.FaultText) ? null : m.FaultText,
    };

    public static BatchItem From(OperationMessage m) => new()
    {
        Kind = "operation",
        StartEnd = m.StartEnd,
        EntryExit = m.EntryExit,
        // ⚠️ הכרטיס נשלח כ-"" ולא כ-null, בדיוק כמו בחוזה ה-MQTT: הוא חלק
        // ממפתח הדדופ בשרת, ו-null היה משנה את המפתח.
        Card = m.User ?? "",
        State = SiteStateJson.Name(m.State),
        OccurredAt = Stamp(m.Timestamp),
        ReportedAt = Stamp(m.Timestamp),
        Cycle = m.CycleCounter,
    };

    /// <summary>גוף הבקשה המלא: <c>{"p_messages": [...]}</c>.</summary>
    public static string Serialize(IEnumerable<BatchItem> items) =>
        JsonSerializer.Serialize(new { p_messages = items }, Json);
}

/// <summary>
/// שם ה-JSON של מצב אתר.
///
/// ⚠️ מופרד מ-<c>SiteState</c> עצמו כדי שההמרה תהיה **פונקציה** שאפשר
/// לבדוק, ולא תופעת לוואי של סריאליזציה. השמות נאכפים בשרת, ושינוי שלהם
/// שובר קליטה בשקט.
/// </summary>
public static class SiteStateJson
{
    public static string Name(SiteState s) => s switch
    {
        SiteState.Ready => "ready",
        SiteState.Operating => "operating",
        SiteState.Error => "error",
        SiteState.Maintenance => "maintenance",
        SiteState.NoComm => "no_comm",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "מצב לא מוכר — השרת ידחה אותו"),
    };
}
