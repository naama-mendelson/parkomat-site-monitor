using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service.Logic;
using Xunit;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הפעולה הפיקטיבית שנוצרה בכל הפעלה מחדש, והשחזור שמונע אותה.
///
/// ה-detector הוא edge-triggered. בלי MODE קודם, קריאה ראשונה שנוחתת באמצע
/// מחזור (MODE 2/3) פותחת פעולה עם חותם "עכשיו" — נכון בהתקנה טרייה, שגוי
/// אחרי הפעלה מחדש. ומכיוון ש**מכנה אחוז הכשל הוא מספר הפעולות**, אתר עם
/// MODE תקוע קיבל ציון בריא יותר ככל שהוא נשבר יותר.
///
/// ⚠️ הטסטים כאן אינם נוגעים בקבצים אמיתיים: DetectorState נבדק על נתיב
/// זמני, וה-detector נבדק דרך Restore הטהור. אין כתיבה ל-ProgramData.
/// </summary>
public class DetectorRestoreTests
{
    private const int ModeEntry = 2;
    private const int ModeReady = 1;

    // ==========================================================
    // הבאג עצמו
    // ==========================================================
    [Theory]
    [InlineData(2)]   // כניסה
    [InlineData(3)]   // יציאה
    public void FreshStartInsideAnOperation_OpensOne(int mode)
    {
        // ההתנהגות שנשארת נכונה להתקנה טרייה: אין ידיעה קודמת, ולכן פותחים
        // פעולה כדי שלא ייווצר end יתום בהמשך.
        var detector = new OperationDetector(() => 1000);

        var result = detector.Process(mode, "555", 10);

        Assert.Single(result.Operations);
        Assert.Equal("start", result.Operations[0].StartEnd);
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    public void RestartInsideTheSameOperation_OpensNothing(int mode)
    {
        // אותו מצב בדיוק, אבל אחרי הפעלה מחדש: ה-MODE לא זז, ולכן אין שום
        // אירוע חדש לדווח עליו. זו הפעולה הפיקטיבית שנעלמה.
        var detector = new OperationDetector(() => 1000);
        detector.Restore(previousMode: mode, operationCard: "555");

        var result = detector.Process(mode, "555", 10);

        Assert.Empty(result.Operations);
        Assert.Null(result.State);   // גם המצב לא השתנה
    }

    [Fact]
    public void RestartAfterTheModeMoved_ClosesTheOldOperationAndOpensTheNew()
    {
        // הסוכן היה למטה בזמן שהבקר עבר מכניסה ליציאה. השחזור נותן לו את
        // ההקשר לסגור את הישנה ולפתוח את החדשה — במקום לפתוח רק את החדשה
        // ולהשאיר את הקודמת פתוחה לנצח.
        var detector = new OperationDetector(() => 1000);
        detector.Restore(previousMode: 2, operationCard: "111");

        var result = detector.Process(3, "222", 11);

        Assert.Equal(2, result.Operations.Count);
        Assert.Equal("end", result.Operations[0].StartEnd);
        Assert.Equal("entry", result.Operations[0].EntryExit);
        Assert.Equal("111", result.Operations[0].User);   // הכרטיס המשוחזר
        Assert.Equal("start", result.Operations[1].StartEnd);
        Assert.Equal("exit", result.Operations[1].EntryExit);
        Assert.Equal("222", result.Operations[1].User);
    }

    [Fact]
    public void RestoredCard_SurvivesARegisterThatCleared()
    {
        // הרגיסטר מתאפס לפני שה-MODE יוצא מהפעולה (קורה ביציאה). הכרטיס
        // המשוחזר הוא מה שמאפשר ל-end לשאת אותו בכל זאת.
        var detector = new OperationDetector(() => 1000);
        detector.Restore(previousMode: ModeEntry, operationCard: "999");

        var result = detector.Process(ModeReady, "", 12);

        Assert.Single(result.Operations);
        Assert.Equal("end", result.Operations[0].StartEnd);
        Assert.Equal("999", result.Operations[0].User);
    }

    [Fact]
    public void Restore_AfterProcessing_IsRejected()
    {
        // שחזור באמצע ריצה היה דורס מצב חי ומייצר מעבר מדומה. נחסם ברעש
        // ולא בשקט.
        var detector = new OperationDetector(() => 1000);
        detector.Process(1, "", 1);

        Assert.Throws<InvalidOperationException>(() => detector.Restore(2, "1"));
    }

    // ==========================================================
    // מחזור השמירה/טעינה
    // ==========================================================
    [Fact]
    public void SavedState_RoundTrips()
    {
        string path = Path.Combine(Path.GetTempPath(), $"pk-detector-{Guid.NewGuid():N}");
        try
        {
            new DetectorState(3, "12345").Save(path);
            var loaded = DetectorState.TryLoad(path);

            Assert.NotNull(loaded);
            Assert.Equal(3, loaded!.PreviousMode);
            Assert.Equal("12345", loaded.OperationCard);
        }
        finally { try { File.Delete(path); } catch { } }
    }

    [Fact]
    public void EmptyCard_RoundTripsAsEmpty_NotAsAMissingField()
    {
        // הכרטיס הוא האיבר האחרון בפורמט ויכול להיות ריק. פיצול נאיבי היה
        // מקצר את המערך ופוסל את השורה כולה — כלומר כל מצב בלי כרטיס היה
        // נזרק, וזה בדיוק המצב הנפוץ (MODE 1).
        string path = Path.Combine(Path.GetTempPath(), $"pk-detector-{Guid.NewGuid():N}");
        try
        {
            new DetectorState(1, "").Save(path);
            var loaded = DetectorState.TryLoad(path);

            Assert.NotNull(loaded);
            Assert.Equal(1, loaded!.PreviousMode);
            Assert.Equal("", loaded.OperationCard);
        }
        finally { try { File.Delete(path); } catch { } }
    }

    [Fact]
    public void MissingFile_LoadsAsNull()
        => Assert.Null(DetectorState.TryLoad(
            Path.Combine(Path.GetTempPath(), $"pk-missing-{Guid.NewGuid():N}")));

    [Theory]
    [InlineData("garbage")]
    [InlineData("")]
    [InlineData("notanumber 2 5")]
    [InlineData("1000")]
    public void CorruptFile_LoadsAsNull(string content)
    {
        string path = Path.Combine(Path.GetTempPath(), $"pk-detector-{Guid.NewGuid():N}");
        try
        {
            File.WriteAllText(path, content);
            Assert.Null(DetectorState.TryLoad(path));
        }
        finally { try { File.Delete(path); } catch { } }
    }

    [Fact]
    public void StaleState_IsRejected()
    {
        // מצב ישן גרוע מאין-מצב: הוא היה מייצר end לפעולה שהסתיימה מזמן,
        // עם משך מנופח — בדיוק הנתון שהמערכת קיימת כדי למדוד.
        string path = Path.Combine(Path.GetTempPath(), $"pk-detector-{Guid.NewGuid():N}");
        try
        {
            long tooOld = DateTimeOffset.UtcNow
                .Subtract(DetectorState.MaxAge)
                .AddMinutes(-1)
                .ToUnixTimeSeconds();
            File.WriteAllText(path, $"{tooOld} 2 555");

            Assert.Null(DetectorState.TryLoad(path));
        }
        finally { try { File.Delete(path); } catch { } }
    }

    [Fact]
    public void StateFromTheFuture_IsRejected()
    {
        // השעון קפץ אחורה. אותו כלל כמו ב-AgentClock — ברירת המחדל הבטוחה
        // היא "בלי שחזור".
        string path = Path.Combine(Path.GetTempPath(), $"pk-detector-{Guid.NewGuid():N}");
        try
        {
            long future = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds();
            File.WriteAllText(path, $"{future} 2 555");

            Assert.Null(DetectorState.TryLoad(path));
        }
        finally { try { File.Delete(path); } catch { } }
    }

    [Fact]
    public void MaxAge_CoversTheLongestRestartBackoff()
    {
        // אם ההמתנה המקסימלית של הריסון תעלה מעל חסם הגיל, כל הפעלה-מחדש
        // מרוסנת תיפסל ותחזור לייצר פעולה פיקטיבית — כלומר הבאג יחזור בשקט.
        Assert.True(
            DetectorState.MaxAge.TotalSeconds > RestartPolicy.MaxDelaySeconds,
            $"חסם הגיל ({DetectorState.MaxAge.TotalSeconds}s) חייב לכסות את ההמתנה " +
            $"המקסימלית ({RestartPolicy.MaxDelaySeconds}s).");
    }
}
