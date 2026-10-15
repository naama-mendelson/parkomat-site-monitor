using System.Reflection;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Wizenet;

namespace Parkomat.Agent.Service;

/// <summary>
/// הממסר לוויזנט, כשירות נפרד ליד ה-<see cref="Worker"/> (15/10/2026). ראו <see cref="WizenetRelayLoop"/>.
///
/// <para>
/// ⚠️ <b>שירות נפרד ולא שלב בלולאת ה-Worker, ובכוונה.</b> הלולאה של ה-Worker היא קריאת הבקר והדיווח, והשומר
/// ב-Tray הורג את הסוכן כשהיא נתקעת 30 שניות (<c>alive</c>). פנייה לוויזנט לוקחת עד 15 שניות, ושתיים — 30. בתוך
/// ה-Worker זה היה מסכן את האתר עצמו; כאן זה רץ במקביל, ואינו נוגע ב-<c>alive</c>.
/// </para>
///
/// <para>
/// ⚠️ <b>אף חריגה אינה יוצאת מכאן.</b> מאז .NET 6, חריגה שיוצאת מ-<see cref="BackgroundService.ExecuteAsync"/>
/// עוצרת את ה-Host כולו (BackgroundServiceExceptionBehavior.StopHost) — כלומר גם את קריאת הבקר. ולכן הכול בתוך
/// try, והשורה הראשונה היא await: חריגה לפני ה-await הראשון הייתה יוצאת כבר מ-StartAsync, והסוכן לא היה עולה בכלל.
/// </para>
/// </summary>
public sealed class WizenetRelayService : BackgroundService
{
    // ⚠️ אחרי ה-Worker: הוא זה שמחיל את סימון האיפוס של המתקין (LoadAtStartup). כאן רק קוראים (Load).
    private static readonly TimeSpan StartDelay = TimeSpan.FromSeconds(20);

    private readonly ILogger<WizenetRelayService> _logger;

    public WizenetRelayService(ILogger<WizenetRelayService> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartDelay, stoppingToken).ConfigureAwait(false);

            SiteConfig config = ConfigStore.Load();
            if (!config.Supabase.Enabled)
            {
                // אתר בלי סיסמה אינו מדווח ל-Supabase בכלל — ממילא אינו יכול להיות ממסר
                _logger.LogInformation("Wizenet relay: off — no Supabase password");
                return;
            }

            string? version = typeof(WizenetRelayService).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
                .InformationalVersion.Split('+')[0];

            using var supabaseHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            using var wizenetHttp = WizenetForwarder.CreateHttpClient();
            var api = new RelayApi(config.Supabase, supabaseHttp);
            Uri socket = RealtimeDoorbell.SocketUri(config.Supabase);

            var loop = new WizenetRelayLoop(api, new WizenetForwarder(wizenetHttp),
                (ring, token) => new RealtimeDoorbell(socket, () => new ClientWebSocketConnection(), token, ring, Log),
                version, Log);
            await loop.RunAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // כיבוי מסודר
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Wizenet relay stopped — the agent keeps reporting without it");
        }
    }

    private void Log(bool warning, string message)
    {
        if (warning) _logger.LogWarning("{Message}", message);
        else _logger.LogInformation("{Message}", message);
    }
}
