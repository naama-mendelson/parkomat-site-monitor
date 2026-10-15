using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Wizenet;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הממסר לוויזנט (15/10/2026) — עם handler מזויף וחיבור WebSocket מזויף, בלי רשת.
///
/// ⚠️ <b>הבדיקות סופרות בקשות שיצאו, ולא קוראות את הקוד.</b> הלקח מהפעימה הראשונה (BeatAsync), שלא שלחה בקשה אחת
/// ועברה שלוש בדיקות מבניות. כאן כל טענה היא על מה שנשלח לאן ובאיזה גוף: לוויזנט — רק מה שבבקשה, עם הטוקן
/// כמות שהוא; ל-Supabase — התשובה כמערך JSON ולא כמחרוזת.
/// </summary>
public class WizenetRelayTests
{
    // ================================================================
    // תשתית
    // ================================================================

    private sealed record Sent(string Method, string Url, string Path, string? Auth, string? ApiKey, string Body);

    private sealed class Router : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, string, HttpResponseMessage> _reply;
        public ConcurrentQueue<Sent> Requests { get; } = new();
        public Router(Func<HttpRequestMessage, string, HttpResponseMessage> reply) => _reply = reply;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            string body = r.Content is null ? "" : await r.Content.ReadAsStringAsync(ct);
            Requests.Enqueue(new Sent(r.Method.Method, r.RequestUri!.ToString(), r.RequestUri.AbsolutePath,
                r.Headers.TryGetValues("Authorization", out var a) ? a.First() : null,
                r.Headers.TryGetValues("apikey", out var k) ? k.First() : null, body));
            return _reply(r, body);
        }
    }

    private static HttpResponseMessage Res(HttpStatusCode code, string body) =>
        new(code) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static RelayConfig Cfg(params (string, string)[] vars) =>
        new("WZ-SECRET", "https://wz.test/api", vars.ToDictionary(v => v.Item1, v => v.Item2));

    private static JsonElement Calls(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static SupabaseConfig Sb() => new() { SiteId = "7601", Password = "pw" };

    private static async Task WaitUntil(Func<bool> cond, string what, int ms = 5000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (!cond())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("לא קרה: " + what);
            await Task.Delay(10);
        }
    }

    // ================================================================
    // השליחה לוויזנט
    // ================================================================

    [Fact]
    public async Task SendsExactlyTheCallWithTheRawToken()
    {
        var h = new Router((_, _) => Res(HttpStatusCode.OK, "update successfully"));
        var fwd = new WizenetForwarder(new HttpClient(h));
        string results = await fwd.ExecuteAsync(
            Calls("""[{"func":"wizeApp_updateCallStatus","body":{"callid":"880001","callstatusid":"151"}}]"""),
            Cfg(), CancellationToken.None);

        Sent s = Assert.Single(h.Requests);
        Assert.Equal("POST", s.Method);
        Assert.Equal("https://wz.test/api?func=wizeApp_updateCallStatus", s.Url);
        // ⚠️ כמות שהוא, בלי Bearer — כך ויזנט מגדירים, וכך פונקציית ה-Edge שלחה
        Assert.Equal("WZ-SECRET", s.Auth);
        Assert.Equal("""{"callid":"880001","callstatusid":"151"}""", s.Body);
        Assert.Equal("""[{"status":200,"text":"update successfully"}]""", results);
    }

    [Fact]
    public async Task PlaceholdersComeFromTheConfigAndEachCallIsSent()
    {
        var h = new Router((_, _) => Res(HttpStatusCode.OK, "[]"));
        var fwd = new WizenetForwarder(new HttpClient(h));
        await fwd.ExecuteAsync(Calls("""
            [{"kind":"status","func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_status}}"}},
             {"kind":"type","func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_type}}"}}]
            """), Cfg(("qry_status", "Q1"), ("qry_type", "Q2")), CancellationToken.None);

        Assert.Equal(["""{"QRYID":"Q1"}""", """{"QRYID":"Q2"}"""], h.Requests.Select(r => r.Body));

        // המילוי עצמו — גם בתוך מערכים ואובייקטים מקוננים
        JsonNode node = JsonNode.Parse("""{"a":["{{x}}",1],"b":{"c":"{{x}}"},"d":"{{x}} not alone"}""")!;
        Assert.Null(WizenetForwarder.Fill(node, new Dictionary<string, string> { ["x"] = "V" }));
        Assert.Equal("""{"a":["V",1],"b":{"c":"V"},"d":"{{x}} not alone"}""", node.ToJsonString());
    }

    [Fact]
    public async Task AMissingValueOrAForbiddenFunctionIsNotSent()
    {
        var h = new Router((_, _) => Res(HttpStatusCode.OK, "[]"));
        var fwd = new WizenetForwarder(new HttpClient(h));

        string r1 = await fwd.ExecuteAsync(Calls("""
            [{"func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_status}}"}}]
            """), Cfg(("qry_status", "  ")), CancellationToken.None);
        Assert.Contains("\"error\":\"config\"", r1);
        Assert.Contains("qry_status", r1);

        // ⚠️ רשימת ההיתר: גם מי שמשתלט על המסד לא יגרום לממסר לקרוא לפונקציה אחרת של ויזנט עם הטוקן
        string r2 = await fwd.ExecuteAsync(Calls("""[{"func":"wizeApp_deleteCall","body":{"callid":"1"}}]"""),
            Cfg(), CancellationToken.None);
        Assert.Contains("\"error\":\"config\"", r2);
        Assert.Contains("wizeApp_deleteCall", r2);

        // ⚠️ וצורת הגוף (סקירה, 15/10/2026): שאילתת דוח רק עם אחד משני המקומות-השמורים — אחרת מי שמשתלט על המסד
        // היה מריץ דרך הממסר כל דוח של ויזנט. ועדכון — רק מספר קריאה ומספר ערך.
        foreach (string bad in new[]
        {
            """[{"func":"wizeApp_getBIReportQuery","body":{"QRYID":"12345"}}]""",
            """[{"func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_status}}","x":1}}]""",
            """[{"func":"wizeApp_getBIReportQuery","body":{}}]""",
            """[{"func":"wizeApp_updateCallStatus","body":{"callid":"1","callstatusid":"2","extra":"3"}}]""",
            """[{"func":"wizeApp_updateCallStatus","body":{"callid":"1;drop","callstatusid":"2"}}]""",
            """[{"func":"wizeApp_updateCallStatus","body":{"callid":1,"callstatusid":"2"}}]""",
            """[{"func":"wizeApp_updateCallType","body":{"callid":"1","callstatusid":"2"}}]""",
            """[{"func":"wizeApp_updateCallStatus"}]""",
        })
        {
            string r = await fwd.ExecuteAsync(Calls(bad), Cfg(("qry_status", "Q1")), CancellationToken.None);
            Assert.True(r.Contains("\"error\":\"config\""), bad);
        }

        Assert.Empty(h.Requests);
    }

    [Fact]
    public async Task TimeoutAndNetworkFailuresAreReportedAndStopTheRest()
    {
        const string two = """
            [{"func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_status}}"}},{"func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_type}}"}}]
            """;
        var timeout = new Router((_, _) => throw new TaskCanceledException("HttpClient.Timeout"));
        RelayConfig q = Cfg(("qry_status", "Q1"), ("qry_type", "Q2"));
        string r1 = await new WizenetForwarder(new HttpClient(timeout)).ExecuteAsync(Calls(two), q, CancellationToken.None);
        Assert.StartsWith("""[{"error":"timeout""", r1);
        Assert.Single(timeout.Requests);

        var network = new Router((_, _) => throw new HttpRequestException("No such host is known"));
        string r2 = await new WizenetForwarder(new HttpClient(network)).ExecuteAsync(Calls(two), q, CancellationToken.None);
        Assert.StartsWith("""[{"error":"network","detail":"No such host is known"}""", r2);

        // ⚠️ תשובה שאינה 2xx (הפניה להתחברות) — גם היא עוצרת: אין טעם לשלוח שוב עם טוקן שנדחה
        var redirect = new Router((_, _) => Res(HttpStatusCode.Found, "Object moved"));
        string r3 = await new WizenetForwarder(new HttpClient(redirect)).ExecuteAsync(Calls(two), q, CancellationToken.None);
        Assert.Equal("""[{"status":302,"text":"Object moved"}]""", r3);
        Assert.Single(redirect.Requests);
    }

    [Fact]
    public async Task ALongAnswerIsCut()
    {
        var h = new Router((_, _) => Res(HttpStatusCode.OK, new string('x', WizenetForwarder.MaxText + 50)));
        string r = await new WizenetForwarder(new HttpClient(h)).ExecuteAsync(
            Calls("""[{"func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_status}}"}}]"""), Cfg(("qry_status", "Q1")), CancellationToken.None);
        Assert.Equal(WizenetForwarder.MaxText, JsonDocument.Parse(r).RootElement[0].GetProperty("text").GetString()!.Length);
    }

    [Fact]
    public async Task HebrewTravelsAsIsNotEscaped()
    {
        // ⚠️ ברירת המחדל של .NET הייתה שולחת כל אות עברית כ-escape של יוניקוד — פי שישה, ושורת האבחון במסד בלתי קריאה
        var h = new Router((_, _) => Res(HttpStatusCode.OK, """[{"id":"148","name":"פתוחה"}]"""));
        string r = await new WizenetForwarder(new HttpClient(h)).ExecuteAsync(
            Calls("""[{"func":"wizeApp_getBIReportQuery","body":{"QRYID":"{{qry_status}}"}}]"""), Cfg(("qry_status", "שאילתה")), CancellationToken.None);
        Assert.Contains("פתוחה", r);
        Assert.Equal("""{"QRYID":"שאילתה"}""", Assert.Single(h.Requests).Body);
    }

    [Fact]
    public async Task ATokenWithAControlCharacterIsNeverSent()
    {
        // ⚠️ נמדד בבדיקה החיה (15/10/2026): שורה חדשה בסוף הטוקן שברה את הבקשה באמצע הכותרות — Content-Length נפל
        // לגוף, וויזנט ענו 411 על כל פנייה. TryAddWithoutValidation אינו בודק, ולכן הבדיקה כאן.
        var h = new Router((_, _) => Res(HttpStatusCode.OK, "update successfully"));
        var fwd = new WizenetForwarder(new HttpClient(h));
        foreach (string token in new[] { "Bearer WZ\n", "Bearer W\r\nX-Evil: 1", "WZ\t" })
        {
            string r = await fwd.ExecuteAsync(Calls("""[{"func":"wizeApp_updateCallStatus","body":{"callid":"1","callstatusid":"2"}}]"""),
                new RelayConfig(token, "https://wz.test/api", new Dictionary<string, string>()), CancellationToken.None);
            Assert.Contains("\"error\":\"config\"", r);
        }
        Assert.Empty(h.Requests);
    }

    [Fact]
    public void RedirectsAreNeverFollowed()
    {
        // ⚠️ ויזנט עונים לטוקן לא תקף ב-302 לדף ההתחברות. מעקב היה מחזיר HTML כ-200, והמסד לא היה יודע שהטוקן נדחה
        Assert.False(WizenetForwarder.CreateHandler().AllowAutoRedirect);
        using HttpClient c = WizenetForwarder.CreateHttpClient();
        Assert.Equal(TimeSpan.FromSeconds(15), c.Timeout);
    }

    // ================================================================
    // הצד של Supabase
    // ================================================================

    private const string TokenBody = """{"access_token":"jwt-1","expires_in":3600}""";

    [Fact]
    public async Task ClaimAndCompleteSendTheContractBodies()
    {
        var claims = new Queue<string>(["""{"id":5,"attempt":2,"calls":[{"func":"wizeApp_updateCallType","body":{"callid":"1","calltypeid":"2"}}]}""", "null"]);
        var h = new Router((r, _) => r.RequestUri!.AbsolutePath switch
        {
            "/auth/v1/token" => Res(HttpStatusCode.OK, TokenBody),
            "/rest/v1/rpc/wizenet_claim" => Res(HttpStatusCode.OK, claims.Dequeue()),
            "/rest/v1/rpc/wizenet_complete" => Res(HttpStatusCode.OK, """{"accepted":true,"state":"done"}"""),
            _ => Res(HttpStatusCode.NotFound, "{}"),
        });
        var api = new RelayApi(Sb(), new HttpClient(h));

        RelayRequest? req = await api.ClaimAsync(true, "1.0.60", CancellationToken.None);
        Assert.NotNull(req);
        Assert.Equal((5L, 2), (req!.Id, req.Attempt));
        Assert.Equal("wizeApp_updateCallType", req.Calls[0].GetProperty("func").GetString());
        Assert.Null(await api.ClaimAsync(false, null, CancellationToken.None));
        Assert.True(await api.CompleteAsync(5, 2, """[{"status":200,"text":"update successfully"}]""", CancellationToken.None));

        Sent[] all = h.Requests.ToArray();
        Assert.Equal(["/auth/v1/token", "/rest/v1/rpc/wizenet_claim", "/rest/v1/rpc/wizenet_claim", "/rest/v1/rpc/wizenet_complete"],
            all.Select(s => s.Path));
        Assert.Contains("site-7601@parkomat.co.il", all[0].Body);
        Assert.Equal("""{"p_socket":true,"p_version":"1.0.60"}""", all[1].Body);
        Assert.All(all.Skip(1), s => Assert.Equal("Bearer jwt-1", s.Auth));
        Assert.All(all, s => Assert.Equal(SupabaseDefaults.AnonKey, s.ApiKey));
        // ⚠️ p_results כמערך JSON — לא כמחרוזת. מחרוזת הייתה נקראת במסד "הממסר לא החזיר תשובה"
        using JsonDocument complete = JsonDocument.Parse(all[3].Body);
        Assert.Equal(JsonValueKind.Array, complete.RootElement.GetProperty("p_results").ValueKind);
        Assert.Equal(5, complete.RootElement.GetProperty("p_id").GetInt64());
        Assert.Equal(2, complete.RootElement.GetProperty("p_attempt").GetInt32());
        Assert.Equal("jwt-1", api.CurrentToken);
    }

    [Fact]
    public async Task A401SignsInAgainOnceAndA403IsTheRemovalSignal()
    {
        int claims = 0;
        var h = new Router((r, _) => r.RequestUri!.AbsolutePath switch
        {
            "/auth/v1/token" => Res(HttpStatusCode.OK, TokenBody),
            "/rest/v1/rpc/wizenet_claim" => ++claims == 1 ? Res(HttpStatusCode.Unauthorized, "{}") : Res(HttpStatusCode.OK, "null"),
            "/rest/v1/rpc/wizenet_relay_me" => Res(HttpStatusCode.Forbidden, """{"code":"42501"}"""),
            _ => Res(HttpStatusCode.NotFound, "{}"),
        });
        var api = new RelayApi(Sb(), new HttpClient(h));
        Assert.Null(await api.ClaimAsync(true, null, CancellationToken.None));
        Assert.Equal(2, h.Requests.Count(s => s.Path == "/auth/v1/token"));

        var ex = await Assert.ThrowsAsync<RelayException>(() => api.IsRelayAsync(CancellationToken.None));
        Assert.Equal(403, ex.Status);
    }

    [Fact]
    public async Task TheConfigComesFromTheEdgeFunctionAndMustBeHttps()
    {
        string config = """{"token":"WZ","base":"https://wz.test/api","vars":{"qry_status":"Q1","qry_type":""}}""";
        var h = new Router((r, _) => r.RequestUri!.AbsolutePath switch
        {
            "/auth/v1/token" => Res(HttpStatusCode.OK, TokenBody),
            "/functions/v1/wizenet" => Res(HttpStatusCode.OK, config),
            "/rest/v1/rpc/wizenet_relay_me" => Res(HttpStatusCode.OK, "true"),
            _ => Res(HttpStatusCode.NotFound, "{}"),
        });
        var api = new RelayApi(Sb(), new HttpClient(h));
        Assert.True(await api.IsRelayAsync(CancellationToken.None));
        RelayConfig c = await api.GetConfigAsync(CancellationToken.None);
        Assert.Equal(("WZ", "https://wz.test/api", "Q1", ""), (c.Token, c.Base, c.Vars["qry_status"], c.Vars["qry_type"]));
        Sent f = h.Requests.Single(s => s.Path == "/functions/v1/wizenet");
        Assert.Equal("""{"action":"relay_config"}""", f.Body);
        Assert.Equal("Bearer jwt-1", f.Auth);

        // ⚠️ שורה חדשה בסוף הסוד (נמדד, 15/10/2026) — נחתכת; באמצע — סירוב, ולא בקשה שבורה
        config = "{\"token\":\"Bearer WZ\\n\",\"base\":\" https://wz.test/api\\r\\n\",\"vars\":{\"qry_status\":\"Q1\\n\"}}";
        RelayConfig trimmed = await api.GetConfigAsync(CancellationToken.None);
        Assert.Equal(("Bearer WZ", "https://wz.test/api", "Q1"), (trimmed.Token, trimmed.Base, trimmed.Vars["qry_status"]));
        config = "{\"token\":\"Bearer W\\nZ\",\"base\":\"https://wz.test/api\",\"vars\":{}}";
        await Assert.ThrowsAsync<RelayException>(() => api.GetConfigAsync(CancellationToken.None));

        // ⚠️ הטוקן נוסע בכותרת — כתובת http הייתה שולחת אותו גלוי ברשת של האתר
        config = """{"token":"WZ","base":"http://wz.test/api","vars":{}}""";
        await Assert.ThrowsAsync<RelayException>(() => api.GetConfigAsync(CancellationToken.None));
        config = """{"token":"","base":"https://wz.test/api"}""";
        await Assert.ThrowsAsync<RelayException>(() => api.GetConfigAsync(CancellationToken.None));
    }

    // ================================================================
    // הפעמון — חיבור מזויף
    // ================================================================

    private sealed class FakeConn : IRealtimeConnection
    {
        public Channel<string?> Inbound { get; } = Channel.CreateUnbounded<string?>();
        public ConcurrentQueue<string> Sent { get; } = new();
        public Uri? Uri { get; private set; }
        public Task ConnectAsync(Uri uri, CancellationToken ct) { Uri = uri; return Task.CompletedTask; }
        public Task SendAsync(string text, CancellationToken ct) { Sent.Enqueue(text); return Task.CompletedTask; }
        public async Task<string?> ReceiveAsync(CancellationToken ct) => await Inbound.Reader.ReadAsync(ct);
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        public void Push(string? msg) => Inbound.Writer.TryWrite(msg);
    }

    private sealed class Bell
    {
        public List<FakeConn> Conns { get; } = [];
        public int Rings;
        public string Token = "jwt-1";
        public RealtimeDoorbell Doorbell { get; }
        public ConcurrentQueue<int> Backoffs { get; } = new();
        public Bell(int heartbeatMs = 10_000, int silenceMs = 60_000, int stableMs = 120_000)
        {
            Doorbell = new RealtimeDoorbell(new Uri("wss://x.test/realtime/v1/websocket"),
                () => { var c = new FakeConn(); lock (Conns) Conns.Add(c); return c; },
                () => Token, () => Interlocked.Increment(ref Rings), (_, _) => { },
                TimeSpan.FromMilliseconds(heartbeatMs), TimeSpan.FromMilliseconds(silenceMs),
                n => { Backoffs.Enqueue(n); return TimeSpan.FromMilliseconds(10); },
                TimeSpan.FromMilliseconds(stableMs));
        }
        public FakeConn Last { get { lock (Conns) return Conns[^1]; } }
        public int Count { get { lock (Conns) return Conns.Count; } }
    }

    private const string JoinOk = """{"event":"phx_reply","topic":"realtime:wizenet-relay","ref":"1","payload":{"status":"ok","response":{}}}""";
    private static string Change(string action, string topic = RealtimeDoorbell.Topic) =>
        $$$$$$"""{"event":"postgres_changes","topic":"{{{{{{topic}}}}}}","ref":null,"payload":{"data":{"type":"INSERT","table":"events","record":{"id":9,"type":"service_calls","payload":{"type":"service_calls","action":"{{{{{{action}}}}}}","id":3}}}}}""";

    [Fact]
    public async Task JoinsWithTheFilterAndTheTokenAndRingsOnSubscribe()
    {
        var b = new Bell();
        using var cts = new CancellationTokenSource();
        Task run = b.Doorbell.RunAsync(cts.Token);
        await WaitUntil(() => b.Count == 1 && !b.Last.Sent.IsEmpty, "join נשלח");

        using JsonDocument join = JsonDocument.Parse(b.Last.Sent.First());
        JsonElement j = join.RootElement;
        Assert.Equal(("realtime:wizenet-relay", "phx_join", "1"), (j.GetProperty("topic").GetString(), j.GetProperty("event").GetString(), j.GetProperty("ref").GetString()));
        JsonElement pc = j.GetProperty("payload").GetProperty("config").GetProperty("postgres_changes")[0];
        Assert.Equal(("INSERT", "public", "events", "type=eq.service_calls"),
            (pc.GetProperty("event").GetString(), pc.GetProperty("schema").GetString(), pc.GetProperty("table").GetString(), pc.GetProperty("filter").GetString()));
        Assert.Equal("jwt-1", j.GetProperty("payload").GetProperty("access_token").GetString());
        Assert.False(b.Doorbell.Subscribed);

        b.Last.Push(JoinOk);
        await WaitUntil(() => b.Doorbell.Subscribed, "מנוי");
        // ⚠️ צלצול בהצטרפות: מה שנכנס לתור בזמן שהחיבור היה למטה לא יגיע כהודעה לעולם
        await WaitUntil(() => b.Rings == 1, "צלצול בהצטרפות");

        cts.Cancel();
        await run;
        Assert.False(b.Doorbell.Subscribed);
    }

    [Fact]
    public async Task RingsOnlyForARelayRowOnItsOwnTopic()
    {
        var b = new Bell();
        using var cts = new CancellationTokenSource();
        Task run = b.Doorbell.RunAsync(cts.Token);
        await WaitUntil(() => b.Count == 1, "חיבור");
        b.Last.Push(JoinOk);
        await WaitUntil(() => b.Rings == 1, "צלצול בהצטרפות");

        b.Last.Push(Change("relay"));
        await WaitUntil(() => b.Rings == 2, "צלצול על בקשה");
        b.Last.Push(Change("status"));
        b.Last.Push(Change("relay", "realtime:other"));
        b.Last.Push("not json");
        b.Last.Push(Change("relay"));
        await WaitUntil(() => b.Rings == 3, "צלצול שני");
        await Task.Delay(50);
        Assert.Equal(3, b.Rings);
        Assert.Equal(1, b.Count);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task HeartbeatsAndSendsTheRenewedToken()
    {
        var b = new Bell(heartbeatMs: 20);
        using var cts = new CancellationTokenSource();
        Task run = b.Doorbell.RunAsync(cts.Token);
        await WaitUntil(() => b.Count == 1, "חיבור");
        b.Last.Push(JoinOk);
        await WaitUntil(() => b.Last.Sent.Any(s => s.Contains("\"heartbeat\"") && s.Contains("\"phoenix\"")), "פעימה");
        Assert.DoesNotContain(b.Last.Sent, s => s.Contains("\"access_token\":\"jwt-2\""));

        // ⚠️ ההזדהות על הערוץ פגה אחרי שעה, ו-Supabase סוגר אותו בשקט — האסימון שהתחדש נשלח בפעימה הבאה
        b.Token = "jwt-2";
        await WaitUntil(() => b.Last.Sent.Any(s => s.Contains("\"event\":\"access_token\"") && s.Contains("jwt-2")), "אסימון חדש");
        string renew = b.Last.Sent.First(s => s.Contains("\"event\":\"access_token\""));
        Assert.Contains("\"topic\":\"realtime:wizenet-relay\"", renew);
        Assert.Contains("\"join_ref\":\"1\"", renew);
        await Task.Delay(60);
        Assert.Single(b.Last.Sent, s => s.Contains("\"event\":\"access_token\""));
        cts.Cancel();
        await run;
    }

    [Theory]
    [InlineData("close")]
    [InlineData("""{"event":"system","topic":"realtime:wizenet-relay","payload":{"status":"error","message":"Token has expired"}}""")]
    [InlineData("""{"event":"phx_close","topic":"realtime:wizenet-relay","payload":{}}""")]
    [InlineData("""{"event":"phx_reply","topic":"realtime:wizenet-relay","ref":"1","payload":{"status":"error","response":{"reason":"denied"}}}""")]
    public async Task AnythingThatEndsTheChannelReconnects(string end)
    {
        var b = new Bell();
        using var cts = new CancellationTokenSource();
        Task run = b.Doorbell.RunAsync(cts.Token);
        await WaitUntil(() => b.Count == 1, "חיבור");
        if (!end.Contains("phx_reply")) { b.Last.Push(JoinOk); await WaitUntil(() => b.Doorbell.Subscribed, "מנוי"); }

        FakeConn first = b.Last;
        first.Push(end == "close" ? null : end);
        await WaitUntil(() => b.Count == 2 && !b.Last.Sent.IsEmpty, "חיבור מחדש");
        Assert.Contains("phx_join", b.Last.Sent.First());
        b.Last.Push(JoinOk);
        await WaitUntil(() => b.Doorbell.Subscribed, "מנוי מחדש");
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task ASilentServerIsTreatedAsDead()
    {
        // ⚠️ NAT שהפיל את החיבור בשקט: לא סגירה ולא שגיאה — פשוט אין הודעות. בלי זה הפעמון היה "מחובר" לנצח
        var b = new Bell(heartbeatMs: 20, silenceMs: 100);
        using var cts = new CancellationTokenSource();
        Task run = b.Doorbell.RunAsync(cts.Token);
        await WaitUntil(() => b.Count == 1, "חיבור");
        b.Last.Push(JoinOk);
        await WaitUntil(() => b.Count >= 2, "חיבור מחדש אחרי שתיקה");
        cts.Cancel();
        await run;
    }

    [Theory]
    [InlineData(120_000, new[] { 1, 2, 3 })]   // חיבורים קצרים — ההמתנה גדלה
    [InlineData(0, new[] { 1, 1, 1 })]         // חיבור שהחזיק — מתחילים מחדש
    public async Task AJoinThatFailsRightAwayDoesNotResetTheBackoff(int stableMs, int[] expected)
    {
        // ⚠️ סקירה, 15/10/2026: Supabase יכול לאשר את ההצטרפות ומיד לשלוח system עם שגיאה. איפוס באישור היה חיבור
        // מחדש כל 5 שניות לנצח — כל אחד גם צלצול, כלומר שאלה לתור.
        var b = new Bell(stableMs: stableMs);
        using var cts = new CancellationTokenSource();
        Task run = b.Doorbell.RunAsync(cts.Token);
        for (int i = 1; i <= 3; i++)
        {
            await WaitUntil(() => b.Count == i, $"חיבור {i}");
            b.Last.Push(JoinOk);
            b.Last.Push("""{"event":"system","topic":"realtime:wizenet-relay","payload":{"status":"error","message":"Unable to subscribe to changes"}}""");
            await WaitUntil(() => b.Backoffs.Count == i, $"המתנה {i}");
        }
        cts.Cancel();
        await run;
        Assert.Equal(expected, b.Backoffs.Take(3).ToArray());
    }

    [Fact]
    public void TheSocketAddressComesFromTheSiteSettings()
    {
        Uri u = RealtimeDoorbell.SocketUri(Sb());
        Assert.Equal($"wss://xvfsikwaaaohnmldjbtv.supabase.co/realtime/v1/websocket?apikey={SupabaseDefaults.AnonKey}&vsn=1.0.0",
            u.ToString());
    }

    // ================================================================
    // הלולאה
    // ================================================================

    private sealed class FakeBell : IDoorbell
    {
        public Action? Ring;
        public bool Subscribed => true;
        public async Task RunAsync(CancellationToken ct)
        {
            try { await Task.Delay(Timeout.Infinite, ct); } catch (OperationCanceledException) { }
        }
    }

    private sealed class World
    {
        public bool Relay = true;
        public HttpStatusCode? ClaimFails;
        public bool NetworkDown;
        public int ConfigStatus = 200;
        public int WizenetStatus = 200;
        public bool WizenetHangs;
        public Func<int, bool>? HangOn;     // לפי מספר הפנייה לוויזנט (מ-1)
        private int _wizenetCalls;
        public readonly ConcurrentQueue<string> Pending = new();
        public readonly ConcurrentQueue<string> Completed = new();
        public readonly List<FakeBell> Bells = [];
        public Router Supabase { get; }
        public Router Wizenet { get; }
        public int ConfigFetches => Supabase.Requests.Count(s => s.Path == "/functions/v1/wizenet");
        public int Claims => Supabase.Requests.Count(s => s.Path == "/rest/v1/rpc/wizenet_claim");

        public World()
        {
            Supabase = new Router((r, body) =>
            {
                if (NetworkDown) throw new HttpRequestException("network is down");
                return r.RequestUri!.AbsolutePath switch
                {
                    "/auth/v1/token" => Res(HttpStatusCode.OK, TokenBody),
                    "/rest/v1/rpc/wizenet_relay_me" => Res(HttpStatusCode.OK, Relay ? "true" : "false"),
                    "/rest/v1/rpc/wizenet_claim" => ClaimFails is { } code ? Res(code, "{}")
                        : Res(HttpStatusCode.OK, Pending.TryDequeue(out var p) ? p : "null"),
                    "/rest/v1/rpc/wizenet_complete" => Done(body),
                    "/functions/v1/wizenet" => Res((HttpStatusCode)ConfigStatus,
                        ConfigStatus == 200 ? """{"token":"WZ","base":"https://wz.test/api","vars":{}}""" : """{"error":"no"}"""),
                    _ => Res(HttpStatusCode.NotFound, "{}"),
                };
            });
            Wizenet = new Router((_, _) => WizenetHangs || (HangOn?.Invoke(Interlocked.Increment(ref _wizenetCalls)) ?? false)
                ? throw new TaskCanceledException("HttpClient.Timeout")
                : Res((HttpStatusCode)WizenetStatus, "update successfully"));
        }

        private HttpResponseMessage Done(string body)
        {
            Completed.Enqueue(body);
            return Res(HttpStatusCode.OK, """{"accepted":true}""");
        }

        public static string Req(long id) =>
            $$$$"""{"id":{{{{id}}}},"attempt":1,"calls":[{"func":"wizeApp_updateCallStatus","body":{"callid":"{{{{id}}}}","callstatusid":"151"}}]}""";

        public WizenetRelayLoop Loop(RelayTimings? t = null) => new(
            new RelayApi(Sb(), new HttpClient(Supabase)), new WizenetForwarder(new HttpClient(Wizenet)),
            (ring, _) => { var b = new FakeBell { Ring = ring }; lock (Bells) Bells.Add(b); return b; },
            "1.0.60", (_, _) => { },
            t ?? new RelayTimings(TimeSpan.FromMilliseconds(40), TimeSpan.FromMilliseconds(40),
                                  TimeSpan.FromMinutes(10), TimeSpan.FromMilliseconds(40)));
    }

    [Fact]
    public async Task ASiteThatIsNotARelayNeverClaimsAndOpensNoSocket()
    {
        var w = new World { Relay = false };
        using var cts = new CancellationTokenSource();
        Task run = w.Loop().RunAsync(cts.Token);
        await WaitUntil(() => w.Supabase.Requests.Count(s => s.Path.EndsWith("wizenet_relay_me")) >= 3, "שאלות חוזרות");
        cts.Cancel();
        await run;
        Assert.Equal(0, w.Claims);
        Assert.Empty(w.Bells);
        Assert.Equal(0, w.ConfigFetches);
    }

    [Fact]
    public async Task ARelayDrainsTheQueueFetchingTheTokenOnce()
    {
        var w = new World();
        w.Pending.Enqueue(World.Req(1));
        w.Pending.Enqueue(World.Req(2));
        using var cts = new CancellationTokenSource();
        Task run = w.Loop().RunAsync(cts.Token);
        await WaitUntil(() => w.Completed.Count == 2, "שתי תשובות");
        cts.Cancel();
        await run;

        Assert.Single(w.Bells);
        Assert.Equal(1, w.ConfigFetches);
        Assert.Equal(["""{"callid":"1","callstatusid":"151"}""", """{"callid":"2","callstatusid":"151"}"""], w.Wizenet.Requests.Select(r => r.Body));
        Assert.All(w.Wizenet.Requests, r => Assert.Equal("WZ", r.Auth));
        Assert.All(w.Completed, c => Assert.Contains("\"p_results\":[{\"status\":200,\"text\":\"update successfully\"}]", c));
        // ⚠️ סימן החיים: הלולאה שואלת גם כשאין עבודה, עם הגרסה ומצב הפעמון
        Assert.Contains(w.Supabase.Requests, s => s.Path.EndsWith("wizenet_claim") && s.Body == """{"p_socket":true,"p_version":"1.0.60"}""");
    }

    [Fact]
    public async Task ARingWakesTheLoopWithoutWaitingForThePoll()
    {
        var w = new World();
        var slow = new RelayTimings(TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(10));
        using var cts = new CancellationTokenSource();
        Task run = w.Loop(slow).RunAsync(cts.Token);
        await WaitUntil(() => w.Claims == 1 && w.Bells.Count == 1, "לקיחה ראשונה");
        w.Pending.Enqueue(World.Req(7));
        w.Bells[0].Ring!();
        await WaitUntil(() => w.Completed.Count == 1, "תשובה אחרי צלצול", 2000);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task RemovalFromTheListStopsTheRelayAndForgetsTheToken()
    {
        var w = new World();
        w.Pending.Enqueue(World.Req(1));
        using var cts = new CancellationTokenSource();
        Task run = w.Loop().RunAsync(cts.Token);
        await WaitUntil(() => w.Completed.Count == 1, "תשובה ראשונה");
        w.ClaimFails = HttpStatusCode.Forbidden;   // המסד: 42501, "אינו ממסר"
        w.Relay = false;
        await WaitUntil(() => w.Supabase.Requests.Count(s => s.Path.EndsWith("wizenet_relay_me")) >= 3, "חזרה לשינה");
        int claims = w.Claims;
        await Task.Delay(150);
        Assert.Equal(claims, w.Claims);   // רדום — לא לוקח עוד

        // חוזר לרשימה: טוקן מבוקש מחדש (לא נשמר בזיכרון בזמן השינה)
        w.ClaimFails = null;
        w.Relay = true;
        w.Pending.Enqueue(World.Req(2));
        await WaitUntil(() => w.Completed.Count == 2, "תשובה אחרי חזרה");
        cts.Cancel();
        await run;
        Assert.Equal(2, w.ConfigFetches);
        Assert.Equal(2, w.Bells.Count);
    }

    [Fact]
    public async Task A403WhileTheDatabaseStillSaysRelayDoesNotSpin()
    {
        // ⚠️ סקירה, 15/10/2026: 403 בלקיחה בזמן ש-wizenet_relay_me עונה true (הרשאה שחסרה אחרי החלה שגויה). בלי השהיה
        // אחרי היציאה מהמצב הפעיל — התחברות, פעמון, שורת אזהרה וחזרה, פעמים רבות בשנייה, ליד ה-Worker שכותב לאותו יומן.
        var w = new World { ClaimFails = HttpStatusCode.Forbidden };
        var t = new RelayTimings(TimeSpan.FromMilliseconds(20), TimeSpan.FromMilliseconds(300), TimeSpan.FromMinutes(10), TimeSpan.FromMilliseconds(20));
        using var cts = new CancellationTokenSource();
        Task run = w.Loop(t).RunAsync(cts.Token);
        await Task.Delay(800);
        cts.Cancel();
        await run;
        Assert.InRange(w.Claims, 1, 4);
        Assert.InRange(w.Bells.Count, 1, 4);
    }

    [Fact]
    public async Task ASiteThatCannotAskWaitsLongerEachTime()
    {
        // ⚠️ סקירה, 15/10/2026: הלולאה רצה בכל האתרים. בקצב קבוע, תקלה אחת בצד שלנו הייתה מאות אלפי בקשות ביום
        var w = new World { NetworkDown = true };
        var t = new RelayTimings(TimeSpan.FromMilliseconds(20), TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(10), TimeSpan.FromMilliseconds(20));
        using var cts = new CancellationTokenSource();
        Task run = w.Loop(t).RunAsync(cts.Token);
        await Task.Delay(700);
        cts.Cancel();
        await run;
        // 20, 40, 80, 160, 320 ms → כחמישה ניסיונות ב-700 ms; בקצב קבוע של 20 ms — יותר משלושים
        Assert.InRange(w.Supabase.Requests.Count, 2, 8);
    }

    [Fact]
    public async Task ARelayThatCannotReachWizenetStepsAsideForAWhile()
    {
        // ⚠️ חסימה של ויזנט נראית כקצב-זמן (כך נמדד מחו"ל). אחרי שלוש ברצף — הממסר מפסיק לשאול את התור, ולכן אינו
        // נספר כ"חי", והגיבויים לוקחים. אחרי ההשהיה הוא חוזר ומנסה שוב.
        var w = new World { WizenetHangs = true };
        for (int i = 1; i <= 5; i++) w.Pending.Enqueue(World.Req(i));
        var t = new RelayTimings(TimeSpan.FromMilliseconds(40), TimeSpan.FromMilliseconds(40), TimeSpan.FromMinutes(10),
            TimeSpan.FromMilliseconds(40)) { Pause = TimeSpan.FromMilliseconds(600) };
        using var cts = new CancellationTokenSource();
        Task run = w.Loop(t).RunAsync(cts.Token);
        await WaitUntil(() => w.Completed.Count == WizenetRelayLoop.MissesBeforePause, "שלוש תשובות של קצב-זמן");
        int claims = w.Claims;
        await Task.Delay(300);
        Assert.Equal(claims, w.Claims);                       // בהשהיה — לא שואל את התור
        Assert.Equal(WizenetRelayLoop.MissesBeforePause, w.Completed.Count);
        Assert.All(w.Completed, c => Assert.Contains("\"error\":\"timeout\"", c));

        w.WizenetHangs = false;
        await WaitUntil(() => w.Completed.Count == 5, "חזרה אחרי ההשהיה", 5000);
        cts.Cancel();
        await run;
        Assert.Equal(2, w.Bells.Count);                        // פעמון חדש אחרי ההשהיה
        Assert.Contains("update successfully", w.Completed.Last());
    }

    [Fact]
    public async Task OnlyMissesInARowPauseTheRelay()
    {
        // ⚠️ "ברצף" — הצלחה באמצע מאפסת. אחרת רשת מגמגמת (קצב-זמן מדי פעם) הייתה מוציאה ממסר תקין מהמשחק
        var w = new World { HangOn = n => n is 1 or 2 or 4 or 5 };   // לא, לא, כן, לא, לא, כן
        for (int i = 1; i <= 6; i++) w.Pending.Enqueue(World.Req(i));
        var t = new RelayTimings(TimeSpan.FromMilliseconds(40), TimeSpan.FromMilliseconds(40), TimeSpan.FromMinutes(10),
            TimeSpan.FromMilliseconds(40)) { Pause = TimeSpan.FromMinutes(10) };
        using var cts = new CancellationTokenSource();
        Task run = w.Loop(t).RunAsync(cts.Token);
        await WaitUntil(() => w.Completed.Count == 6, "שש תשובות, בלי השהיה", 3000);
        cts.Cancel();
        await run;
        Assert.Single(w.Bells);
    }

    [Fact]
    public async Task NoNetworkNeverEscapesTheLoop()
    {
        var w = new World { NetworkDown = true };
        using var cts = new CancellationTokenSource();
        Task run = w.Loop().RunAsync(cts.Token);
        await WaitUntil(() => w.Supabase.Requests.Count >= 4, "ניסיונות חוזרים");
        Assert.False(run.IsFaulted);
        w.NetworkDown = false;
        w.Pending.Enqueue(World.Req(3));
        await WaitUntil(() => w.Completed.Count == 1, "חזרה לעבודה");
        cts.Cancel();
        await run;
        Assert.True(run.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task ARejectedTokenIsFetchedAgainAndAMissingOneIsStillAnswered()
    {
        var w = new World { WizenetStatus = 302 };
        w.Pending.Enqueue(World.Req(1));
        w.Pending.Enqueue(World.Req(2));
        using var cts = new CancellationTokenSource();
        Task run = w.Loop().RunAsync(cts.Token);
        await WaitUntil(() => w.Completed.Count == 2, "שתי תשובות");
        Assert.Equal(2, w.ConfigFetches);   // ⚠️ אחרי 302 — הטוקן נזרק ונמסר מחדש

        // פונקציית ה-Edge לא מסרה טוקן — עונים בכל זאת, עם הסיבה, ולא משאירים את הבקשה לפוג
        w.ConfigStatus = 503;
        w.Pending.Enqueue(World.Req(3));
        await WaitUntil(() => w.Completed.Count == 3, "תשובה בלי טוקן");
        cts.Cancel();
        await run;
        string last = w.Completed.Last();
        Assert.Contains("\"p_id\":3", last);
        Assert.Contains("\"error\":\"config\"", last);
        Assert.Contains("לא התקבל טוקן", last);
        Assert.Equal(2, w.Wizenet.Requests.Count);
    }

    [Fact]
    public void TokenRejectionAndTheLogSummary()
    {
        Assert.True(WizenetRelayLoop.TokenRejected("""[{"status":302,"text":"x"}]"""));
        Assert.True(WizenetRelayLoop.TokenRejected("""[{"status":200,"text":"x"},{"status":401,"text":""}]"""));
        Assert.True(WizenetRelayLoop.TokenRejected("""[{"status":403,"text":""}]"""));
        Assert.False(WizenetRelayLoop.TokenRejected("""[{"status":200,"text":"x"}]"""));
        Assert.False(WizenetRelayLoop.TokenRejected("""[{"status":500,"text":"x"},{"error":"timeout"}]"""));
        Assert.True(WizenetRelayLoop.Unreached("""[{"status":200,"text":"x"},{"error":"timeout"}]"""));
        Assert.True(WizenetRelayLoop.Unreached("""[{"error":"network","detail":"x"}]"""));
        Assert.False(WizenetRelayLoop.Unreached("""[{"error":"config","detail":"x"}]"""));
        Assert.True(WizenetRelayLoop.Reached("""[{"status":500,"text":"x"}]"""));
        Assert.False(WizenetRelayLoop.Reached("""[{"error":"timeout"}]"""));
        // ⚠️ ביומן — הקודים בלבד, לא הטקסט (רשימה שלמה של סטטוסים)
        Assert.Equal("HTTP 200, timeout", WizenetRelayLoop.Summary("""[{"status":200,"text":"long list"},{"error":"timeout","detail":"x"}]"""));
    }

    // ================================================================
    // החיווט בשירות
    // ================================================================

    private static string Src(params string[] parts)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine([dir!.FullName, "src", .. parts]));
    }

    [Fact]
    public void TheRelayIsItsOwnHostedServiceAfterTheWorker()
    {
        string program = Src("Parkomat.Agent.Service", "Program.cs");
        int worker = program.IndexOf("AddHostedService<Worker>()", StringComparison.Ordinal);
        int relay = program.IndexOf("AddHostedService<WizenetRelayService>()", StringComparison.Ordinal);
        Assert.True(worker > 0 && relay > worker, "הממסר אינו רשום אחרי ה-Worker");
    }

    [Fact]
    public void NothingEscapesTheRelayServiceAndItOnlyReadsTheConfig()
    {
        string s = Src("Parkomat.Agent.Service", "WizenetRelayService.cs");
        string body = s[s.IndexOf("protected override async Task ExecuteAsync", StringComparison.Ordinal)..];
        // ⚠️ השורה הראשונה בתוך try היא await: חריגה לפני ה-await הראשון יוצאת מ-StartAsync, והסוכן לא עולה
        int tryAt = body.IndexOf("try", StringComparison.Ordinal);
        int firstAwait = body.IndexOf("await ", StringComparison.Ordinal);
        Assert.True(tryAt > 0 && firstAwait > tryAt, "יש קוד לפני ה-try");
        Assert.Contains("catch (Exception ex)", body);
        // ⚠️ Load ולא LoadAtStartup: האחרונה מחילה את סימון האיפוס של המתקין — תפקיד של ה-Worker, פעם אחת
        Assert.Contains("ConfigStore.Load()", body);
        Assert.DoesNotContain("LoadAtStartup", body);
        Assert.Contains("WizenetForwarder.CreateHttpClient()", body);
    }
}
