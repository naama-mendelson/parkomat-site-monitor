using System.Text.Json;

namespace Parkomat.Agent.Core.Wizenet;

/// <summary>הקצבים של הלולאה. ⚠️ ברירות המחדל הן הייצור; הבדיקות מקצרות אותן.</summary>
public sealed record RelayTimings(
    TimeSpan Poll,            // בדיקה עצמית כשאין צלצול — גם סימן החיים של הממסר (המסד: חי = שאל ב-3 דקות)
    TimeSpan DormantRecheck,  // אתר שאינו ממסר — מתי לשאול שוב
    TimeSpan ActiveRecheck,   // ממסר — מתי לוודא שהוא עדיין ברשימה
    TimeSpan ErrorBackoff)    // אחרי כשל (אין רשת) — לפני הניסיון הבא
{
    public static RelayTimings Production { get; } = new(
        TimeSpan.FromSeconds(60), TimeSpan.FromMinutes(30), TimeSpan.FromMinutes(30), TimeSpan.FromSeconds(30));
}

/// <summary>
/// הממסר לוויזנט באתר (15/10/2026): לוקח בקשות מהתור ב-Supabase, שולח לוויזנט מכאן — מישראל — ומחזיר את התשובה.
///
/// <para>
/// ⚠️ <b>רדום כברירת מחדל.</b> כל אתר עם הגרסה הזו מריץ את הלולאה, אבל רק אתר שמופיע ב-<c>wizenet_relays</c>
/// (לפי המסד, <c>wizenet_relay_me</c>) פותח WebSocket ולוקח בקשות. אתר אחר שואל פעם ב-30 דקות ותו לא. אין מה
/// להגדיר באתר — ההפעלה וההסרה הן שורה במסד.
/// </para>
///
/// <para>
/// ⚠️ <b>לעולם אינו זורק.</b> הלולאה רצה לצד קריאת הבקר והדיווח של האתר, באותו תהליך. חריגה שהייתה יוצאת מכאן
/// הייתה מפילה את ה-Host כולו (BackgroundService) — כלומר תקלה בתכונה משנית הייתה משתיקה אתר. כל כשל נרשם,
/// ממתינים, ומנסים שוב.
/// </para>
/// </summary>
public sealed class WizenetRelayLoop
{
    private readonly RelayApi _api;
    private readonly WizenetForwarder _fwd;
    private readonly Func<Action, Func<string?>, IDoorbell> _doorbell;
    private readonly string? _version;
    private readonly RelayLog _log;
    private readonly RelayTimings _t;
    private readonly Func<DateTimeOffset> _now;
    private readonly SemaphoreSlim _ring = new(0, 1);
    private RelayConfig? _config;
    private int _failures;

