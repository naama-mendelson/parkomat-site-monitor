using System.Text.RegularExpressions;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Queue;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הניסיון החוזר של הכתיבה הישירה — מה שהופך אותה מ"מסלול משני" למסלול
/// שאפשר לסמוך עליו לבד.
///
/// <para>
/// ⚠️ <b>עד כה אצווה שנכשלה נזרקה</b>, והנימוק היה נכון כל עוד MQTT הוא
/// רשת הביטחון: *"ההודעות כבר נמסרו ל-MQTT ומשם הן יגיעו"*. אבל זה בדיוק
/// מה שמנע לכבות אותו — ביום שהוא יורד, כל גמגום רשת הופך לאובדן קבוע.
/// </para>
///
/// <para>
/// ⚠️ וזה נמדד ולא נטען: <b>1,097 מחזורי מכונה אבדו</b> בשלוש הנפילות.
/// הם לא "מאוחרים" — הם מעולם לא הגיעו.
/// </para>
/// </summary>
public class SupabaseRetryTests
{
    private static string Worker()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Worker.cs"));
    }

    // ===== התור עצמו — התנהגות אמיתית, לא מבנה =====

    [Fact]
    public void AFailedBatchSurvivesOnDisk()
    {
        // ⚠️ הבדיקה המרכזית: הודעה שנכשלה חייבת להיות ניתנת לשליפה אחרי
        // שהתהליך מת. תור בזיכרון היה עובר בדיוק את כל השאר ונכשל כאן.
        string folder = Path.Combine(Path.GetTempPath(), "pk-retry-" + Guid.NewGuid().ToString("N"));
        try
        {
            var q = new PendingQueue(folder);
            q.Enqueue(BatchPayload.From(new Core.Protocol.StateMessage
            {
                Timestamp = 1788256800, State = Core.Protocol.SiteState.Error,
                FaultText = "מיטה 5 - בוכנה 2",
            }));

            // תור **חדש** על אותה תיקייה — כלומר בדיוק מה שקורה אחרי הפעלה מחדש.
            var reopened = new PendingQueue(folder);
            var items = reopened.LoadAll<BatchItem>();

            Assert.Single(items);
            Assert.Equal("state", items[0].Message.Kind);
            Assert.Equal("מיטה 5 - בוכנה 2", items[0].Message.FaultText);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public void OrderIsPreservedOldestFirst()
    {
        // ⚠️ סדר שגוי אינו רק אסתטי: השרת דוחה הודעת מצב ישנה יותר מהאחרונה
        // שנרשמה (שומר ה-backfill). שליחה מהחדש לישן הייתה גורמת לכל התור
        // להידחות — ונראית בדיוק כמו "התור עובד", כי הבקשות מצליחות.
        string folder = Path.Combine(Path.GetTempPath(), "pk-retry-" + Guid.NewGuid().ToString("N"));
        try
        {
            var q = new PendingQueue(folder);
            for (int i = 0; i < 5; i++)
                q.Enqueue(BatchPayload.From(new Core.Protocol.OperationMessage
                {
                    Timestamp = 1788256800 + i, StartEnd = "end", EntryExit = "entry",
                    User = "", CycleCounter = 100 + i, State = Core.Protocol.SiteState.Operating,
                }));

            var items = new PendingQueue(folder).LoadAll<BatchItem>();
            Assert.Equal(5, items.Count);

            var cycles = items.Select(x => x.Message.Cycle).ToList();
            Assert.Equal(new int?[] { 100, 101, 102, 103, 104 }, cycles);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public void RemovingOneLeavesTheRest()
    {
        // המחיקה היא לפי נתיב, אחת-אחת. מחיקה גורפת אחרי שליחה חלקית הייתה
        // מוחקת גם את מה שלא נשלח.
        string folder = Path.Combine(Path.GetTempPath(), "pk-retry-" + Guid.NewGuid().ToString("N"));
        try
        {
            var q = new PendingQueue(folder);
            for (int i = 0; i < 3; i++)
                q.Enqueue(BatchPayload.From(new Core.Protocol.StateMessage
                { Timestamp = 1788256800 + i, State = Core.Protocol.SiteState.Ready }));

            var items = q.LoadAll<BatchItem>();
            q.Remove(items[0].Path);

            Assert.Equal(2, new PendingQueue(folder).LoadAll<BatchItem>().Count);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public void TheQueueHasItsOwnFolderSeparateFromMqtt()
    {
        // ⚠️ שני המסלולים נכשלים באופן בלתי תלוי — MQTT יכול לעבוד בזמן
        // ש-Supabase לא נגיש, ולהפך. תיקייה משותפת הייתה כופה עליהם גורל
        // אחד: הודעה שנמסרה ל-MQTT הייתה נשארת בתור עד שגם הישירה תצליח.
        Assert.NotEqual(AgentPaths.QueueFolder, AgentPaths.SupabaseQueueFolder);
        Assert.EndsWith("queue-supabase", AgentPaths.SupabaseQueueFolder);
    }

    // ===== החיווט ב-Worker =====

    [Fact]
    public void AFailedSendEnqueuesInsteadOfDropping()
    {
        // ⚠️ **הבדיקה שהקוד הזה קיים בשבילה.** הגרסה הקודמת קראה
        // `mirrored.Clear()` בלי תנאי — כלומר אצווה שנכשלה נמחקה.
        string src = Worker();
        Assert.Matches(new Regex(@"foreach\s*\(var m in mirrored\)\s*supaQueue\.Enqueue\(m\)"), src);
    }

    [Fact]
    public void QueuedMessagesAreRemovedOnlyAfterAcknowledgement()
    {
        // ⚠️ מחיקה לפני השליחה, או בלי לבדוק את התוצאה, מחזירה בדיוק את
        // האובדן שהתור נבנה למנוע.
        string src = Worker();
        Assert.Matches(new Regex(
            @"if\s*\(res\.Ok\)[\s\S]{0,400}?foreach\s*\(var \(path, _\) in retry\)\s*supaQueue\.Remove\(path\)"),
            src);
    }

    [Fact]
    public void TheQueueIsDrainedOldestFirstAheadOfNewMessages()
    {
        // ההודעות מהתור נשלחות **לפני** החדשות, אחרת הסדר מתהפך והשרת
        // דוחה את הישנות כ-backfill.
        string src = Worker();
        Assert.Matches(new Regex(
            @"foreach\s*\(var \(_, m\) in retry\)\s*outgoing\.Add\(m\);\s*outgoing\.AddRange\(mirrored\)"),
            src);
    }

    [Fact]
    public void TheBatchStaysUnderTheServerCap()
    {
        // ⚠️ `ingest_batch` דוחה אצווה מעל 200 **כולה**. תור של 1,000
        // הודעות אחרי נתק ארוך היה נדחה בכל ניסיון — כלומר תור שלא מתרוקן
        // לעולם, וזה נראה בדיוק כמו "הרשת עדיין נפולה".
        Assert.Matches(new Regex(@"\.Take\(100\)"), Worker());
    }

    [Fact]
    public void ARestartReportsWhatSurvived()
    {
        // בלי השורה הזו, תור שהתמלא בנתק ארוך הוא מצב בלתי נראה: הסוכן
        // עולה, שולח, והשקט לא מסביר כמה זמן לקח לו להתאושש.
        Assert.Matches(new Regex(@"Supabase retry queue restored from disk"), Worker());
    }
}
