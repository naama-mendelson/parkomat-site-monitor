namespace Parkomat.Agent.Service.Modbus;

/// <summary>
/// תוצאת קריאה אחת מה-PLC — שלושת הנתונים הגולמיים, כמו שהם.
/// בלי פירוש ובלי החלטות; הפירוש נעשה במוח (OperationDetector).
/// </summary>
public class PlcReading
{
    /// <summary>ה-MODE הגולמי (0-5).</summary>
    public int Mode { get; init; }

    /// <summary>מספר הכרטיס. ריק ("") אם אין.</summary>
    public string CardNumber { get; init; } = "";

    /// <summary>המונה המצטבר מהבקר. **משותף לשתי המערכות** באתר דו-מערכתי.</summary>
    public int CycleCounter { get; init; }

    // ============================================================
    // ⚠️ המערכת השנייה — null באתר רגיל, ולא 0
    // ============================================================
    // אפס הוא MODE חוקי (תחזוקה), ולכן `int` עם ברירת מחדל 0 היה אומר
    // "המערכת השנייה בתחזוקה" בכל 21 האתרים החד-מערכתיים. הבחנה בין
    // "אין מערכת" ל"יש והיא בתחזוקה" חייבת להיות מפורשת.
    public int? Mode2 { get; init; }

    /// <summary>מספר הכרטיס של המערכת השנייה. <c>null</c> אם אין מערכת שנייה.</summary>
    public string? CardNumber2 { get; init; }
}