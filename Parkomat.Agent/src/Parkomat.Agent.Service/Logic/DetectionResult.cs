using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Service.Logic;

/// <summary>
/// התוצאה של קריאה אחת מה-PLC: מה צריך לשדר.
/// יכולה להכיל הודעת state (אם המצב השתנה) ו/או הודעות operation
/// (אם התחילה/הסתיימה כניסה או יציאה). לפעמים ריקה לגמרי — ואז לא משדרים כלום.
/// </summary>
public class DetectionResult
{
    /// <summary>הודעת state לשידור, או null אם המצב לא השתנה.</summary>
    public StateMessage? State { get; set; }

    /// <summary>
    /// הודעות operation לשידור (0, 1 או 2).
    /// לדוגמה: מעבר 2→3 מייצר שתיים — end להכנסה ו-start ליציאה.
    /// </summary>
    public List<OperationMessage> Operations { get; } = new();

    /// <summary>true אם אין מה לשדר בכלל (חוסך שידור מיותר).</summary>
    public bool IsEmpty => State is null && Operations.Count == 0;
}