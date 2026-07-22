using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Service.Logic;

/// <summary>תוצאת החלטת ה-resync: האם לשדר, איזה state, ומדוע (ללוג).</summary>
public readonly record struct ResyncDecision(bool ShouldPublish, SiteState State, string Reason);

/// <summary>
/// מחליט מתי לשדר מחדש את המצב הנוכחי ("resync"), כולל הודעת-הלידה (birth) בעלייה.
/// פונקציה טהורה — כל התלות היא בפרמטרים, כדי שההחלטה תהיה ניתנת לבדיקה בלי MQTT/PLC.
///
/// ארבעה טריגרים משדרים מחדש את המצב עם חותם זמן טרי:
///  1. birth — השידור המוצלח הראשון בעלייה (מוציא אתר מ-no_comm ישן בלי לחכות לשינוי).
///  2. חזרה להתחבר ל-Broker המקומי.
///  3. התאוששות PLC מתקלה (אחרת אם ה-MODE זהה, ה-detector לא ישדר והשרת יישאר על error).
///  4. חזרת הגשר ל-HiveMQ.
///
/// ה-state שנשלח הוא הנוכחי אם הוא ממופה, אחרת האחרון שידענו (lastKnown) — כך MODE 4
/// (init → null) לא מונע resync ולא משאיר אתר תקוע על error/no_comm. אם אין אף מצב
/// ממופה (עלייה טרייה בתוך init) — לא משדרים, וה-birth נדחה עד המצב הממופה הראשון.
/// </summary>
public static class ResyncPolicy
{
    public static ResyncDecision Decide(
        bool birthMessageSent,
        bool mqttWasConnected,
        bool plcJustRecovered,
        bool bridgeJustReconnected,
        SiteState? currentState,
        SiteState? lastKnownState)
    {
        SiteState? resyncState = currentState ?? lastKnownState;

        bool triggered = !birthMessageSent
                      || !mqttWasConnected
                      || plcJustRecovered
                      || bridgeJustReconnected;

        if (!triggered || !resyncState.HasValue)
            return new ResyncDecision(false, default, "");

        // סדר העדיפויות בתווית תואם לסדר ההיסטורי; birth נבדק ראשון.
        string reason = !birthMessageSent ? "startup birth message"
            : !mqttWasConnected ? "reconnected to broker"
            : bridgeJustReconnected ? "HiveMQ bridge reconnected"
            : "PLC recovered";

        return new ResyncDecision(true, resyncState.Value, reason);
    }
}
