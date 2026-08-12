using Parkomat.Agent.Service.Logic;
using Xunit;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הכרטיס נלכד בתחילת הפעולה ואינו מתחלף בתוכה.
///
/// ============================================================
/// הבאג שזה מונע
/// ============================================================
/// _operationCard אימץ **כל** כרטיס לא-ריק שנראה לאורך הפעולה. הכוונה הייתה
/// לטפל בבקרים שמאפסים את הרגיסטר לפני שה-MODE יוצא ממצב הפעולה — אבל
/// התוצאה הייתה שנהג שמעביר כרטיס בזמן שהפעולה הקודמת עוד רצה **גונב אותה**.
///
/// ⚠️ זה לא נראה כנתון חסר אלא כנתון תקין, ולכן שרד. נמדד בשרת: 86 מתוך
/// 1,013 זוגות (8.5%) נסגרו עם כרטיס שאינו שלהם, ובחולדה 4 לבדה 66.
/// התסמין בדשבורד היה מאזן בלתי אפשרי לכרטיס בודד — 6 כניסות מול 3 יציאות.
/// </summary>
public class CardStealingTests
{
    private const int Ready = 1, Entry = 2, Exit = 3;

    [Fact]
    public void כרטיס_של_רכב_אחר_באמצע_פעולה_אינו_נגנב()
    {
        var d = new OperationDetector(() => 1000);
        d.Process(Ready, "", 0);

        // הרכב שלנו מתחיל לצאת עם כרטיס 10
        var start = d.Process(Exit, "10", 1);
        Assert.Equal("10", start.Operations[0].User);

        // באמצע הפעולה הרגיסטר מציג כבר את הכרטיס של הנהג הבא
        d.Process(Exit, "6", 1);
        d.Process(Exit, "6", 1);

        // הסגירה חייבת לשאת את 10, לא את 6
        var end = d.Process(Ready, "6", 2);
        Assert.Single(end.Operations);
        Assert.Equal("end", end.Operations[0].StartEnd);
        Assert.Equal("10", end.Operations[0].User);
    }

    [Fact]
    public void פתיחה_בלי_כרטיס_עדיין_מתמלאת_מאוחר_יותר()
    {
        // ההתנהגות שהתיקון *לא* שבר: אם הבקר טרם קרא את הכרטיס בתחילת הפעולה,
        // הערך הראשון שיופיע בתוכה הוא הנכון.
        var d = new OperationDetector(() => 1000);
        d.Process(Ready, "", 0);

        var start = d.Process(Entry, "", 1);
        Assert.Equal("", start.Operations[0].User);

        d.Process(Entry, "42", 1);

        var end = d.Process(Ready, "", 2);
        Assert.Equal("42", end.Operations[0].User);
    }

    [Fact]
    public void רגיסטר_שמתאפס_לפני_הסיום_אינו_מוחק_את_הכרטיס()
    {
        // התרחיש המקורי שבגללו הקוד הזה נכתב: הרגיסטר מתאפס ל-0 לפני שה-MODE
        // יוצא ממצב הפעולה. הכרטיס חייב לשרוד.
        var d = new OperationDetector(() => 1000);
        d.Process(Ready, "", 0);
        d.Process(Exit, "77", 1);
        d.Process(Exit, "", 1);          // הרגיסטר התאפס

        var end = d.Process(Ready, "", 2);
        Assert.Equal("77", end.Operations[0].User);
    }

    [Fact]
    public void פעולה_חדשה_מתחילה_עם_כרטיס_נקי()
    {
        // אחרי סגירה, הכרטיס הישן אסור שידבק לפעולה הבאה.
        var d = new OperationDetector(() => 1000);
        d.Process(Ready, "", 0);
        d.Process(Exit, "10", 1);
        d.Process(Ready, "", 2);         // נסגרה עם 10

        var next = d.Process(Entry, "55", 3);
        Assert.Equal("55", next.Operations[0].User);

        var end = d.Process(Ready, "", 4);
        Assert.Equal("55", end.Operations[0].User);
    }

    [Fact]
    public void מעבר_ישיר_מכניסה_ליציאה_אינו_מערבב_כרטיסים()
    {
        // MODE 2 -> 3 מייצר end לכניסה ו-start ליציאה באותו רגע. כל אחד עם
        // הכרטיס שלו.
        var d = new OperationDetector(() => 1000);
        d.Process(Ready, "", 0);
        d.Process(Entry, "11", 1);

        var both = d.Process(Exit, "22", 2);
        Assert.Equal(2, both.Operations.Count);
        Assert.Equal("end", both.Operations[0].StartEnd);
        Assert.Equal("11", both.Operations[0].User);     // הכניסה נסגרת עם שלה
        Assert.Equal("start", both.Operations[1].StartEnd);
        Assert.Equal("22", both.Operations[1].User);     // היציאה פותחת עם שלה
    }
}
