using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הכותב מול Supabase <b>אמיתי</b>, דרך הרשת.
///
/// ⚠️ <b>מה שאף בדיקה אחרת לא מכסה.</b> <c>SupabaseWriterTests</c> עובד מול
/// handler מזויף, ו-<c>IngestContractTests</c> משווה מחרוזת JSON לקובץ. שניהם
/// חשובים ואף אחד מהם לא שולח בייט אחד: הכותרות, ה-TLS, הקידוד, ומה
/// ש-PostgREST באמת עושה עם הגוף — כל אלה מעולם לא נבדקו מ-C#.
///
/// ⚠️ <b>ומי מוודא שהבדיקה הזו בכלל רצה.</b> בדיקה שמדלגת בשקט כשאין
/// משתני סביבה נראית ירוקה בדיוק כמו בדיקה שעברה — וזה הדפוס שהפרויקט הזה
/// כבר נכווה בו (שלושה שערים דיווחו "לא רץ" חודשים, ואיש לא שם לב).
/// לכן <b>השער בצד השרת</b> (<c>check-agent-live</c>) הוא הסמכות: הוא מקים
/// אתר וסוכן סינתטיים, מריץ את הבדיקה הזו, ואז שואל את המסד אם השורות
/// באמת נחתו. אם היא דילגה — הוא נופל.
///
/// ⚠️ ומשתנים חלקיים הם <b>כישלון</b> ולא דילוג: מי שהגדיר שלושה מתוך
/// ארבעה התכוון להריץ, וסביבה שבורה שנראית כדילוג היא בדיוק איך שבדיקה
/// מפסיקה לרוץ בלי שאיש יבחין.
/// </summary>
public class SupabaseLiveTests
{
    private const string Prefix = "PARKOMAT_SB_";

    private static string? Env(string name) =>
        Environment.GetEnvironmentVariable(Prefix + name);

    [Fact]
    public async Task WritesABatchToRealSupabase()
    {
        string?[] all = [Env("URL"), Env("KEY"), Env("EMAIL"), Env("PASSWORD")];

        // אין אף משתנה — הבדיקה אינה רצה, וזו החלטה של הקורא.
        if (all.All(string.IsNullOrWhiteSpace)) return;

        // ⚠️ חלק מהמשתנים בלבד = כישלון. ראה ההסבר למעלה.
        Assert.All(all, v => Assert.False(string.IsNullOrWhiteSpace(v),
            "הוגדרו רק חלק ממשתני PARKOMAT_SB_* — סביבה חלקית אינה דילוג"));

        var cfg = new SupabaseConfig
        {
            Url = all[0]!, AnonKey = all[1]!, Email = all[2]!, Password = all[3]!,
        };
        Assert.True(cfg.Enabled);

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var writer = new SupabaseWriter(cfg, http);

        // ⚠️ חותם קבוע וידוע, כדי שהשער בצד השני יוכל למצוא בדיוק את השורות
        // האלה. הוא מגיע מהסביבה — השער קובע אותו — ולא מ-now, כי "עכשיו"
        // בשני התהליכים אינו אותו רגע.
        long t = long.Parse(Env("STAMP") ?? "1788256800");

        var batch = new List<BatchItem>
        {
            BatchPayload.From(new StateMessage { Timestamp = t, State = SiteState.Operating }),
            BatchPayload.From(new OperationMessage
            {
                Timestamp = t, StartEnd = "start", EntryExit = "entry",
                User = "4271", CycleCounter = 700, State = SiteState.Operating,
            }),
            BatchPayload.From(new OperationMessage
            {
                Timestamp = t + 30, StartEnd = "end", EntryExit = "entry",
                User = "", CycleCounter = 701, State = SiteState.Operating,
            }),
            // ⚠️ עברית במטען — זה מה שנשבר כשהמקודד בורח מכל תו שאינו ASCII.
            BatchPayload.From(new StateMessage
            {
                Timestamp = t + 35, State = SiteState.Error,
                FaultText = "מיטה 5 - בוכנה 2: זמן מקסימלי לפעולה",
            }),
        };

        WriteResult res = await writer.SendAsync(batch, CancellationToken.None);

        Assert.True(res.Ok, $"סטטוס {res.Status}: {res.Error}");
        Assert.True(writer.HasValidToken, "הכותב לא שמר אסימון תקף אחרי הצלחה");
    }
}
