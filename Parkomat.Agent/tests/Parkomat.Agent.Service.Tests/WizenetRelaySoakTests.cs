using System.Net;
using System.Text;
using System.Threading.Channels;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Wizenet;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הממסר לאורך זמן (15/10/2026): בשטח הוא רץ שבועות בלי הפעלה מחדש, ליד קריאת הבקר. דליפה קטנה — חיבור שלא נסגר,
/// משימה שלא מסתיימת, רשימה שגדלה — הופכת שם לזיכרון שנגמר. כאן: אלפי חיבורים מחדש ואלפי בקשות, והזיכרון נמדד באמצע
/// ובסוף. ⚠️ מדידה גסה בכוונה (GC מלא, ומרווח נדיב): היא תופסת גידול ליניארי — המסלול שבו דליפה נראית — ולא רעש.
/// </summary>
public class WizenetRelaySoakTests
{
    private static long Heap()
    {
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        return GC.GetTotalMemory(forceFullCollection: true);
    }

    // חיבור שעונה "הצטרפת" ונסגר מיד — סבב שלם של חיבור, הצטרפות, צלצול, ניתוק
    private sealed class FlakyConn : IRealtimeConnection
    {
        private readonly Channel<string?> _in = Channel.CreateUnbounded<string?>();
        // ⚠️ מחרוזת חדשה בכל סבב, כמו שמגיעה מהרשת: מחרוזת קבועה היא אותו מופע תמיד, ודליפה שלה הייתה דליפה של מצביעים
        // בלבד — מוטציה כזו שרדה את הבדיקה
        public FlakyConn(int n)
        {
            _in.Writer.TryWrite("""{"event":"phx_reply","topic":"realtime:wizenet-relay","ref":"1","payload":{"status":"ok","response":{"n":""" + n + "}}}");
            _in.Writer.TryWrite(null);
        }
        public Task ConnectAsync(Uri uri, CancellationToken ct) => Task.CompletedTask;
        public Task SendAsync(string text, CancellationToken ct) => Task.CompletedTask;
        public async Task<string?> ReceiveAsync(CancellationToken ct) => await _in.Reader.ReadAsync(ct);
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    [Fact]
    public async Task ThousandsOfReconnectsLeakNothing()
    {
        int sessions = 0, rings = 0;
        long mid = 0, end = 0;
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var bell = new RealtimeDoorbell(new Uri("wss://x.test/realtime/v1/websocket"),
            () =>
            {
                // ⚠️ המדידה בתוך הלולאה, בסבב מסוים — לא "כשהבדיקה תספיק להסתכל": הלולאה מהירה מהשעון של הבדיקה
                int n = Interlocked.Increment(ref sessions);
                if (n == 5_000) mid = Heap();   // אחרי החימום (נמדד: ~300KB של קומפילציה ומאגרים בהתחלה)
                if (n == 30_000) { end = Heap(); cts.Cancel(); }
                return new FlakyConn(n);
            },
            () => "jwt", () => Interlocked.Increment(ref rings), (_, _) => { },
            TimeSpan.FromSeconds(25), TimeSpan.FromSeconds(60), _ => TimeSpan.Zero, TimeSpan.FromMinutes(2));
        // ⚠️ Task.Run: עם רכיבים מזויפים כל קריאה מסתיימת מיד, ו-RunAsync היה רץ את כל 30,000 הסבבים בלי לחזור — כלומר
        // "האמצע" נמדד אחרי הסוף, והבדיקה עברה גם עם דליפה מכוונת (נמדד: מוטציה שהוסיפה לרשימה סטטית שרדה).
        Task run = Task.Run(() => bell.RunAsync(cts.Token));
        await run;
        Assert.True(sessions >= 30_000, $"sessions {sessions}");
        Assert.True(rings >= 29_000, $"rings {rings}");
        // 29,500 סבבים נוספים. דליפה של 50 בתים לסבב היא 1.5MB
        Console.WriteLine($"reconnects: heap {mid / 1024}KB → {end / 1024}KB");
        Assert.True(end - mid < 1_000_000, $"הזיכרון גדל ב-{(end - mid) / 1024}KB על פני 25,000 חיבורים מחדש");
    }

    // Supabase ו-ויזנט מזויפים, בלי לרשום את הבקשות (רישום היה הדליפה של הבדיקה עצמה)
    private sealed class Quiet : HttpMessageHandler
    {
        private int _left;
        public int Completed;
        public long Mid, End;
        public Quiet(int requests) => _left = requests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            string path = r.RequestUri!.AbsolutePath;
            string body = path switch
            {
                "/auth/v1/token" => """{"access_token":"jwt","expires_in":3600}""",
                "/rest/v1/rpc/wizenet_relay_me" => "true",
                "/functions/v1/wizenet" => """{"token":"WZ","base":"https://wz.test/api","vars":{}}""",
                "/rest/v1/rpc/wizenet_claim" => Interlocked.Decrement(ref _left) >= 0
                    ? """{"id":1,"attempt":1,"calls":[{"func":"wizeApp_updateCallStatus","body":{"callid":"1","callstatusid":"2"}}]}"""
                    : "null",
                "/rest/v1/rpc/wizenet_complete" => Done(),
                _ => "update successfully",
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
        private string Done()
        {
            int n = Interlocked.Increment(ref Completed);
            if (n == 5_000) Mid = Heap();        // ⚠️ בתוך הלולאה, אחרי החימום (ראו בבדיקת החיבורים)
            if (n == 30_000) End = Heap();
            return """{"accepted":true}""";
        }
    }

    private sealed class SilentBell : IDoorbell
    {
        public bool Subscribed => true;
        public async Task RunAsync(CancellationToken ct) { try { await Task.Delay(Timeout.Infinite, ct); } catch (OperationCanceledException) { } }
    }

    [Fact]
    public async Task ThousandsOfRequestsLeakNothing()
    {
        var h = new Quiet(30_000);
        var loop = new WizenetRelayLoop(
            new RelayApi(new SupabaseConfig { SiteId = "1", Password = "pw" }, new HttpClient(h)),
            new WizenetForwarder(new HttpClient(h)),
            (_, _) => new SilentBell(), "1.0.60", (_, _) => { },
            new RelayTimings(TimeSpan.FromMilliseconds(20), TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(10), TimeSpan.FromMilliseconds(20)));
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        Task run = Task.Run(() => loop.RunAsync(cts.Token));   // ⚠️ ראו ההערה בבדיקה הקודמת
        while (Volatile.Read(ref h.Completed) < 30_000) await Task.Delay(5);
        cts.Cancel();
        await run;
        long mid = h.Mid, end = h.End;
        Console.WriteLine($"requests: heap {mid / 1024}KB → {end / 1024}KB");
        Assert.True(end - mid < 1_000_000, $"הזיכרון גדל ב-{(end - mid) / 1024}KB על פני 25,000 בקשות");
    }
}
