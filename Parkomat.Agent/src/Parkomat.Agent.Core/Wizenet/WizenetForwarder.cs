using System.Text;
using System.Text.Encodings.Web;
using System.Text.Unicode;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Parkomat.Agent.Core.Wizenet;

/// <summary>
/// שולח לוויזנט בדיוק את מה שבבקשה, ומחזיר את התשובה כפי שהיא (15/10/2026).
///
/// <para>
/// ⚠️ <b>טיפש בכוונה.</b> אין כאן "קריאה", "סטטוס" או "הצלחה": מה לשלוח — המסד בנה (<c>wizenet_requests.calls</c>),
/// ומה נחשב הצלחה ("update successfully", פענוח רשימה) — המסד מחליט כשהתשובה חוזרת. כך שינוי בצד של ויזנט הוא
/// שינוי בקובץ SQL, ולא התקנה מחדש במחשבים באתרים.
/// </para>
///
/// <para>
/// ⚠️ <b>חוץ מרשימת היתר אחת</b> (<see cref="AllowedFuncs"/>): הממסר מחזיק את הטוקן של ויזנט, ומי שמשתלט על המסד
/// היה יכול אחרת לגרום לו לקרוא לכל פונקציה של ויזנט — מחיקה, למשל. פונקציה חדשה = גרסה חדשה בשלושה מחשבים,
/// וזה המחיר הנכון.
/// </para>
/// </summary>
public sealed class WizenetForwarder
{
    /// <summary>הפונקציות של ויזנט שמותר לשלוח. ⚠️ כל אחת מהן נבנית ב-db/wizenet-relay.postgres.sql.</summary>
    public static readonly IReadOnlySet<string> AllowedFuncs = new HashSet<string>(StringComparer.Ordinal)
    {
        "wizeApp_updateCallStatus",
        "wizeApp_updateCallType",
        "wizeApp_getBIReportQuery",
    };

    /// <summary>
    /// ⚠️ <b>ולא רק השם — גם צורת הגוף</b> (סקירה, 15/10/2026). <c>wizeApp_getBIReportQuery</c> מריץ כל דוח שמזהה השאילתה
    /// שלו מצביע עליו: עם QRYID שנלקח מהמסד, מי שמשתלט על המסד היה מקבל דרך הממסר כל דוח של ויזנט. לכן הגוף שלו חייב
    /// להיות בדיוק אחד משני המקומות-השמורים, ועדכון — בדיוק מספר קריאה ומספר ערך. מחזיר את הסיבה, או null.
    /// </summary>
    public static string? BodyProblem(string func, JsonElement body)
    {
        if (!AllowedFuncs.Contains(func)) return $"פונקציה שאינה ברשימת ההיתר של הממסר: {func}";
        if (body.ValueKind != JsonValueKind.Object) return $"גוף שאינו אובייקט ל-{func}";
        List<JsonProperty> props = body.EnumerateObject().ToList();
        string? Str(string name) => props.Count(p => p.Name == name) == 1 &&
                                    props.First(p => p.Name == name).Value is { ValueKind: JsonValueKind.String } v
            ? v.GetString() : null;
        static bool Digits(string? s) => s is { Length: > 0 and <= 12 } && s.All(char.IsAsciiDigit);
        bool ok = func switch
        {
            "wizeApp_updateCallStatus" => props.Count == 2 && Digits(Str("callid")) && Digits(Str("callstatusid")),
            "wizeApp_updateCallType" => props.Count == 2 && Digits(Str("callid")) && Digits(Str("calltypeid")),
            "wizeApp_getBIReportQuery" => props.Count == 1 && Str("QRYID") is "{{qry_status}}" or "{{qry_type}}",
            _ => false,
        };
        return ok ? null : $"גוף שאינו בצורה הצפויה ל-{func}";
    }

    /// <summary>תשובה ארוכה מזה נחתכת: רשימת סטטוסים היא קילובייטים, ומגה של HTML אינו תשובה.</summary>
    public const int MaxText = 200_000;

