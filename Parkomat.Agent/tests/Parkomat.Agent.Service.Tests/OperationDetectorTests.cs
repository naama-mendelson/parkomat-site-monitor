using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Service.Logic;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// בדיקות ל"מוח" של ה-Agent — OperationDetector.
/// מכסות: תרגום MODE→state, שידור state רק בשינוי, פתיחה/סגירה של פעולות,
/// שימור מספר הכרטיס ב-end, ומניעת end+start כפולים כשה-MODE מוחזק.
///
/// תזכורת מיפוי MODE: 0=maintenance, 1=ready, 2=operating(entry),
/// 3=operating(exit), 4=init (מתעלמים), 5=error.
/// </summary>
public class OperationDetectorTests
{
    // ===== הרצה ראשונה =====

    [Fact]
    public void FirstRead_ReadyMode_PublishesReadyState_NoOperations()
    {
        var detector = new OperationDetector();

        DetectionResult result = detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);

        Assert.NotNull(result.State);
        Assert.Equal(SiteState.Ready, result.State!.State);
        Assert.Empty(result.Operations);
    }

    [Fact]
    public void FirstRead_EntryMode_PublishesOperatingState_ButNoOperationYet()
    {
        var detector = new OperationDetector();

        // בהרצה ראשונה אין MODE קודם, ולכן לא נפתחת פעולה — רק state.
        DetectionResult result = detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 5);

        Assert.NotNull(result.State);
        Assert.Equal(SiteState.Operating, result.State!.State);
        Assert.Empty(result.Operations);
    }

    [Fact]
    public void FirstRead_InitMode_ProducesNothing()
    {
        var detector = new OperationDetector();

        // MODE 4 (init) לא מתורגם למצב — אין state ואין פעולה.
        DetectionResult result = detector.Process(mode: 4, cardNumber: "", cycleCounter: 0);

        Assert.Null(result.State);
        Assert.Empty(result.Operations);
        Assert.True(result.IsEmpty);
    }

    // ===== הודעת state רק כשהמצב משתנה =====

    [Fact]
    public void State_IsPublishedOnlyWhenTranslatedStateChanges()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);       // ready — משודר
        DetectionResult second = detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);

        // אותו מצב שוב — אין state חדש, ואין מה לשדר בכלל.
        Assert.Null(second.State);
        Assert.True(second.IsEmpty);
    }

    [Fact]
    public void ErrorMode_PublishesErrorState()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        DetectionResult result = detector.Process(mode: 5, cardNumber: "", cycleCounter: 0);

        Assert.NotNull(result.State);
        Assert.Equal(SiteState.Error, result.State!.State);
    }

    [Fact]
    public void MaintenanceMode_PublishesMaintenanceState()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        DetectionResult result = detector.Process(mode: 0, cardNumber: "", cycleCounter: 0);

        Assert.NotNull(result.State);
        Assert.Equal(SiteState.Maintenance, result.State!.State);
    }

    [Fact]
    public void InitModeAfterReady_KeepsPreviousState_NoStateMessage()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        DetectionResult result = detector.Process(mode: 4, cardNumber: "", cycleCounter: 0);

        // FromMode(4)=null → אין state, ואין פעולות.
        Assert.Null(result.State);
        Assert.Empty(result.Operations);
    }

    // ===== פתיחת פעולה (start) =====

    [Fact]
    public void EnteringEntryMode_OpensEntryOperation_WithCurrentCard()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        DetectionResult result = detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 10);

        OperationMessage op = Assert.Single(result.Operations);
        Assert.Equal("start", op.StartEnd);
        Assert.Equal("entry", op.EntryExit);
        Assert.Equal("1234", op.User);
        Assert.Equal(10, op.CycleCounter);
        Assert.Equal(SiteState.Operating, op.State);
    }

    [Fact]
    public void EnteringExitMode_OpensExitOperation()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        DetectionResult result = detector.Process(mode: 3, cardNumber: "77", cycleCounter: 20);

        OperationMessage op = Assert.Single(result.Operations);
        Assert.Equal("start", op.StartEnd);
        Assert.Equal("exit", op.EntryExit);
        Assert.Equal("77", op.User);
    }

    // ===== סגירת פעולה (end) — כולל שימור הכרטיס =====

    [Fact]
    public void LeavingEntryMode_ClosesEntryOperation_PreservingCardFromPreviousReading()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 10);   // פעולה פתוחה עם כרטיס
        // בעת הסגירה ה-PLC כבר איפס את הכרטיס ל-"" — אבל ה-end חייב לשאת את הכרטיס המקורי.
        DetectionResult result = detector.Process(mode: 1, cardNumber: "", cycleCounter: 11);

        OperationMessage op = Assert.Single(result.Operations);
        Assert.Equal("end", op.StartEnd);
        Assert.Equal("entry", op.EntryExit);
        Assert.Equal("1234", op.User);      // הכרטיס נשמר מהקריאה הקודמת, לא ""
        Assert.Equal(11, op.CycleCounter);  // ה-cycle הוא העדכני ביותר
    }

    [Fact]
    public void EntryToExitTransition_EmitsEndOfEntryThenStartOfExit()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        detector.Process(mode: 2, cardNumber: "AAA", cycleCounter: 10);
        // מעבר ישיר 2→3: סוגרים את ההכנסה (עם כרטיס AAA) ופותחים יציאה (עם כרטיס BBB).
        DetectionResult result = detector.Process(mode: 3, cardNumber: "BBB", cycleCounter: 12);

        Assert.Equal(2, result.Operations.Count);

        OperationMessage end = result.Operations[0];
        Assert.Equal("end", end.StartEnd);
        Assert.Equal("entry", end.EntryExit);
        Assert.Equal("AAA", end.User);      // כרטיס ההכנסה שנסגרה

        OperationMessage start = result.Operations[1];
        Assert.Equal("start", start.StartEnd);
        Assert.Equal("exit", start.EntryExit);
        Assert.Equal("BBB", start.User);

        // 2 ו-3 שניהם operating → המצב לא השתנה → אין הודעת state.
        Assert.Null(result.State);
    }

    // ===== מניעת שידור כפול כשה-MODE מוחזק =====

    [Fact]
    public void HeldEntryMode_DoesNotEmitDuplicateOperations()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);
        detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 10);   // start
        // אותו MODE שוב (ה-PLC מחזיק את מצב הפעולה) — אסור לייצר end+start נוספים.
        DetectionResult held = detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 11);

        Assert.Empty(held.Operations);
        Assert.Null(held.State);
        Assert.True(held.IsEmpty);
    }

    [Fact]
    public void FullEntryCycle_ProducesExactlyOneStartAndOneEnd()
    {
        var detector = new OperationDetector();

        detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);

        var starts = 0;
        var ends = 0;

        void Tally(DetectionResult r)
        {
            foreach (OperationMessage op in r.Operations)
            {
                if (op.StartEnd == "start") starts++;
                if (op.StartEnd == "end") ends++;
            }
        }

        // דגימה: כניסה מוחזקת לאורך שלוש דגימות ואז חזרה ל-ready.
        Tally(detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 10)); // start
        Tally(detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 10)); // held — כלום
        Tally(detector.Process(mode: 2, cardNumber: "1234", cycleCounter: 10)); // held — כלום
        Tally(detector.Process(mode: 1, cardNumber: "", cycleCounter: 11));     // end

        Assert.Equal(1, starts);
        Assert.Equal(1, ends);
    }

    // ===== שדות טכניים =====

    [Fact]
    public void PublishedState_HasPositiveUnixTimestamp()
    {
        var detector = new OperationDetector();

        DetectionResult result = detector.Process(mode: 1, cardNumber: "", cycleCounter: 0);

        Assert.NotNull(result.State);
        Assert.True(result.State!.Timestamp > 0);
    }
}
