using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Core.Supabase;

/// <summary>תוצאת שליחה אחת. אין חריגות במסלול הרגיל.</summary>
public sealed record WriteResult(bool Ok, int Status, string? Error)
{
    public static WriteResult Success(int status) => new(true, status, null);
    public static WriteResult Failure(int status, string error) => new(false, status, error);
}

/// <summary>
/// שולח אצוות ל-<c>public.ingest_batch</c> ומחזיק אסימון תקף.
///
/// <para>
/// ⚠️ <b>מחזיר תוצאה ולא זורק.</b> הקורא הוא לולאת הסוכן, והיא חייבת
/// להמשיך גם כשהרשת נופלת — ההודעה נשארת בתור על הדיסק ותישלח בסבב הבא.
/// חריגה שמטפסת מכאן הייתה מפילה את הסבב כולו, כולל את השידור ל-MQTT.
/// </para>
///
/// <para>
/// ⚠️ <b>אין ניסיון חוזר בפנים, ובכוונה.</b> התור הוא מנגנון הניסיון החוזר,
/// והוא עמיד לנפילת חשמל. ניסיון חוזר כאן היה מכפיל אותו, מאריך את הסבב,
/// ומסכן את סף התקיעה של ה-watchdog — שהורג את הסוכן בזמן שהוא עובד.
/// </para>
///
/// <para>
/// ⚠️ <b>מתחבר מחדש במקום להשתמש ב-refresh_token.</b> לסוכן יש את הסיסמה
/// בכל מקרה, ולכן אסימון רענון אינו מוסיף ביטחון — הוא רק מוסיף מצב שמסתובב
/// (Supabase מסובב אותם), ומצב שמסתובב הוא מצב שאפשר לאבד. התחברות מחדש
/// היא קריאה אחת בשעה.
/// </para>
/// </summary>
public sealed class SupabaseWriter
{
    private readonly SupabaseConfig _cfg;
    private readonly HttpClient _http;
    private readonly Func<DateTimeOffset> _now;

    private string? _token;
    private DateTimeOffset? _expiresAt;

    public SupabaseWriter(SupabaseConfig cfg, HttpClient http, Func<DateTimeOffset>? now = null)
    {
        _cfg = cfg ?? throw new ArgumentNullException(nameof(cfg));
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>האם יש כרגע אסימון שנחשב תקף. לאבחון ולבדיקות.</summary>
    public bool HasValidToken => !TokenPolicy.ShouldRefresh(_token, _expiresAt, _now());

    /// <summary>
    /// שולח אצווה. מתחבר מחדש קודם אם צריך.
    ///
    /// ⚠️ אצווה ריקה אינה נשלחת: בקשת רשת שאין בה מה לכתוב היא עלות בלי
    /// תמורה, ובאתר שקט זה כל 30 שניות, כל היום.
    /// </summary>
    public async Task<WriteResult> SendAsync(IReadOnlyList<BatchItem> items, CancellationToken ct)
    {
        if (items.Count == 0) return WriteResult.Success(0);
        if (!_cfg.Enabled) return WriteResult.Failure(0, "הכתיבה הישירה כבויה");

        if (TokenPolicy.ShouldRefresh(_token, _expiresAt, _now()))
        {
            WriteResult auth = await SignInAsync(ct).ConfigureAwait(false);
            if (!auth.Ok) return auth;
        }

        WriteResult sent = await PostBatchAsync(items, ct).ConfigureAwait(false);

        // ⚠️ 401 אחד ⇒ מתחברים מחדש ומנסים **פעם אחת**. זה אינו "ניסיון
        // חוזר" אלא טיפול בסיבה ידועה: אסימון שפג מוקדם מהצפוי (שעון סוטה,
        // או ביטול בצד השרת). בלי זה כל הודעה עד הרענון הבא נכשלת.
        if (sent.Status == (int)HttpStatusCode.Unauthorized)
        {
            _token = null;
            _expiresAt = null;
            WriteResult auth = await SignInAsync(ct).ConfigureAwait(false);
            if (!auth.Ok) return auth;
            sent = await PostBatchAsync(items, ct).ConfigureAwait(false);
        }

        return sent;
    }

    private async Task<WriteResult> SignInAsync(CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post,
                $"{_cfg.Url.TrimEnd('/')}/auth/v1/token?grant_type=password");
            req.Headers.TryAddWithoutValidation("apikey", _cfg.AnonKey);
            req.Content = new StringContent(
                JsonSerializer.Serialize(new { email = _cfg.Email, password = _cfg.Password }),
                Encoding.UTF8, "application/json");

            using HttpResponseMessage res = await _http.SendAsync(req, ct).ConfigureAwait(false);
            string body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (!res.IsSuccessStatusCode)
                return WriteResult.Failure((int)res.StatusCode, Trim(body));

            using JsonDocument doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("access_token", out var tok) ||
                tok.GetString() is not { Length: > 0 } token)
                return WriteResult.Failure((int)res.StatusCode, "אין access_token בתשובה");

            _token = token;
            _expiresAt = doc.RootElement.TryGetProperty("expires_in", out var exp) &&
                         exp.TryGetInt32(out int seconds)
                ? TokenPolicy.ExpiryFrom(seconds, _now())
                : null;

            return WriteResult.Success((int)res.StatusCode);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;   // כיבוי מסודר אינו כשל
        }
        catch (Exception ex)
        {
            return WriteResult.Failure(0, ex.Message);
        }
    }

    private async Task<WriteResult> PostBatchAsync(IReadOnlyList<BatchItem> items, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post,
                $"{_cfg.Url.TrimEnd('/')}/rest/v1/rpc/ingest_batch");
            req.Headers.TryAddWithoutValidation("apikey", _cfg.AnonKey);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            req.Content = new StringContent(BatchPayload.Serialize(items), Encoding.UTF8, "application/json");

            using HttpResponseMessage res = await _http.SendAsync(req, ct).ConfigureAwait(false);
            string body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            return res.IsSuccessStatusCode
                ? WriteResult.Success((int)res.StatusCode)
                : WriteResult.Failure((int)res.StatusCode, Trim(body));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return WriteResult.Failure(0, ex.Message);
        }
    }

    // ⚠️ גוף התשובה נחתך לפני שהוא נכנס ללוג. הודעת שגיאה של PostgREST
    // יכולה להיות ארוכה מאוד, ולוג שמתמלא בה הוא לוג שאיש לא קורא.
    // ⚠️ והסיסמה לעולם אינה נכנסת: היא בגוף **הבקשה**, לא בתשובה, ולכן
    // חיתוך התשובה בטוח — אבל אל תוסיפו כאן רישום של req.Content.
    private static string Trim(string s) =>
        s.Length <= 300 ? s : s[..300] + "…";
}
