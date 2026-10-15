using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Core.Wizenet;

/// <summary>חיבור הודעות-טקסט אחד. ⚠️ ממשק כדי שהפרוטוקול ייבדק בלי שרת; המימוש האמיתי דק.</summary>
public interface IRealtimeConnection : IAsyncDisposable
{
    Task ConnectAsync(Uri uri, CancellationToken ct);
    Task SendAsync(string text, CancellationToken ct);
    /// <summary>ההודעה הבאה; <c>null</c> — החיבור נסגר.</summary>
    Task<string?> ReceiveAsync(CancellationToken ct);
}

/// <summary>הפעמון, מבחוץ: האם הוא מחובר כרגע, והלולאה שמחזיקה אותו.</summary>
public interface IDoorbell
{
    bool Subscribed { get; }
    Task RunAsync(CancellationToken ct);
}

/// <summary>
/// ה"פעמון" של הממסר: חיבור WebSocket ל-Supabase Realtime, שמצלצל ברגע שנכנסת בקשה לתור (15/10/2026).
///
/// <para>
/// ⚠️ <b>פעמון בלבד, לא הדרך שבה הבקשה עוברת.</b> Realtime אינו שולח שוב הודעה שפוספסה (נמדד בדשבורד: "A missed
/// Realtime event costs up to 5 minutes"), והאינטרנט באתרים אינו יציב. לכן הבקשה עצמה נשארת בטבלה, והצלצול רק
/// מעיר את הלולאה, שתופסת אותה ב-RPC. ואם החיבור מת בשקט — הלולאה בודקת בעצמה פעם בדקה. פעמון שנפל עולה דקה,
/// לא בקשה.
/// </para>
///
/// <para>
/// ⚠️ <b>מצלצל גם בכל התחברות מחדש</b>: מה שנכנס לתור בזמן שהחיבור היה למטה — לא יגיע כהודעה לעולם.
/// </para>
///
/// <para>
/// ⚠️ <b>ההזדהות על החיבור פגה אחרי שעה</b>, ו-Supabase סוגר את הערוץ — בלי שום שגיאה אצלנו אם לא מקשיבים. לכן
/// בכל פעימה בודקים אם האסימון התחדש (הלולאה מחדשת אותו בפניות שלה), ושולחים <c>access_token</c>.
/// </para>
///
/// <para>
/// פרוטוקול Phoenix בגרסה 1.0.0 (JSON), כמו supabase-js: הצטרפות לנושא עם <c>postgres_changes</c> על <c>events</c>,
/// פעימה לנושא <c>phoenix</c>. <b>הסינון בשרת</b> (<c>type=eq.service_calls</c>), והבחירה ב-<c>action: relay</c> כאן.
/// </para>
/// </summary>
public sealed class RealtimeDoorbell : IDoorbell
{
    public const string Topic = "realtime:wizenet-relay";
    public const string Filter = "type=eq.service_calls";
    private const string JoinRef = "1";

    private readonly Uri _uri;
    private readonly Func<IRealtimeConnection> _connect;
    private readonly Func<string?> _token;
    private readonly Action _ring;
    private readonly RelayLog _log;
    private readonly TimeSpan _heartbeat;
    private readonly TimeSpan _silence;
    private readonly Func<int, TimeSpan> _backoff;
    private readonly TimeSpan _stableAfter;
    private volatile bool _subscribed;
    private long _lastHeardTicks;
    private int _ref = 1;

    public RealtimeDoorbell(Uri uri, Func<IRealtimeConnection> connect, Func<string?> token, Action ring, RelayLog log,
                            TimeSpan? heartbeat = null, TimeSpan? silence = null, Func<int, TimeSpan>? backoff = null,
                            TimeSpan? stableAfter = null)
    {
        _uri = uri;
        _connect = connect;
        _token = token;
        _ring = ring;
        _log = log;
        _heartbeat = heartbeat ?? TimeSpan.FromSeconds(25);
        // ⚠️ שתי פעימות בלי שום הודעה מהשרת — החיבור מת גם אם המערכת לא אמרה (NAT שהפיל אותו בשקט)
        _silence = silence ?? TimeSpan.FromSeconds(60);
        _backoff = backoff ?? (n => TimeSpan.FromSeconds(Math.Min(60, 5 * Math.Pow(2, Math.Min(n, 4) - 1))));
        _stableAfter = stableAfter ?? TimeSpan.FromMinutes(2);
    }