    public WizenetRelayLoop(RelayApi api, WizenetForwarder fwd, Func<Action, Func<string?>, IDoorbell> doorbell,
                            string? version, RelayLog log, RelayTimings? timings = null, Func<DateTimeOffset>? now = null)
    {
        _api = api;
        _fwd = fwd;
        _doorbell = doorbell;
        _version = version;
        _log = log;
        _t = timings ?? RelayTimings.Production;
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>הצלצול: מעיר את הלולאה מיד. ⚠️ צלצולים שנצברו בזמן עבודה מתאחדים לאחד — הלולאה ממילא מרוקנת את התור.</summary>
    public void Ring()
    {
        try { if (_ring.CurrentCount == 0) _ring.Release(); }
        catch (SemaphoreFullException) { /* כבר מצלצל */ }
    }

    public async Task RunAsync(CancellationToken ct)
    {
        bool saidNotRelay = false;
        while (!ct.IsCancellationRequested)
        {
            bool relay;
            try
            {
                relay = await _api.IsRelayAsync(ct).ConfigureAwait(false);
                _failures = 0;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                Failed("checking whether this site is a relay", ex);
                // ⚠️ השהיה שגדלה (סקירה, 15/10/2026): הלולאה רצה בכל 78 האתרים. בקצב קבוע של 30 שנ׳, תקלה אחת בצד שלנו
                // (גרסה שהותקנה לפני ה-SQL, פונקציה ששמה השתנה) הייתה כ-225 אלף בקשות ביום — ובאתר שהזהות שלו שבורה,
                // התחברות בסיסמה כל 30 שנ׳.
                if (!await DelayAsync(Backoff(_failures), ct).ConfigureAwait(false)) return;
                continue;
            }

            if (!relay)
            {
                if (!saidNotRelay) _log(false, "Wizenet relay: this site is not a relay — checking again every 30 minutes");
                saidNotRelay = true;
                if (!await DelayAsync(_t.DormantRecheck, ct).ConfigureAwait(false)) return;
                continue;
            }

            saidNotRelay = false;
            _log(false, "Wizenet relay: ON — this site sends service-call changes to Wizenet");
            await ActiveAsync(ct).ConfigureAwait(false);
            _config = null;   // ⚠️ ממסר שהוצא מהרשימה אינו שומר את הטוקן בזיכרון
            // ⚠️ ולא חוזרים מיד לשאול (סקירה, 15/10/2026): 403 בלקיחה בזמן ש-wizenet_relay_me עדיין עונה true (הרשאה
            // שחסרה אחרי החלה שגויה) הייתה לולאה בלי הפסקה — התחברות, פעמון, שורת אזהרה, חזרה — פעמים רבות בשנייה.
            if (!await DelayAsync(_t.DormantRecheck, ct).ConfigureAwait(false)) return;
        }
    }

    // 30 שנ׳, 60, 120… עד הבדיקה הרדומה (30 דק׳)
    private TimeSpan Backoff(int failures)
    {
        double ms = _t.ErrorBackoff.TotalMilliseconds * Math.Pow(2, Math.Min(Math.Max(failures, 1), 20) - 1);
        return TimeSpan.FromMilliseconds(Math.Min(ms, _t.DormantRecheck.TotalMilliseconds));
    }

    private async Task ActiveAsync(CancellationToken ct)
    {
        using var active = CancellationTokenSource.CreateLinkedTokenSource(ct);
        IDoorbell bell = _doorbell(Ring, () => _api.CurrentToken);
        Task bellTask = Task.Run(() => bell.RunAsync(active.Token), CancellationToken.None);
        DateTimeOffset recheckAt = _now() + _t.ActiveRecheck;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await DrainAsync(bell.Subscribed, ct).ConfigureAwait(false);
                    if (_failures > 0) _log(false, "Wizenet relay: back online");
                    _failures = 0;
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                catch (RelayException ex) when (ex.Status == 403)
                {
                    // ⚠️ המסד אומר "אינו ממסר" (42501 → 403): השורה נמחקה או הושבתה. חוזרים לשינה, בלי טוקן.
                    _log(true, "Wizenet relay: OFF — this site was removed from the relay list");
                    return;
                }
                catch (Exception ex)
                {
                    Failed("talking to Supabase", ex);
                }

                if (_now() >= recheckAt)
                {
                    recheckAt = _now() + _t.ActiveRecheck;
                    try
                    {
                        if (!await _api.IsRelayAsync(ct).ConfigureAwait(false))
                        {
                            _log(true, "Wizenet relay: OFF — this site was removed from the relay list");
                            return;
                        }
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                    catch (Exception ex) { Failed("checking whether this site is still a relay", ex); }
                }

                // ⚠️ ממסר פעיל — לא מעבר ל-Poll: השאלה היא גם סימן החיים שלו, ושתיקה של 3 דקות מוציאה אותו מהחשבון
                TimeSpan wait = _failures > 0 && Backoff(_failures) < _t.Poll ? Backoff(_failures) : _t.Poll;
                try { await _ring.WaitAsync(wait, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
            }
        }
        finally
        {
            active.Cancel();
            try { await bellTask.ConfigureAwait(false); } catch { /* הפעמון נסגר עם הלולאה */ }
        }
    }

    // לוקחים עד שהתור ריק. ⚠️ כל לקיחה היא גם סימן החיים — ולכן היא קורית בכל סבב, גם בלי צלצול.
    private async Task DrainAsync(bool socketOk, CancellationToken ct)
    {
        while (true)
        {
            RelayRequest? req = await _api.ClaimAsync(socketOk, _version, ct).ConfigureAwait(false);
            if (req is null) return;

            string results;
            try
            {
                _config ??= await _api.GetConfigAsync(ct).ConfigureAwait(false);
                results = await _fwd.ExecuteAsync(req.Calls, _config, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                // ⚠️ בלי טוקן אי אפשר לשלוח — אבל עונים בכל זאת, עם הסיבה: אחרת הבקשה הייתה מחכה עד שתפוג, ומי
                // שלחץ היה מקבל "לא ידוע אם השינוי הגיע", כשבעצם ידוע שלא נשלח.
                results = JsonSerializer.Serialize(new[] { new { error = "config", detail = "לא התקבל טוקן: " + ex.Message } },
                    WizenetForwarder.Json);
            }

            // ⚠️ טוקן שנדחה (הפניה להתחברות, 401/403) — לא נשתמש בו שוב: אולי הוחלף בסודות, ונבקש מחדש בבקשה הבאה
            if (TokenRejected(results)) _config = null;

            bool accepted = await CompleteWithRetryAsync(req, results, ct).ConfigureAwait(false);
            _log(false, $"Wizenet relay: request {req.Id} (attempt {req.Attempt}) sent — {Summary(results)}"
                        + (accepted ? "" : " — answer not accepted (another relay took over)"));
        }
    }

    // ⚠️ שלושה ניסיונות: התשובה כבר קיימת (ויזנט אולי כבר שינו), ואיבוד שלה פירושו שהבקשה תילקח שוב אחרי
    // החכירה ותישלח פעם נוספת. זה אינו מזיק (אותו ערך), אבל מיותר.
    private async Task<bool> CompleteWithRetryAsync(RelayRequest req, string results, CancellationToken ct)
    {
        for (int i = 1; ; i++)
        {
            try { return await _api.CompleteAsync(req.Id, req.Attempt, results, ct).ConfigureAwait(false); }
            catch (Exception) when (i < 3 && !ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), ct).ConfigureAwait(false);
            }
        }
    }

    public static bool TokenRejected(string results)
    {
        using JsonDocument doc = JsonDocument.Parse(results);
        foreach (JsonElement r in doc.RootElement.EnumerateArray())
            if (r.TryGetProperty("status", out var s) && s.TryGetInt32(out int code) && code is >= 300 and < 400 or 401 or 403)
                return true;
        return false;
    }

    // לשורת היומן: הקודים בלבד — ⚠️ לא הטקסט (רשימה שלמה של סטטוסים), ולא הגוף ששלחנו
    public static string Summary(string results)
    {
        using JsonDocument doc = JsonDocument.Parse(results);
        return string.Join(", ", doc.RootElement.EnumerateArray().Select(r =>
            r.TryGetProperty("status", out var s) ? $"HTTP {s}" :
            r.TryGetProperty("error", out var e) ? $"{e.GetString()}" : "?"));
    }

    private void Failed(string what, Exception ex)
    {
        _failures++;
        // ⚠️ הכשל הראשון ברצף — אזהרה; השאר — מידע בלבד: אתר בלי אינטרנט היה ממלא את היומן
        _log(_failures == 1, $"Wizenet relay: failed {what} ({ex.GetType().Name}: {ex.Message})");
    }

    private static async Task<bool> DelayAsync(TimeSpan d, CancellationToken ct)
    {
        try { await Task.Delay(d, ct).ConfigureAwait(false); return true; }
        catch (OperationCanceledException) { return false; }
    }
}