    /// <summary>
    /// ⚠️ עברית כמות שהיא, ולא כ-escape של \u: ברירת המחדל של .NET מבריחה כל תו שאינו ASCII — תשובה עם שמות של
    /// סטטוסים הייתה מגיעה למסד פי שישה, ושורת האבחון (response) הייתה בלתי קריאה. אותו כלל כמו BatchPayload
    /// (UnicodeRanges.All ולא UnsafeRelaxed — &lt; &gt; &amp; נשארים מוברחים).
    /// </summary>
    public static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };

    private static readonly Regex Placeholder = new(@"^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$", RegexOptions.CultureInvariant);

    private readonly HttpClient _http;

    public WizenetForwarder(HttpClient http) => _http = http ?? throw new ArgumentNullException(nameof(http));

    /// <summary>
    /// הלקוח לוויזנט. ⚠️ <b>בלי מעקב אחרי הפניות</b>: ויזנט עונים לבקשה בלי טוקן תקף בהפניה לדף ההתחברות (302,
    /// נמדד 15/10/2026). מעקב היה מחזיר את דף ה-HTML כ-200, והמסד היה קורא "ויזנט החזירו שגיאה: &lt;html&gt;…"
    /// במקום "הטוקן נדחה". 15 שניות — כמו פונקציית ה-Edge שהייתה לפני.
    /// </summary>
    public static HttpClient CreateHttpClient() => new(CreateHandler()) { Timeout = TimeSpan.FromSeconds(15) };

    public static SocketsHttpHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
    };

    /// <summary>
    /// שולח את הפניות לפי הסדר ומחזיר מערך JSON — תשובה לכל פנייה: <c>{"status":200,"text":"..."}</c>, או
    /// <c>{"error":"timeout"|"network"|"config","detail":"..."}</c>.
    /// ⚠️ עוצר בכשל הראשון (גם תשובה שאינה 2xx): רענון רשימות הוא שתי פניות, והמסד ממילא לא ישמור אף אחת אם
    /// הראשונה נכשלה — אין טעם לשלוח את השנייה עם טוקן שכבר נדחה.
    /// </summary>
    public async Task<string> ExecuteAsync(JsonElement calls, RelayConfig cfg, CancellationToken ct)
    {
        var results = new JsonArray();
        if (calls.ValueKind != JsonValueKind.Array) return results.ToJsonString(Json);
        // ⚠️ TryAddWithoutValidation אינו בודק: שורה חדשה בטוקן שוברת את הבקשה באמצע הכותרות (נמדד: 411 מוויזנט על
        // כל פנייה, 15/10/2026). RelayApi כבר מנקה; כאן — הגנה שנייה, מכל מקור שהוא.
        if (cfg.Token.Any(char.IsControl) || cfg.Base.Any(char.IsControl))
        {
            results.Add(Error("config", "הטוקן או הכתובת של ויזנט מכילים תו בקרה (שורה חדשה?)"));
            return results.ToJsonString(Json);
        }

        foreach (JsonElement call in calls.EnumerateArray())
        {
            string func = call.TryGetProperty("func", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString()! : "";
            JsonElement raw = call.TryGetProperty("body", out var b) ? b : default;
            if (BodyProblem(func, raw) is string problem)
            {
                results.Add(Error("config", problem));
                break;
            }

            JsonNode? body = JsonNode.Parse(raw.GetRawText());
            string? missing = Fill(body, cfg.Vars);
            if (missing is not null)
            {
                results.Add(Error("config", $"אין ערך ל-{missing} (סודות פונקציית ה-Edge)"));
                break;
            }

            JsonObject result = await SendOneAsync(func, body?.ToJsonString(Json) ?? "{}", cfg, ct).ConfigureAwait(false);
            results.Add(result);
            if (result["status"] is not JsonValue sv || sv.GetValue<int>() is < 200 or > 299) break;
        }
        return results.ToJsonString(Json);
    }

    private async Task<JsonObject> SendOneAsync(string func, string json, RelayConfig cfg, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.Base}?func={Uri.EscapeDataString(func)}");
            // ⚠️ הטוקן כמות שהוא, בלי "Bearer" — כך ויזנט מגדירים אותו, וכך פונקציית ה-Edge שלחה (13/10/2026)
            req.Headers.TryAddWithoutValidation("Authorization", cfg.Token);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
            using HttpResponseMessage res = await _http.SendAsync(req, ct).ConfigureAwait(false);
            string text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (text.Length > MaxText) text = text[..MaxText];
            return new JsonObject { ["status"] = (int)res.StatusCode, ["text"] = text };
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // HttpClient.Timeout מגיע כ-TaskCanceledException — כשהסוכן עצמו אינו בכיבוי, זה קצב-זמן מול ויזנט
            return Error("timeout", "ויזנט לא ענו תוך 15 שניות");
        }
        catch (HttpRequestException ex)
        {
            return Error("network", ex.Message);
        }
    }

    /// <summary>
    /// ממלא מקומות-שמורים (מחרוזת שהיא כולה <c>{{name}}</c>) מהתצורה. מחזיר את שם הראשון שאין לו ערך, או null.
    /// ⚠️ ערך ריק = אין ערך: מזהה שאילתה ריק היה נשלח לוויזנט ומחזיר שגיאה שאיש לא יבין ממנה מה חסר.
    /// </summary>
    public static string? Fill(JsonNode? node, IReadOnlyDictionary<string, string> vars)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (string key in o.Select(p => p.Key).ToList())
                {
                    (string? miss, JsonNode? value) = Resolve(o[key], vars);
                    if (miss is not null) return miss;
                    if (value is not null) o[key] = value;
                }
                return null;
            case JsonArray a:
                for (int i = 0; i < a.Count; i++)
                {
                    (string? miss, JsonNode? value) = Resolve(a[i], vars);
                    if (miss is not null) return miss;
                    if (value is not null) a[i] = value;
                }
                return null;
            default:
                return null;
        }
    }

    // מקום-שמור → (null, הערך); מקום-שמור בלי ערך → (השם, null); כל השאר — ממלאים בתוכו, ולא מחליפים אותו
    private static (string? Missing, JsonNode? Value) Resolve(JsonNode? child, IReadOnlyDictionary<string, string> vars)
    {
        if (child is JsonValue v && v.TryGetValue(out string? s) && Placeholder.Match(s) is { Success: true } m)
        {
            string name = m.Groups[1].Value;
            return vars.TryGetValue(name, out string? val) && !string.IsNullOrWhiteSpace(val)
                ? (null, JsonValue.Create(val))
                : (name, null);
        }
        return (Fill(child, vars), null);
    }

    private static JsonObject Error(string kind, string detail) => new() { ["error"] = kind, ["detail"] = detail };
}
