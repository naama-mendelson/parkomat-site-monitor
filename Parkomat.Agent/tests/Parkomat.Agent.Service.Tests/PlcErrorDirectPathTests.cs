using System.Net;
using System.Text;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// "אין קשר לבקר" — התקלה שדווחה רק ב-MQTT, באתר שבו MQTT כבוי.
///
/// ⚠️ <b>וזה הופך בשקט החלטה שנכתבה במפורש.</b> נתיב כשל ה-PLC בוחר
/// <c>Error</c> ולא <c>no_comm</c> מתוך נימוק מפורש: <c>no_comm</c> נמצא
/// <b>מחוץ למכנה של הזמינות</b>, כלומר העברה לשם מעלימה את ההשבתה מהמדדים
/// במקום להסביר אותה.
///
/// ⚠️ אבל באתר במסלול ישיר בלבד הדיווח לא יצא לשום מקום — והנתיב מסתיים
/// ב-<c>continue</c> שעוצר גם את הפעימה, כך ש-<c>mark_silent_agents</c>
/// מסמן <c>no_comm</c> תוך 3–4 דקות. כלומר בדיוק המצב שנפסל, ובלי התיאור
/// שמבדיל בין "המכונה נשברה" ל"אין לנו קשר אליה" — שתי נסיעות שונות.
/// </summary>
public class PlcErrorDirectPathTests
{
    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, (HttpStatusCode, string)> _reply;
        public List<string> Paths { get; } = [];
        public List<string> Bodies { get; } = [];

        public FakeHandler(Func<HttpRequestMessage, (HttpStatusCode, string)> reply) => _reply = reply;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Paths.Add(request.RequestUri!.AbsolutePath);
            Bodies.Add(request.Content is null
                ? "" : await request.Content.ReadAsStringAsync(cancellationToken));

            var (code, body) = _reply(request);
            return new HttpResponseMessage(code)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        }
    }

    private static SupabaseConfig Cfg() => new()
    {
        Url = "https://demo.supabase.co",
        AnonKey = "anon-key",
        Email = "site-2438@parkomat.co.il",
        Password = "pw",
    };

    private const string TokenBody = """{"access_token":"tok","expires_in":3600}""";

    // אותה הודעה בדיוק שהנתיב בונה.
    private static StateMessage PlcUnreachable() => new()
    {
        Timestamp = 1788256800,
        State = SiteState.Error,
        FaultText = "אין תקשורת עם הבקר",
    };

    // ============================================================
    // ⚠️ בקשה שיצאה לרשת, ולא "הפונקציה הוחזרה בהצלחה"
    // ============================================================
    // זה בדיוק הלקח מהפעימה: `SendAsync` חוסם אצווה ריקה בשורה הראשונה
    // ומחזיר הצלחה **בלי לשלוח**. שלוש בדיקות מבניות עברו אז, כי כולן
    // קראו את Worker.cs במקום לספור בקשות.
    [Fact]
    public async Task TheFaultLeavesTheWireAndCarriesItsText()
    {
        var h = new FakeHandler(req =>
            req.RequestUri!.AbsolutePath.Contains("token")
                ? (HttpStatusCode.OK, TokenBody)
                : (HttpStatusCode.OK, "[]"));

        var w = new SupabaseWriter(Cfg(), new HttpClient(h));
        var r = await w.SendAsync([BatchPayload.From(PlcUnreachable())], CancellationToken.None);

        Assert.True(r.Ok, r.Error);
        Assert.Equal(2, h.Paths.Count);                       // התחברות + כתיבה
        Assert.Contains("/rest/v1/rpc/ingest_batch", h.Paths[1]);

        string body = h.Bodies[1];
        Assert.Contains("\"status\":\"error\"", body);
        // ⚠️ התיאור הוא כל ההבדל בין "מושבת" סתם לבין "אין קשר לבקר".
        Assert.Contains("fault_text", body);
        Assert.Contains("הבקר", body);
    }

    // ⚠️ והצד השני של אותה טענה: אצווה ריקה **אינה** יוצאת. בלי זה
    // הבדיקה שמעל ירוקה גם אם ההודעה נבלעת, כי "2 בקשות" היה נובע
    // מההתחברות בלבד.
    [Fact]
    public async Task AnEmptyBatchStillSendsNothing()
    {
        var h = new FakeHandler(_ => (HttpStatusCode.OK, TokenBody));
        var w = new SupabaseWriter(Cfg(), new HttpClient(h));

        await w.SendAsync([], CancellationToken.None);

        Assert.Empty(h.Paths);
    }

    private static string Worker()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Worker.cs"));
    }

    // הקטע שבין בניית הודעת התקלה לבין ה-continue שמסיים את נתיב הכשל.
    private static string FailurePath()
    {
        string w = Worker();
        int from = w.IndexOf("var errorState = new StateMessage", StringComparison.Ordinal);
        Assert.True(from >= 0, "נתיב כשל ה-PLC לא נמצא — הבדיקה מסתכלת על קוד שהשתנה");
        int to = w.IndexOf("continue;", from, StringComparison.Ordinal);
        Assert.True(to > from, "ה-continue שמסיים את הנתיב לא נמצא");
        return w[from..to];
    }

    // ============================================================
    // ⚠️ המיקום הוא הטענה, לא עצם הקיום
    // ============================================================
    // `mirrored` נשלח בשלב הכתיבה הישירה — שנמצא **אחרי** ה-continue.
    // הודעה שהייתה נכנסת לשם לא הייתה נשלחת לעולם, כי סבב מוצלח לא יגיע
    // כל עוד הבקר מת, וזה בדיוק המצב שבו התקלה רלוונטית.
    [Fact]
    public void TheFaultIsSentInsideTheFailurePathNotThroughMirrored()
    {
        string path = FailurePath();
        Assert.Contains("supabase.SendAsync", path);
        Assert.DoesNotContain("mirrored.Add", path);
    }

    // ⚠️ ובלי התור, כתיבה שנכשלה ברשת מוחקת את התקלה. הבקר עלול לחזור
    // בעוד שעה, ואז המקטע חייב להיפתח בזמן שהוא קרה ולא בזמן ההתאוששות.
    [Fact]
    public void AFailedDirectWriteIsQueuedRatherThanDropped()
    {
        Assert.Contains("supaQueue.Enqueue", FailurePath());
    }

    // ============================================================
    // ⚠️ הדגל שמונע שידור חוזר חייב להיות תלוי בשני המסלולים
    // ============================================================
    // כשהוא נקבע בתוך ענף ההצלחה של MQTT בלבד, אתר במסלול ישיר משדר את
    // אותה תקלה **בכל סבב** — כלומר בקשה לשנייה, לנצח, על אתר שכבר דיווח.
    [Fact]
    public void TheAlreadyReportedFlagIsNotSetInsideTheMqttBranch()
    {
        string path = FailurePath();
        Assert.DoesNotContain("plcErrorReported = true;", path);
        Assert.Contains("plcErrorReported = errorReported;", path);
    }
}
