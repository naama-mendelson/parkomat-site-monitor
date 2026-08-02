using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Service.Logic;

/// <summary>
/// המוח של ה-Agent: מקבל קריאה גולמית מה-PLC בכל דגימה,
/// זוכר את הקריאה הקודמת, ומחליט אילו הודעות לשדר (state ו/או operation).
/// לא שולח כלום בעצמו — רק מחליט. השליחה נעשית במקום אחר.
/// </summary>
public class OperationDetector
{
    // מקור הזמן לחותמות. מוזרק כדי שהזמן יגיע מ-AgentClock (מסונכרן NTP)
    // ולא משעון המחשב הגולמי. ברירת המחדל היא השעון המקומי — כך הבדיקות
    // וכל קורא שלא מספק שעון ממשיכים לעבוד בדיוק כמו קודם.
    private readonly Func<long> _now;

    public OperationDetector(Func<long>? now = null)
        => _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds());

    // ה-MODE מהקריאה הקודמת. null = עדיין לא ראינו אף קריאה (הרצה ראשונה).
    private int? _previousMode = null;

    /// <summary>
    /// משחזר מצב מהרצה קודמת, כדי שהפעלה מחדש לא תיראה כמו "הרצה ראשונה".
    ///
    /// בלי זה, כל עלייה באמצע מחזור (MODE 2/3) פותחת פעולה חדשה עם חותם
    /// "עכשיו" — פעולה פיקטיבית שמנפחת את מכנה אחוז הכשל (ראה
    /// AgentPaths.DetectorStateFile). עם זה, הסוכן ממשיך מאיפה שהפסיק:
    /// אם ה-MODE לא זז — אין הודעה; אם זז — נוצרות end/start אמיתיות.
    ///
    /// ⚠️ מיועד לקריאה **לפני** ה-Process הראשון בלבד. קריאה באמצע ריצה
    /// הייתה דורסת את מצב הזיכרון החי ומייצרת מעבר מדומה, ולכן היא נחסמת.
    /// </summary>
    public void Restore(int previousMode, string operationCard)
    {
        if (_previousMode.HasValue)
            throw new InvalidOperationException(
                "Restore נקרא אחרי שה-detector כבר עיבד קריאה. המצב נטען פעם אחת בלבד, בעלייה.");

        _previousMode = previousMode;
        _operationCard = operationCard ?? "";
    }

    /// <summary>ה-MODE האחרון שעובד, או null אם עדיין לא עובדה אף קריאה.</summary>
    public int? PreviousMode => _previousMode;

    /// <summary>הכרטיס של הפעולה הפתוחה, לשמירה בין הרצות.</summary>
    public string OperationCard => _operationCard;

    // הכרטיס של הפעולה *הפתוחה* — נתפס בתחילתה, ומתעדכן לכל כרטיס לא-ריק לאורכה.
    // חשוב לסגירה (end): במקצת הבקרים רגיסטר הכרטיס מתאפס ל-0 *לפני* שה-MODE יוצא
    // ממצב הפעולה — קורה ביציאה (exit). שימוש בכרטיס מהקריאה הקודמת בלבד היה מאבד
    // אותו, ו-exit/end היה יוצא בלי כרטיס למרות ש-exit/start כן נשא אותו.
    private string _operationCard = "";

    /// <summary>
    /// מעבד קריאה אחת מה-PLC ומחזיר מה צריך לשדר.
    /// </summary>
    /// <param name="mode">ה-MODE הגולמי שנקרא מה-PLC (0-5).</param>
    /// <param name="cardNumber">מספר הכרטיס. ריק ("") אם אין.</param>
    /// <param name="cycleCounter">המונה המצטבר מהבקר.</param>
    public DetectionResult Process(int mode, string cardNumber, int cycleCounter)
    {
        var result = new DetectionResult();
        long now = _now();

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
        // ==========================================================
        // קריאה ראשונה שנוחתת *באמצע* פעולה
        // ==========================================================
        // קודם לא נפתחה כאן פעולה, כי אין MODE קודם להשוות אליו. זה נראה שמרני,
        // אבל בשטח זה יצר שתי תקלות אמיתיות (נצפו באתרים אביגיל 20 ומגדל 1):
        //
        //   1. האתר הוצג "בפעולה" בלי כיוון ובלי כרטיס — כי שום פעולה לא נוצרה,
        //      והכיוון (MODE 2=כניסה, 3=יציאה) לא נשלח בהודעת המצב.
        //   2. גרוע יותר: כשה-MODE סוף-סוף זז, שודר `end` **בלי `start` תואם** —
        //      פעולה יתומה. שיוך המשכים לא מוצא לה התחלה, והספירה מתעוותת.
        //
        // הסוכן *כן* יודע מה קורה — הוא קורא את ה-MODE ואת הכרטיס ברגע זה. לכן
        // פותחים את הפעולה. חותם הזמן הוא "עכשיו" ולא רגע הכניסה האמיתי (שלא
        // נצפה), וזו הפשרה המודעת: משך מוערך-בחסר עדיף על פעולה שאבדה כליל
        // ועל `end` יתום.
        if (!_previousMode.HasValue)
        {
            if (IsOperationMode(mode))
            {
                _operationCard = cardNumber;
                result.Operations.Add(BuildOperation(
                    startEnd: "start",
                    mode: mode,
                    now: now,
                    cardNumber: cardNumber,
                    cycleCounter: cycleCounter));
            }
        }
        else if (mode != _previousMode.Value)
        {
            // אם ה-MODE הקודם היה כניסה/יציאה — סוגרים אותו ב-end, עם הכרטיס שנתפס
            // *לאורך הפעולה* (לא רק מהקריאה הקודמת) — כדי שלא יאבד אם הרגיסטר התאפס
            // לפני סוף הפעולה (מה שקורה ביציאה).
            if (IsOperationMode(_previousMode.Value))
            {
                result.Operations.Add(BuildOperation(
                    startEnd: "end",
                    mode: _previousMode.Value,
                    now: now,
                    cardNumber: _operationCard,
                    cycleCounter: cycleCounter));
            }

            // אם ה-MODE החדש הוא כניסה/יציאה — פותחים אותו ב-start, ומתחילים לעקוב
            // אחרי הכרטיס של הפעולה החדשה מהרגע הזה.
            if (IsOperationMode(mode))
            {
                _operationCard = cardNumber;
                result.Operations.Add(BuildOperation(
                    startEnd: "start",
                    mode: mode,
                    now: now,
                    cardNumber: cardNumber,
                    cycleCounter: cycleCounter));
            }
        }
        else if (IsOperationMode(mode) && !string.IsNullOrEmpty(cardNumber))
        {
            // ה-MODE מוחזק על מצב פעולה — זוכרים את הכרטיס הלא-ריק האחרון שנראה,
            // כדי שיהיה זמין ל-end גם אם הרגיסטר יתאפס לפני שהפעולה תסתיים.
            _operationCard = cardNumber;
        }

        // --- שלב 3: זוכרים את ה-MODE הנוכחי לקראת הקריאה הבאה ---
        _previousMode = mode;

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