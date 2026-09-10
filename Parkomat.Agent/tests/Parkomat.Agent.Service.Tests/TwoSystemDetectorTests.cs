using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Service.Logic;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>הסיבה שיש כאן שני גלאים ולא אחד.</b>
///
/// <para>תפעולים מזוהים מ<b>מעברי</b> MODE. אילו שתי המערכות היו ממוזגות
/// למצב אחד לפני הזיהוי, מערכת 1 שעוברת 1→2 בזמן שמערכת 2 עומדת ב-1
/// הייתה מייצרת רצף מעברים מזויף — תפעולים שלא קרו, או תפעולים שאובדים.
/// שני הגלאים הם מה שמונע את זה, והבדיקות כאן הן ההוכחה.</para>
/// </summary>
public class TwoSystemDetectorTests
{
    private static long _clock = 1_700_000_000;
    private static TwoSystemDetector New() => new(() => _clock);

    // ===== המצב המשודר הוא אחד =====

    [Fact]
    public void TheSiteReportsOneStateNotTwo()
    {
        var d = New();

        // מערכת 1 בתקלה, מערכת 2 ממתינה.
        DetectionResult r = d.Process(5, "42", 1, "", 20234);

        Assert.NotNull(r.State);
        Assert.Equal(SiteState.Ready, r.State!.State);   // הטוב מביניהן
    }

    // ⚠️ **והפירוט נוסע לצדו.** בלעדיו הכרטיס ירוק ואיש אינו יודע
    // שמערכת שלמה מושבתת — וזה בדיוק המחיר של כלל "הטוב מביניהן".
    [Fact]
    public void TheDetailOfBothSystemsRidesAlongsideTheState()
    {
        var d = New();

        DetectionResult r = d.Process(5, "42", 1, "", 20234);

        SystemState[] systems = r.State!.Systems!;
        Assert.Equal(2, systems.Length);

        Assert.Equal(1, systems[0].Unit);
        Assert.Equal(SiteState.Error, systems[0].State);
        Assert.Equal("42", systems[0].Car);

        Assert.Equal(2, systems[1].Unit);
        Assert.Equal(SiteState.Ready, systems[1].State);
        Assert.Equal("", systems[1].Car);
    }

    // ⚠️ מצב שלא זז אינו משודר שוב — אחרת כל דגימה (שנייה!) הייתה
    // כותבת מקטע חדש.
    [Fact]
    public void AnUnchangedCombinedStateIsNotResent()
    {
        var d = New();

        Assert.NotNull(d.Process(1, "", 1, "", 100).State);
        Assert.Null(d.Process(1, "", 1, "", 100).State);
    }

    // ⚠️ **וזו הבדיקה שמראה למה "הטוב מביניהן" אינו זהה ל"שום דבר לא
    // קרה":** מערכת 2 נופלת לתקלה בזמן שמערכת 1 ממתינה. מצב האתר אינו
    // משתנה — ובכל זאת הפירוט חייב להשתנות, אחרת הכרטיס ישקר.
    [Fact]
    public void AFaultInOneSystemChangesTheDetailEvenWhenTheSiteStateHolds()
    {
        var d = New();

        d.Process(1, "", 1, "", 100);
        DetectionResult r = d.Process(1, "", 5, "", 100);

        // ⚠️ **ידוע ומכוון:** אין הודעת מצב חדשה, כי מצב האתר לא זז.
        // הפירוט יגיע עם הודעת המצב הבאה. אם יתברר שזה איטי מדי — זה
        // המקום לשנות, וזו הבדיקה שתעיד על השינוי.
        Assert.Null(r.State);
    }

    // ===== התפעולים — הסיבה לשני גלאים =====

    // ⚠️ **הבדיקה המרכזית.** מערכת 1 מתחילה הכנסה בזמן שמערכת 2 שקטה.
    // גלאי אחד ממוזג היה רואה כאן מצב מאוחד שקופץ ל"בפעולה" וחוזר,
    // ומייצר פעולה בלי כרטיס — או מפספס אותה לגמרי.
    [Fact]
    public void AnOperationOnOneSystemIsDetectedWhileTheOtherIsIdle()
    {
        var d = New();

        d.Process(1, "", 1, "", 100);
        DetectionResult r = d.Process(2, "77", 1, "", 100);

        OperationMessage op = Assert.Single(r.Operations);
        Assert.Equal("77", op.User);
        Assert.Equal("start", op.StartEnd);
    }

    // ⚠️ ושתי המערכות יכולות לפעול **באותה שנייה** — שני רכבים בשני
    // מסלולים. גלאי אחד לא היה יכול לייצג את זה בכלל.
    [Fact]
    public void BothSystemsCanRunAnOperationAtTheSameMoment()
    {
        var d = New();

        d.Process(1, "", 1, "", 100);
        DetectionResult r = d.Process(2, "77", 3, "88", 100);

        Assert.Equal(2, r.Operations.Count);
        Assert.Contains(r.Operations, o => o.User == "77");
        Assert.Contains(r.Operations, o => o.User == "88");
    }

    // ⚠️ ומונה המחזורים משותף — הוא של האתר, לא של מערכת, ולכן שתי
    // הפעולות נושאות אותו מספר.
    [Fact]
    public void TheSharedCycleCounterRidesOnBothOperations()
    {
        var d = New();

        d.Process(1, "", 1, "", 20234);
        DetectionResult r = d.Process(2, "77", 3, "88", 20234);

        Assert.All(r.Operations, o => Assert.Equal(20234, o.CycleCounter));
    }

    // ===== מצב לא ידוע =====

    // ⚠️ MODE 4 (init) חולף בעליית הבקר. מערכת שאינה ידועה אינה מופיעה
    // בפירוט — תצוגה שמראה מצב ישן כאילו הוא נוכחי גרועה מתצוגה שמודה
    // שאינה יודעת.
    [Fact]
    public void AnUnknownSystemIsAbsentFromTheDetailRatherThanStale()
    {
        var d = New();

        DetectionResult r = d.Process(1, "", 4, "", 100);

        Assert.Equal(SiteState.Ready, r.State!.State);
        SystemState systems = Assert.Single(r.State.Systems!);
        Assert.Equal(1, systems.Unit);
    }
}
