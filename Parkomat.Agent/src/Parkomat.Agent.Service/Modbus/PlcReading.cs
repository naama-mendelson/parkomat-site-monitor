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

    /// <summary>המונה המצטבר מהבקר.</summary>
    public int CycleCounter { get; init; }
}