using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Core.Wizenet;

/// <summary>כתיבה ביומן של הממסר. <c>warning</c> — מה שמישהו צריך לראות; השאר — מידע.</summary>
public delegate void RelayLog(bool warning, string message);

/// <summary>תשובה לא תקינה מ-Supabase. <see cref="Status"/> הוא קוד ה-HTTP (403 = האתר אינו ממסר עוד).</summary>
public sealed class RelayException(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

/// <summary>מה שפונקציית ה-Edge מוסרת לממסר: הטוקן של ויזנט, הכתובת, וערכים למקומות-שמורים.</summary>
public sealed record RelayConfig(string Token, string Base, IReadOnlyDictionary<string, string> Vars);

/// <summary>בקשה שהממסר לקח: <see cref="Calls"/> — בדיוק מה לשלוח לוויזנט, לפי הסדר.</summary>
public sealed record RelayRequest(long Id, int Attempt, JsonElement Calls);

/// <summary>
/// הצד של Supabase בממסר לוויזנט (15/10/2026): "האם אני ממסר", הטוקן, לקיחת בקשה והחזרת תשובה.
///
/// <para>
/// ⚠️ <b>חיבור משלו, ולא <see cref="SupabaseWriter"/>.</b> שתי התחברויות בשעה במקום אחת — ובתמורה הממסר הוא
/// תחום כשל נפרד: תקלה בו (אסימון שנזרק, בקשה שנתקעה) לא יכולה לעכב את הדיווח של האתר עצמו, שהוא העיקר.
/// אותה מדיניות אסימון בדיוק (<see cref="TokenPolicy"/>), ואותה התחברות בסיסמה במקום refresh_token.
/// </para>
///
/// <para>
/// ⚠️ <b>זורק, בניגוד ל-SupabaseWriter.</b> שם הקורא הוא לולאת הדיווח, שאסור לה להיעצר. כאן הקורא הוא
/// <see cref="WizenetRelayLoop"/>, שתופס כל חריגה — ו-<see cref="RelayException"/> עם קוד 403 הוא בדיוק האות
/// שהאתר הוצא מרשימת הממסרים.
/// </para>
/// </summary>
public sealed class RelayApi
{
    private readonly SupabaseConfig _cfg;
    private readonly HttpClient _http;
    private readonly Func<DateTimeOffset> _now;
    private volatile string? _token;
    private DateTimeOffset? _expiresAt;

    public RelayApi(SupabaseConfig cfg, HttpClient http, Func<DateTimeOffset>? now = null)
    {
        _cfg = cfg ?? throw new ArgumentNullException(nameof(cfg));
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// האסימון הנוכחי, בלי לפנות לרשת — לחיבור ה-WebSocket. ⚠️ מתחדש רק כשהלולאה פונה ל-Supabase (כל דקה),
    /// כלומר הרבה לפני שהוא פג (<see cref="TokenPolicy.RefreshMargin"/>).
    /// </summary>
    public string? CurrentToken => _token;

    /// <summary>"האם האתר הזה ממסר לוויזנט" — לפי המסד (<c>wizenet_relay_me</c>), בזהות של הסוכן.</summary>
    public async Task<bool> IsRelayAsync(CancellationToken ct)
    {
        string body = await RpcAsync("wizenet_relay_me", "{}", ct).ConfigureAwait(false);
        return body.Trim() == "true";
    }

    /// <summary>הטוקן של ויזנט — מפונקציית ה-Edge, שמוסרת אותו רק לממסר. נשמר בזיכרון בלבד.</summary>
    public async Task<RelayConfig> GetConfigAsync(CancellationToken ct)
    {
        string body = await SendAsync(
            $"{_cfg.EffectiveUrl.TrimEnd('/')}/functions/v1/wizenet", """{"action":"relay_config"}""", ct)
            .ConfigureAwait(false);
        using JsonDocument doc = JsonDocument.Parse(body);
        JsonElement root = doc.RootElement;
        // ⚠️ Trim — ונמדד, לא נוחות (בדיקה חיה, 15/10/2026): הסוד WIZENET_TOKEN נשמר עם שורה חדשה בסופו. Node ו-Deno
        // מנקים כותרות כאלה בשקט, ולכן זה עבד מפונקציית ה-Edge. ‏.NET שולח את השורה החדשה כמות שהיא: היא סוגרת את
        // הכותרות באמצע, Content-Length נופל לגוף, וויזנט ענו 411 Length Required על כל פנייה.
        string token = (root.TryGetProperty("token", out var t) ? t.GetString() ?? "" : "").Trim();
        string @base = (root.TryGetProperty("base", out var b) ? b.GetString() ?? "" : "").Trim();
        if (token.Length == 0 || @base.Length == 0)
            throw new RelayException(0, "פונקציית ה-Edge לא מסרה טוקן או כתובת");
        // תו בקרה שנשאר באמצע — אין דרך לשלוח אותו בכותרת בלי לשבור את הבקשה. אומרים, ולא שולחים.
        if (token.Any(char.IsControl))
            throw new RelayException(0, "הטוקן של ויזנט מכיל תו בקרה (שורה חדשה?) — לתקן את הסוד WIZENET_TOKEN");
        // ⚠️ רק https: הטוקן נוסע בכותרת, וכתובת http הייתה שולחת אותו גלוי ברשת של האתר
        if (!Uri.TryCreate(@base, UriKind.Absolute, out Uri? baseUri) || baseUri.Scheme != Uri.UriSchemeHttps)
            throw new RelayException(0, "כתובת ויזנט אינה https");
        var vars = new Dictionary<string, string>(StringComparer.Ordinal);
        if (root.TryGetProperty("vars", out var v) && v.ValueKind == JsonValueKind.Object)
            foreach (JsonProperty p in v.EnumerateObject())
                if (p.Value.ValueKind == JsonValueKind.String) vars[p.Name] = (p.Value.GetString() ?? "").Trim();
        return new RelayConfig(token, @base, vars);
    }

    /// <summary>
    /// לקיחת הבקשה הבאה. <c>null</c> — אין. כל קריאה היא גם סימן החיים של הממסר (<c>wizenet_relays.polled_at</c>).
    /// </summary>
    public async Task<RelayRequest?> ClaimAsync(bool socketOk, string? version, CancellationToken ct)
    {
        string args = JsonSerializer.Serialize(new { p_socket = socketOk, p_version = version });
        string body = await RpcAsync("wizenet_claim", args, ct).ConfigureAwait(false);
        using JsonDocument doc = JsonDocument.Parse(body);
        JsonElement root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        return new RelayRequest(
            root.GetProperty("id").GetInt64(),
            root.GetProperty("attempt").GetInt32(),
            root.GetProperty("calls").Clone());
    }

    /// <summary>
    /// החזרת התשובה של ויזנט, כפי שהיא. <paramref name="resultsJson"/> — מערך JSON (ראו <see cref="WizenetForwarder"/>).
    /// ⚠️ המסד הוא שמחליט אם הצליח; כאן רק "האם התשובה התקבלה" — false אם ממסר אחר כבר לקח את הבקשה.
    /// </summary>
    public async Task<bool> CompleteAsync(long id, int attempt, string resultsJson, CancellationToken ct)
    {
        // ⚠️ p_results כ-JSON גולמי ולא כמחרוזת: מחרוזת הייתה מגיעה למסד כ-jsonb מסוג string, וכל תשובה
        // הייתה נקראת "הממסר לא החזיר תשובה".
        string args = $$"""{"p_id":{{id}},"p_attempt":{{attempt}},"p_results":{{resultsJson}}}""";
        string body = await RpcAsync("wizenet_complete", args, ct).ConfigureAwait(false);
        using JsonDocument doc = JsonDocument.Parse(body);
        return doc.RootElement.ValueKind == JsonValueKind.Object &&
               doc.RootElement.TryGetProperty("accepted", out var a) && a.ValueKind == JsonValueKind.True;
    }

    private Task<string> RpcAsync(string fn, string args, CancellationToken ct) =>
        SendAsync($"{_cfg.EffectiveUrl.TrimEnd('/')}/rest/v1/rpc/{fn}", args, ct);

    private async Task<string> SendAsync(string url, string json, CancellationToken ct)
    {
        await EnsureTokenAsync(ct).ConfigureAwait(false);
        (HttpStatusCode code, string body) = await PostAsync(url, json, ct).ConfigureAwait(false);

        // ⚠️ 401 אחד ⇒ מתחברים מחדש ומנסים פעם אחת — אותו טיפול כמו ב-SupabaseWriter (אסימון שפג מוקדם מהצפוי)
        if (code == HttpStatusCode.Unauthorized)
        {
            _token = null;
            _expiresAt = null;
            await EnsureTokenAsync(ct).ConfigureAwait(false);
            (code, body) = await PostAsync(url, json, ct).ConfigureAwait(false);
        }

        if ((int)code is < 200 or > 299) throw new RelayException((int)code, Trim(body));
        return body;
    }

    private async Task<(HttpStatusCode, string)> PostAsync(string url, string json, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.TryAddWithoutValidation("apikey", _cfg.EffectiveAnonKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        using HttpResponseMessage res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        return (res.StatusCode, await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
    }

    private async Task EnsureTokenAsync(CancellationToken ct)
    {
        if (!TokenPolicy.ShouldRefresh(_token, _expiresAt, _now())) return;

        using var req = new HttpRequestMessage(HttpMethod.Post,
            $"{_cfg.EffectiveUrl.TrimEnd('/')}/auth/v1/token?grant_type=password");
        req.Headers.TryAddWithoutValidation("apikey", _cfg.EffectiveAnonKey);
        req.Content = new StringContent(
            JsonSerializer.Serialize(new { email = _cfg.EffectiveEmail, password = _cfg.Password }),
            Encoding.UTF8, "application/json");
        using HttpResponseMessage res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        string body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        // ⚠️ הסיסמה בגוף הבקשה, לא בתשובה — ולכן חיתוך התשובה לחריגה בטוח. אל תוסיפו כאן את req.Content.
        if (!res.IsSuccessStatusCode) throw new RelayException((int)res.StatusCode, "התחברות נכשלה: " + Trim(body));

        using JsonDocument doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("access_token", out var tok) || tok.GetString() is not { Length: > 0 } token)
            throw new RelayException((int)res.StatusCode, "אין access_token בתשובה");
        _expiresAt = doc.RootElement.TryGetProperty("expires_in", out var exp) && exp.TryGetInt32(out int seconds)
            ? TokenPolicy.ExpiryFrom(seconds, _now())
            : null;
        _token = token;
    }

    private static string Trim(string s) => s.Length <= 300 ? s : s[..300] + "…";
}
