using System.Collections.Concurrent;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Wizenet;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הממסר לוויזנט מול הרכיבים <b>האמיתיים</b> (15/10/2026): Supabase, Realtime, פונקציית ה-Edge, וויזנט עצמם.
///
/// <para>
/// ⚠️ <b>מה שאף בדיקה אחרת לא מכסה.</b> <c>WizenetRelayTests</c> עובד מול handler מזויף וחיבור WebSocket מזויף —
/// כלומר הפרוטוקול נבדק מול מה שכתבנו בעצמנו. כאן: ההצטרפות ל-Realtime האמיתי, ההרשאה של סוכן לקרוא את
/// <c>events</c> דרך Realtime, הטוקן מפונקציית ה-Edge הפרוסה, ופנייה לוויזנט מישראל.
/// </para>
///
/// <para>
/// ⚠️ <b>השער (<c>master/tools/check-relay-live.js</c>) הוא הסמכות</b>, כמו ב-<c>SupabaseLiveTests</c>: הוא מקים אתר
/// וסוכן סינתטיים ושורת ממסר, מריץ את הבדיקה הזו, שולח בקשות לתור, ושואל את המסד מה קרה להן. כאן רק מריצים את
/// הלולאה עד שהשער מניח את קובץ העצירה, ובודקים שהיא לא נפלה ושהפעמון התחבר.
/// </para>
/// </summary>
public class WizenetRelayLiveTests
{
    private const string Prefix = "PARKOMAT_RELAY_";
    private static string? Env(string name) => Environment.GetEnvironmentVariable(Prefix + name);
    private bool _swapped;

    [Fact]
    public async Task RelayRunsAgainstRealSupabase()
    {
        string?[] all = [Env("URL"), Env("KEY"), Env("EMAIL"), Env("PASSWORD"), Env("STOP"), Env("LOG")];
        if (all.All(string.IsNullOrWhiteSpace)) return;   // אין משתנים — הבדיקה אינה רצה, וזו החלטה של הקורא
        Assert.All(all, v => Assert.False(string.IsNullOrWhiteSpace(v),
            "הוגדרו רק חלק ממשתני PARKOMAT_RELAY_* — סביבה חלקית אינה דילוג"));

        var cfg = new SupabaseConfig { Url = all[0]!, AnonKey = all[1]!, Email = all[2]!, Password = all[3]! };
        Assert.True(cfg.Enabled);
        string stopFile = all[4]!, logFile = all[5]!;

        var lines = new ConcurrentQueue<string>();
        void Log(bool warning, string message)
        {
            string line = $"{DateTime.UtcNow:HH:mm:ss.fff} {(warning ? "WARN" : "INFO")} {message}";
            lines.Enqueue(line);
            File.AppendAllText(logFile, line + Environment.NewLine);
        }

        // ⚠️ בדיוק מה ש-WizenetRelayService בונה — אותם רכיבים, אותם קצבים
        using var supabaseHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        using var wizenetHttp = WizenetForwarder.CreateHttpClient();
        var api = new RelayApi(cfg, supabaseHttp);
        Uri socket = RealtimeDoorbell.SocketUri(cfg);

        // ⚠️ חידוש ההזדהות על החיבור החי. בשטח זה קורה פעם בשעה (האסימון של Supabase חי שעה); כאן — אסימון של
        // התחברות שנייה, כמה שניות אחרי שהפעמון התחבר. השער בודק שהחיבור לא נפל ושהפעמון ממשיך לצלצל אחריו.
        var api2 = new RelayApi(cfg, supabaseHttp);
        string? Token() => Volatile.Read(ref _swapped) ? api2.CurrentToken : api.CurrentToken;

        var loop = new WizenetRelayLoop(api, new WizenetForwarder(wizenetHttp),
            (ring, _) => new RealtimeDoorbell(socket, () => new ClientWebSocketConnection(), Token, ring, Log),
            "1.0.60-live", Log);

        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(5));   // רשת ביטחון: השער אמור לעצור הרבה לפני
        Task run = loop.RunAsync(cts.Token);
        _ = Task.Run(async () =>
        {
            while (!lines.Any(l => l.Contains("realtime subscribed")) && !cts.IsCancellationRequested) await Task.Delay(200);
            await Task.Delay(5000);
            await api2.IsRelayAsync(cts.Token);          // התחברות שנייה — אסימון אחר
            Volatile.Write(ref _swapped, true);
            Log(false, "live test: token swapped to a second session");
        });
        while (!File.Exists(stopFile) && !cts.IsCancellationRequested && !run.IsCompleted)
            await Task.Delay(200);
        cts.Cancel();
        await run;   // ⚠️ אם הלולאה זרקה — כאן זה נכשל

        Assert.True(run.IsCompletedSuccessfully);
        Assert.Contains(lines, l => l.Contains("Wizenet relay: ON"));
        Assert.Contains(lines, l => l.Contains("realtime subscribed"));
        // ⚠️ אחרי החלפת האסימון — החיבור לא נפל (Supabase קיבל את access_token)
        Assert.DoesNotContain(lines, l => l.Contains("realtime down") || l.Contains("closed by the server"));
    }
}
