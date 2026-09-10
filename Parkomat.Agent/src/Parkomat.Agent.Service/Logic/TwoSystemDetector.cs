using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Service.Logic;

/// <summary>
/// אתר עם <b>שתי מערכות בבקר אחד</b> (פלורנטין).
///
/// <para>⚠️ <b>שני גלאים נפרדים, וזו הנקודה כולה.</b> תפעולים מזוהים
/// מ<b>מעברי</b> MODE, עם זיכרון של המצב הקודם. אילו שתי המערכות היו
/// ממוזגות למצב אחד לפני הזיהוי, מערכת 1 שעוברת 1→2 בזמן שמערכת 2
/// עומדת ב-1 הייתה מייצרת רצף מעברים מזויף — <b>תפעולים שלא קרו, או
/// תפעולים שאובדים</b>. כל מערכת מקבלת גלאי משלה.</para>
///
/// <para><b>ההיפוך קורה אחר כך:</b> התפעולים משתיהן נספרים לאתר, והמצב
/// המשודר הוא <b>אחד</b> — ‏<c>SiteStateAggregator</c>. כך
/// ‏<c>ingest_state</c> בשרת ממשיכה לקבל בדיוק את מה שקיבלה תמיד.</para>
///
/// <para>⚠️ <b>ומונה המחזורים משותף</b> (רגיסטר 292 בבקר), ולכן הוא נמסר
/// לשני הגלאים כפי שהוא. הוא מונה של האתר, לא של מערכת.</para>
/// </summary>
public class TwoSystemDetector
{
    private readonly OperationDetector _first;
    private readonly OperationDetector _second;
    private readonly Func<long> _now;

    // ⚠️ המצב המאוחד האחרון — כולל null. אילו null לא היה נשמר, מעבר
    // דרך MODE 4 (init) לא היה מייצר שידור-חוזר של המצב אחריו, בניגוד
    // להתנהגות של אתר חד-מערכתי.
    private SiteState? _lastCombined;
    private bool _seen;

    public TwoSystemDetector(Func<long>? now = null)
    {
        _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        _first = new OperationDetector(_now);
        _second = new OperationDetector(_now);
    }

    public OperationDetector First => _first;
    public OperationDetector Second => _second;

    public DetectionResult Process(
        int mode1, string card1, int mode2, string card2, int cycleCounter)
    {
        // ⚠️ שני הגלאים רצים **תמיד**, גם כשהמצב המאוחד לא זז: תפעול
        // במערכת אחת אינו תלוי במה שקורה בשנייה.
        DetectionResult r1 = _first.Process(mode1, card1, cycleCounter);
        DetectionResult r2 = _second.Process(mode2, card2, cycleCounter);

        var result = new DetectionResult();
        result.Operations.AddRange(r1.Operations);
        result.Operations.AddRange(r2.Operations);

        SiteState? s1 = ModeTranslator.FromMode(mode1);
        SiteState? s2 = ModeTranslator.FromMode(mode2);
        SiteState? combined = SiteStateAggregator.Combine(s1, s2);

        // ⚠️ **הודעות ה-state של שני הגלאים נזרקות בכוונה.** כל אחת מהן
        // מתארת מערכת אחת, ואילו שודרו — האתר היה מקבל שני מצבים סותרים
        // באותה שנייה, ומקטע היה נפתח ונסגר על כל שינוי בכל מערכת.
        if (combined.HasValue && (!_seen || combined != _lastCombined))
        {
            result.State = new StateMessage
            {
                Timestamp = _now(),
                State = combined.Value,
                Systems = Snapshot(s1, card1, s2, card2),
            };
        }

        _lastCombined = combined;
        _seen = true;

        return result;
    }

    /// <summary>
    /// תצלום המערכות לתצוגה. ⚠️ מערכת שמצבה אינו ידוע (MODE 4 = init)
    /// מדווחת עם המצב האחרון שהיה לה? <b>לא</b> — היא מדווחת כפי שהיא,
    /// כי תצוגה שמראה מצב ישן כאילו הוא נוכחי גרועה מתצוגה שמודה שאינה
    /// יודעת. לכן מערכת לא ידועה פשוט אינה מופיעה ברשימה.
    /// </summary>
    public static SystemState[] Snapshot(
        SiteState? s1, string card1, SiteState? s2, string card2)
    {
        var list = new List<SystemState>(2);

        if (s1.HasValue) list.Add(new SystemState { Unit = 1, State = s1.Value, Car = card1 });
        if (s2.HasValue) list.Add(new SystemState { Unit = 2, State = s2.Value, Car = card2 });

        return list.ToArray();
    }
}
