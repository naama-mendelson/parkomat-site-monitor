using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Service.Logic;

/// <summary>
/// המוח של ה-Agent: מקבל קריאה גולמית מה-PLC בכל דגימה,
/// זוכר את הקריאה הקודמת, ומחליט אילו הודעות לשדר (state ו/או operation).
/// לא שולח כלום בעצמו — רק מחליט. השליחה נעשית במקום אחר.
/// </summary>
public class OperationDetector
{
    // ה-MODE מהקריאה הקודמת. null = עדיין לא ראינו אף קריאה (הרצה ראשונה).
    private int? _previousMode = null;

    // מספר הכרטיס מהקריאה הקודמת. משמש לסגירת פעולה (end): בזמן שהמצב
    // עובר מפעולה למצב אחר, ה-PLC כבר עשוי לאפס את רגיסטר הכרטיס ל-0,
    // ולכן הכרטיס של הפעולה הוא זה שנקרא בקריאה הקודמת (כשהיא עדיין הייתה פעילה).
    private string _previousCard = "";

    /// <summary>
    /// מעבד קריאה אחת מה-PLC ומחזיר מה צריך לשדר.
    /// </summary>
    /// <param name="mode">ה-MODE הגולמי שנקרא מה-PLC (0-5).</param>
    /// <param name="cardNumber">מספר הכרטיס. ריק ("") אם אין.</param>
    /// <param name="cycleCounter">המונה המצטבר מהבקר.</param>
    public DetectionResult Process(int mode, string cardNumber, int cycleCounter)
    {
        var result = new DetectionResult();
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        // --- שלב 1: הודעת state (אם המצב המתורגם השתנה) ---
        SiteState? newState = ModeTranslator.FromMode(mode);
        SiteState? oldState = _previousMode.HasValue
            ? ModeTranslator.FromMode(_previousMode.Value)
            : null;

        // משדרים state רק אם יש מצב חוקי חדש, והוא שונה מהקודם.
        if (newState.HasValue && newState != oldState)
        {
            result.State = new StateMessage
            {
                Timestamp = now,
                State = newState.Value
            };
        }

        // --- שלב 2: הודעות operation ---
        // רק כשה-MODE באמת השתנה. אחרת, אם ה-PLC מחזיק את מצב הפעולה
        // לאורך כמה דגימות, היינו משדרים end+start מיותרים בכל דגימה.
        // (מעבר 2→3 עדיין מייצר שניים: end להכנסה + start ליציאה — כי ה-MODE שונה.)
        if (_previousMode.HasValue && mode != _previousMode.Value)
        {
            // אם ה-MODE הקודם היה כניסה/יציאה — סוגרים אותו ב-end.
            // הכרטיס נלקח מהקריאה הקודמת, כי בקריאה הנוכחית הוא כבר עלול להתאפס.
            if (IsOperationMode(_previousMode.Value))
            {
                result.Operations.Add(BuildOperation(
                    startEnd: "end",
                    mode: _previousMode.Value,
                    now: now,
                    cardNumber: _previousCard,
                    cycleCounter: cycleCounter));
            }

            // אם ה-MODE החדש הוא כניסה/יציאה — פותחים אותו ב-start.
            if (IsOperationMode(mode))
            {
                result.Operations.Add(BuildOperation(
                    startEnd: "start",
                    mode: mode,
                    now: now,
                    cardNumber: cardNumber,
                    cycleCounter: cycleCounter));
            }
        }

        // --- שלב 3: זוכרים את המצב הנוכחי לקראת הקריאה הבאה ---
        _previousMode = mode;
        _previousCard = cardNumber;

        return result;
    }

    // MODE של פעולה = כניסה (2) או יציאה (3).
    private static bool IsOperationMode(int mode) => mode == 2 || mode == 3;

    // בונה הודעת operation בודדת, עם entry/exit לפי ה-MODE.
    private static OperationMessage BuildOperation(
        string startEnd, int mode, long now, string cardNumber, int cycleCounter)
    {
        return new OperationMessage
        {
            Timestamp = now,
            StartEnd = startEnd,
            EntryExit = mode == 2 ? "entry" : "exit",
            User = cardNumber,
            CycleCounter = cycleCounter,
            State = SiteState.Operating   // בזמן פעולה המצב תמיד operating
        };
    }
}