    /// <summary>כתובת ה-WebSocket מתוך הגדרות Supabase של האתר (https → wss).</summary>
    public static Uri SocketUri(SupabaseConfig cfg)
    {
        var b = new UriBuilder(cfg.EffectiveUrl.TrimEnd('/')) { Scheme = "wss", Port = -1 };
        b.Path = b.Path.TrimEnd('/') + "/realtime/v1/websocket";
        b.Query = $"apikey={Uri.EscapeDataString(cfg.EffectiveAnonKey)}&vsn=1.0.0";
        return b.Uri;
    }

    public bool Subscribed => _subscribed;

    public async Task RunAsync(CancellationToken ct)
    {
        int failures = 0;
        while (!ct.IsCancellationRequested)
        {
            // ⚠️ הספירה מתאפסת רק אחרי חיבור שהחזיק (סקירה, 15/10/2026), ולא כשההצטרפות אושרה: Supabase יכול לאשר את
            // ההצטרפות ומיד אחר כך לשלוח system עם שגיאה (המנוי ל-postgres_changes נכשל). איפוס באישור היה חיבור מחדש
            // כל 5 שניות לנצח — וכל אחד מהם גם צלצול, כלומר שאלה לתור.
            long started = DateTime.UtcNow.Ticks;
            bool Stable() => DateTime.UtcNow.Ticks - started >= _stableAfter.Ticks;
            try
            {
                await SessionAsync(ct).ConfigureAwait(false);
                if (Stable()) failures = 0;
                _log(false, "Wizenet relay: realtime closed by the server — reconnecting");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                if (Stable()) failures = 0;
                // ⚠️ רק הכשל הראשון ברצף נרשם כאזהרה: אתר בלי אינטרנט היה כותב שורה כל דקה, כל היום
                _log(failures == 0, $"Wizenet relay: realtime down ({WizenetRelayLoop.Describe(ex)}) — the 60s check still runs");
            }
            _subscribed = false;
            failures++;
            try { await Task.Delay(_backoff(failures), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
        _subscribed = false;
    }

    private async Task SessionAsync(CancellationToken ct)
    {
        string token = _token() ?? throw new InvalidOperationException("אין עדיין אסימון");
        await using IRealtimeConnection conn = _connect();
        await conn.ConnectAsync(_uri, ct).ConfigureAwait(false);
        Heard();

        var join = new JsonObject
        {
            ["topic"] = Topic,
            ["event"] = "phx_join",
            ["payload"] = new JsonObject
            {
                ["config"] = new JsonObject
                {
                    ["broadcast"] = new JsonObject { ["ack"] = false, ["self"] = false },
                    ["presence"] = new JsonObject { ["key"] = "", ["enabled"] = false },
                    ["postgres_changes"] = new JsonArray(new JsonObject
                    {
                        ["event"] = "INSERT", ["schema"] = "public", ["table"] = "events", ["filter"] = Filter,
                    }),
                    ["private"] = false,
                },
                ["access_token"] = token,
            },
            ["ref"] = JoinRef,
            ["join_ref"] = JoinRef,
        };
        _ref = 1;
        await conn.SendAsync(join.ToJsonString(), ct).ConfigureAwait(false);
        string sentToken = token;

        using var session = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task reader = ReadAsync(conn, session.Token);
        try
        {
            while (true)
            {
                // ⚠️ השעון על session ולא על ct (מבחן עומס, 15/10/2026): חיבור שנסגר לפני הפעימה השאיר שעון של 25 שנ׳
                // רשום על האסימון הראשי — 7.7MB על פני 29,500 חיבורים מחדש. session מבוטל ב-finally, והשעון איתו.
                Task done = await Task.WhenAny(reader, Task.Delay(_heartbeat, session.Token)).ConfigureAwait(false);
                if (done == reader) { await reader.ConfigureAwait(false); return; }   // נסגר, או זרק — ושם הסיבה
                ct.ThrowIfCancellationRequested();
                if (DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastHeardTicks) > _silence.Ticks)
                    throw new TimeoutException("השרת לא ענה לפעימות");

                string? fresh = _token();
                if (fresh is not null && fresh != sentToken)
                {
                    await conn.SendAsync(Message(Topic, "access_token", new JsonObject { ["access_token"] = fresh }, true), ct)
                        .ConfigureAwait(false);
                    sentToken = fresh;
                    // פעם בשעה — כדי שביומן של האתר יהיה אפשר לראות שהחידוש קורה (בלי האסימון עצמו)
                    _log(false, "Wizenet relay: realtime token renewed");
                }
                await conn.SendAsync(Message("phoenix", "heartbeat", new JsonObject(), false), ct).ConfigureAwait(false);
            }
        }
        finally
        {
            _subscribed = false;
            session.Cancel();
            try { await reader.ConfigureAwait(false); } catch { /* הסיבה כבר נזרקה, או שזה כיבוי */ }
        }
    }

    private async Task ReadAsync(IRealtimeConnection conn, CancellationToken ct)
    {
        while (true)
        {
            string? msg = await conn.ReceiveAsync(ct).ConfigureAwait(false);
            if (msg is null) return;
            Heard();
            Handle(msg);
        }
    }

    // ⚠️ זורק כשהערוץ נכשל — הקורא מתחבר מחדש. הודעה שאינה מוכרת (presence, תשובה לפעימה) — מתעלמים.
    private void Handle(string msg)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(msg); } catch (JsonException) { return; }
        if (root is not JsonObject o) return;
        string? ev = (string?)o["event"];
        string? topic = (string?)o["topic"];
        JsonNode? payload = o["payload"];

        switch (ev)
        {
            case "phx_reply" when topic == Topic && (string?)o["ref"] == JoinRef:
                if ((string?)(payload?["status"]) != "ok")
                    throw new InvalidOperationException("ההצטרפות לערוץ נדחתה: " + payload?["response"]?.ToJsonString());
                _subscribed = true;
                _log(false, "Wizenet relay: realtime subscribed");
                _ring();   // מה שנכנס לתור בזמן שהחיבור היה למטה
                break;
            case "system" when (string?)(payload?["status"]) == "error":
                throw new InvalidOperationException("Realtime: " + (string?)(payload?["message"]));
            case "phx_error" or "phx_close" when topic == Topic:
                throw new InvalidOperationException("הערוץ נסגר (" + ev + ")");
            case "postgres_changes" when topic == Topic:
                JsonNode? record = payload?["data"]?["record"];
                // ⚠️ payload של השורה — אובייקט JSON (עמודת jsonb), ולא מחרוזת
                if ((string?)(record?["payload"]?["action"]) == "relay") _ring();
                break;
        }
    }

