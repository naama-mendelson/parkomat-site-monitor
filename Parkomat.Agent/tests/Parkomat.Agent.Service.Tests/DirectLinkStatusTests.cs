using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// סמל הענן ב-Tray, באתר שבו MQTT כבוי.
///
/// <para>⚠️ <b>הבאג.</b> הקובץ נכתב רק אחרי שליחה מוצלחת — באתר שקט פעם
/// בדקה — וה-Tray מחשיב אותו טרי <c>max(10, 3×poll)</c> שניות. הסמל היה
/// צבעוני עשר שניות ואפור חמישים, בכל דקה, באתר תקין. עכשיו הוא נכתב בכל
/// סבב (<c>WorkerLossPathsTests.TheDirectLinkStatusIsWrittenEveryCycle</c>)
/// והערך נגזר כאן.</para>
///
/// <para>⚠️ <b>והדרישה השנייה חשובה לא פחות:</b> מחוון שתמיד ירוק גרוע ממחוון
/// שמהבהב. כשהשליחות נכשלות או מפסיקות — הוא חייב להאדים.</para>
/// </summary>
public class DirectLinkStatusTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 17, 12, 0, 0, TimeSpan.Zero);

    // ⚠️ זו הטענה שהבאג הפר: בין פעימה לפעימה (60 שניות) הסטטוס **נשאר**
    // מחובר. תחת הכלל הישן הוא היה אפור מהשנייה ה-11.
    [Theory]
    [InlineData(0)]
    [InlineData(11)]
    [InlineData(59)]
    [InlineData(75)]    // פעימה + timeout של 15 שניות לבקשה
    public void BetweenBeatsTheLinkStaysUp(int secondsSinceLastSuccess)
    {
        Assert.True(DirectLinkStatus.IsUp(0, Now.AddSeconds(-secondsSinceLastSuccess), Now));
    }

    // ⚠️ כשל אחד — אדום מיד, ולא אחרי שלוש דקות. סיסמה שגויה היא בדיוק
    // המקרה שבו הטכנאי עומד ליד המחשב.
    [Fact]
    public void AFailedSendIsDownAtOnce()
    {
        Assert.False(DirectLinkStatus.IsUp(1, Now.AddSeconds(-5), Now));
    }

    // ⚠️ ושליחות שפשוט **אינן קורות** (שער סגור, בקשה תלויה) — אדום אחרי
    // אותו סף שבו השרת מסמן no_comm.
    [Fact]
    public void SilenceLongerThanTheServerThresholdIsDown()
    {
        Assert.False(DirectLinkStatus.IsUp(0, Now - DirectLinkStatus.MaxSilence - TimeSpan.FromSeconds(1), Now));
    }

    [Fact]
    public void NeverHavingSucceededIsDown()
    {
        Assert.False(DirectLinkStatus.IsUp(0, DateTimeOffset.MinValue, Now));
    }

    // ⚠️ השעון קפץ אחורה: הפעימה הבאה נדחית עד שהשעון ישיג את החותם, כלומר
    // דווקא עכשיו אין שליחות. "טרי" היה שקר.
    [Fact]
    public void AClockThatJumpedBackwardsIsNotReportedAsUp()
    {
        Assert.False(DirectLinkStatus.IsUp(0, Now.AddMinutes(10), Now));
    }

    // ============================================================
    // ⚠️ היחסים שחייבים להחזיק
    // ============================================================
    // הסף מעל פעימה + timeout (אחרת אתר תקין מאדים), ולא מעל סף השרת
    // (אחרת הסמל ירוק בזמן שהמסך במשרד כבר אומר "מנותק").
    // 60 = HeartbeatInterval ב-Worker (נעול ב-HeartbeatWiringTests).
    [Fact]
    public void TheThresholdSitsBetweenOneBeatAndTheServersSilenceScan()
    {
        TimeSpan beatPlusTimeout = TimeSpan.FromSeconds(60 + 15);
        Assert.True(DirectLinkStatus.MaxSilence > beatPlusTimeout);
        Assert.True(DirectLinkStatus.MaxSilence <= TimeSpan.FromMinutes(3));
    }

    // ⚠️ **וזו הסיבה שהסטטוס חייב להיכתב בכל סבב**, לא אחרי שליחה: חלון
    // הרעננות של ה-Tray בדגימה של שנייה קצר בהרבה ממרווח הפעימה.
    [Fact]
    public void TheTrayFreshnessWindowIsShorterThanABeat()
    {
        Assert.True(HeartbeatPolicy.FreshnessWindowSeconds(1000) < 60,
            "אם החלון היה ארוך מפעימה, כתיבה פעם בדקה הייתה מספיקה — והנחת התיקון שגויה");
    }
}
