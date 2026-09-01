using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Queue;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// התור שורד נפילת חשמל.
///
/// ⚠️ <b>למה זה קיים.</b> התור היה List בזיכרון, ו-Worker.cs תיעד בעצמו את הפער:
/// "התור חי בזיכרון בלבד — כלומר כל הפעולות שהוא נועד להציל היו אובדות בדיוק כאן".
/// זה גם החצי השני של באג ה-cleansession שנמדד היום: התיקון שם סגר נתק אינטרנט,
/// והתור של Mosquitto יושב על אותו מחשב — ולכן נפילת חשמל נשארה פתוחה.
///
/// ⚠️ <b>כל הבדיקות רצות בתיקייה זמנית משלהן</b>, ואף אחת אינה נוגעת
/// ב-C:\ProgramData\Parkomat. תיקיית ההגדרות של סוכן חי אינה מקום לקבצי בדיקה.
/// </summary>
public sealed class PendingQueueTests : IDisposable
{
    private readonly string _dir;

    public PendingQueueTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "pq-" + Guid.NewGuid().ToString("N"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    private static OperationMessage Op(long ts, string card) => new()
    {
        Timestamp = ts,
        StartEnd = "start",
        EntryExit = "entry",
        User = card,
        CycleCounter = 100,
        State = SiteState.Operating,
    };

    [Fact]
    public void SurvivesProcessRestart()
    {
        // ⚠️ **זו הבדיקה המרכזית.** מופע ראשון כותב, מופע שני קורא — בדיוק
        // כמו סוכן שקרס וחזר. אם התור בזיכרון, כאן חוזרות אפס הודעות.
        var first = new PendingQueue(_dir);
        first.Enqueue(Op(1000, "a"));
        first.Enqueue(Op(2000, "b"));

        var second = new PendingQueue(_dir);
        var loaded = second.LoadAll<OperationMessage>();

        Assert.Equal(2, loaded.Count);
        Assert.Equal("a", loaded[0].Message.User);
        Assert.Equal("b", loaded[1].Message.User);
    }

    [Fact]
    public void KeepsOrderAcrossTheSameMillisecond()
    {
        // ⚠️ מעבר MODE אחד מייצר **שתי** הודעות באותו רגע. בלי המונה הרץ
        // בשם הקובץ, השנייה הייתה דורסת את הראשונה — אובדן שקט לגמרי.
        var q = new PendingQueue(_dir);
        for (int i = 0; i < 20; i++) q.Enqueue(Op(1000 + i, $"c{i}"));

        var loaded = q.LoadAll<OperationMessage>();

        Assert.Equal(20, loaded.Count);
        Assert.Equal(
            Enumerable.Range(0, 20).Select(i => $"c{i}").ToArray(),
            loaded.Select(x => x.Message.User).ToArray());
    }

    [Fact]
    public void RemovedAfterPublish()
    {
        var q = new PendingQueue(_dir);
        q.Enqueue(Op(1000, "a"));
        var loaded = q.LoadAll<OperationMessage>();

        q.Remove(loaded[0].Path);

        Assert.Empty(q.LoadAll<OperationMessage>());
        Assert.Equal(0, q.Count);
    }

    [Fact]
    public void CorruptFileIsSkippedAndDoesNotBlockTheRest()
    {
        // ⚠️ קובץ פגום אחד — למשל כזה שנקטע בכתיבה — היה חוסם את כל התור
        // מאחוריו לנצח. זה בדיוק ההפך ממה שהתור קיים בשבילו.
        var q = new PendingQueue(_dir);
        q.Enqueue(Op(1000, "a"));
        File.WriteAllText(Path.Combine(_dir, "0000000001500-0001.json"), "{ this is not json");
        q.Enqueue(Op(2000, "b"));

        var loaded = q.LoadAll<OperationMessage>();

        Assert.Equal(2, loaded.Count);
        Assert.Equal(new[] { "a", "b" }, loaded.Select(x => x.Message.User).ToArray());
    }

    [Fact]
    public void PartialWriteIsNeverReadAsAMessage()
    {
        // ⚠️ נפילת חשמל **באמצע** כתיבה. הכתיבה היא tmp ואז Move, ולכן מה
        // שנשאר הוא .tmp — קובץ שאיש אינו קורא, ולא הודעה קטועה שתיקלט.
        var q = new PendingQueue(_dir);
        q.Enqueue(Op(1000, "a"));
        File.WriteAllText(Path.Combine(_dir, "0000000009999-0001.json.tmp"), "{\"Timestamp\":9");

        var loaded = q.LoadAll<OperationMessage>();

        Assert.Single(loaded);
        Assert.Equal("a", loaded[0].Message.User);
    }

    [Fact]
    public void StaleTempFilesAreCleanedUp()
    {
        // בלי הניקוי, נפילות חוזרות היו צוברות .tmp עד שהדיסק נגמר.
        var q = new PendingQueue(_dir);
        File.WriteAllText(Path.Combine(_dir, "0000000000001-0001.json.tmp"), "x");
        q.Enqueue(Op(1000, "a"));

        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));
    }

    [Fact]
    public void DropsOldestWhenFull()
    {
        // ⚠️ אותה מדיניות כמו התור הישן, ובכוונה: פעולה שאבדה בגלל נתק ארוך
        // מדי היא הפסד ידוע; תיקייה שממלאת את הדיסק מפילה את כל המחשב.
        var q = new PendingQueue(_dir, maxFiles: 5);
        for (int i = 0; i < 8; i++) q.Enqueue(Op(1000 + i, $"c{i}"));

        var loaded = q.LoadAll<OperationMessage>();

        Assert.True(loaded.Count <= 5, $"נשארו {loaded.Count} — התקרה לא נאכפה");
        // ⚠️ והאחרונות הן שנשמרות. תור שמוחק את **החדשות** משמר בדיוק את
        // המידע הכי פחות רלוונטי.
        Assert.Equal("c7", loaded[^1].Message.User);
    }

    [Fact]
    public void EmptyFolderLoadsCleanly()
    {
        // מופע ראשון על מחשב חדש — אין תיקייה, ואין למה ליפול.
        var q = new PendingQueue(Path.Combine(_dir, "nested", "deep"));
        Assert.Empty(q.LoadAll<OperationMessage>());
        Assert.Equal(0, q.Count);
    }

    [Fact]
    public void RoundTripsEveryFieldOfTheContract()
    {
        // ⚠️ שדה שאובד בסריאליזציה הוא אובדן שקט: ההודעה משודרת, השרת דוחה
        // או קולט אותה שגוי, ואין שום סימן שמשהו חסר. החוזה נבדק במלואו.
        var q = new PendingQueue(_dir);
        q.Enqueue(new OperationMessage
        {
            Timestamp = 1788000000,
            StartEnd = "end",
            EntryExit = "exit",
            User = "4271",
            CycleCounter = 65535,
            State = SiteState.Operating,
        });

        var m = q.LoadAll<OperationMessage>()[0].Message;

        Assert.Equal(1788000000, m.Timestamp);
        Assert.Equal("end", m.StartEnd);
        Assert.Equal("exit", m.EntryExit);
        Assert.Equal("4271", m.User);
        Assert.Equal(65535, m.CycleCounter);
        Assert.Equal(SiteState.Operating, m.State);
    }
}