    private string Message(string topic, string ev, JsonObject payload, bool joined)
    {
        string next = Interlocked.Increment(ref _ref).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var m = new JsonObject { ["topic"] = topic, ["event"] = ev, ["payload"] = payload, ["ref"] = next };
        if (joined) m["join_ref"] = JoinRef;
        return m.ToJsonString();
    }

    private void Heard() => Interlocked.Exchange(ref _lastHeardTicks, DateTime.UtcNow.Ticks);
}

/// <summary>המימוש האמיתי: <see cref="ClientWebSocket"/> של .NET, בלי ספרייה חיצונית.</summary>
public sealed class ClientWebSocketConnection : IRealtimeConnection
{
    private readonly ClientWebSocket _ws = new();

    public Task ConnectAsync(Uri uri, CancellationToken ct)
    {
        // הפעימות שלנו (Phoenix) הן ששומרות על החיבור; זו של .NET — לנתיבים שמפילים חיבור שקט מהר יותר
        _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        return _ws.ConnectAsync(uri, ct);
    }

    public Task SendAsync(string text, CancellationToken ct) =>
        _ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, endOfMessage: true, ct);

    public async Task<string?> ReceiveAsync(CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var ms = new MemoryStream();
        while (true)
        {
            WebSocketReceiveResult r = await _ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            if (r.MessageType == WebSocketMessageType.Close) return null;
            ms.Write(buffer, 0, r.Count);
            // ⚠️ תקרה: שורת events היא קטנה; הודעה של מגה היא לא משהו שנחכה לסופו
            if (ms.Length > 1_000_000) throw new InvalidOperationException("הודעה גדולה מדי מ-Realtime");
            if (r.EndOfMessage) return Encoding.UTF8.GetString(ms.ToArray());
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_ws.State == WebSocketState.Open)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", cts.Token).ConfigureAwait(false);
            }
        }
        catch { /* סגירה של חיבור שכבר מת */ }
        _ws.Dispose();
    }
}
