using System.Net;
using System.Text;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הכותב — עם handler מזויף, בלי רשת.
///
/// ⚠️ <b>למה זה נבדק כאן ולא רק ב-check-agent-write.</b> השער בשרת מוכיח
/// שהחוזה נכון מול Supabase אמיתי, והוא לא יכול לייצר את המקרים שחשוב
/// לבדוק: אסימון שפג באמצע, רשת שנופלת, 401 יחיד. אלה בדיוק המצבים
/// שקורים באתר בשלוש לפנות בוקר ואי אפשר לשחזר לפי דרישה.
/// </summary>
public class SupabaseWriterTests
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
        Email = "site-1@parkomat.co.il",
        Password = "pw",
    };

    private static List<BatchItem> OneItem() =>
    [
        BatchPayload.From(new StateMessage { Timestamp = 1788256800, State = SiteState.Ready }),
    ];

    private const string TokenBody = """{"access_token":"tok","expires_in":3600}""";

    [Fact]
    public async Task SignsInThenPosts()
    {
        var h = new FakeHandler(req =>
            req.RequestUri!.AbsolutePath.Contains("token")
                ? (HttpStatusCode.OK, TokenBody)
                : (HttpStatusCode.OK, "[]"));

        var w = new SupabaseWriter(Cfg(), new HttpClient(h));
        var r = await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.True(r.Ok, r.Error);
        Assert.Equal(2, h.Paths.Count);
        Assert.Contains("/auth/v1/token", h.Paths[0]);
        Assert.Equal("/rest/v1/rpc/ingest_batch", h.Paths[1]);
    }

    [Fact]
    public async Task ReusesTheTokenInsteadOfSigningInEveryTime()
    {
        // ⚠️ התחברות בכל שליחה הייתה מכפילה את מספר הבקשות ומאיצה את
        // מגבלות הקצב של GoTrue — כלומר הופכת אתר עסוק לאתר חסום.
        var h = new FakeHandler(req =>
            req.RequestUri!.AbsolutePath.Contains("token")
                ? (HttpStatusCode.OK, TokenBody)
                : (HttpStatusCode.OK, "[]"));

        var w = new SupabaseWriter(Cfg(), new HttpClient(h));
        await w.SendAsync(OneItem(), CancellationToken.None);
        await w.SendAsync(OneItem(), CancellationToken.None);
        await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.Equal(1, h.Paths.Count(p => p.Contains("token")));
        Assert.Equal(3, h.Paths.Count(p => p.Contains("ingest_batch")));
    }

    [Fact]
    public async Task RefreshesWhenTheTokenIsAboutToExpire()
    {
        // שעון מזויף שמתקדם: השליחה השנייה קורית 58 דקות אחרי הראשונה,
        // כלומר בתוך שולי הרענון של חמש דקות.
        var now = DateTimeOffset.Parse("2026-09-01T10:00:00Z");
        var h = new FakeHandler(req =>
            req.RequestUri!.AbsolutePath.Contains("token")
                ? (HttpStatusCode.OK, TokenBody)
                : (HttpStatusCode.OK, "[]"));

        var w = new SupabaseWriter(Cfg(), new HttpClient(h), () => now);
        await w.SendAsync(OneItem(), CancellationToken.None);
        now = now.AddMinutes(58);
        await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.Equal(2, h.Paths.Count(p => p.Contains("token")));
    }

    [Fact]
    public async Task SingleUnauthorizedTriggersOneReSignInAndOneRetry()
    {
        // ⚠️ **לא ניסיון חוזר כללי** — טיפול בסיבה ידועה אחת: אסימון שפג
        // מוקדם מהצפוי (שעון סוטה, ביטול בצד השרת). בלי זה כל הודעה עד
        // הרענון הבא נכשלת.
        int batchCalls = 0;
        var h = new FakeHandler(req =>
        {
            if (req.RequestUri!.AbsolutePath.Contains("token"))
                return (HttpStatusCode.OK, TokenBody);
            batchCalls++;
            return batchCalls == 1
                ? (HttpStatusCode.Unauthorized, """{"message":"JWT expired"}""")
                : (HttpStatusCode.OK, "[]");
        });

        var w = new SupabaseWriter(Cfg(), new HttpClient(h));
        var r = await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.True(r.Ok, r.Error);
        Assert.Equal(2, batchCalls);
        Assert.Equal(2, h.Paths.Count(p => p.Contains("token")));
    }

    [Fact]
    public async Task PersistentUnauthorizedGivesUpInsteadOfLooping()
    {
        // ⚠️ סיסמה שהוחלפה (‎--rotate‎) מייצרת 401 קבוע. לולאה כאן הייתה
        // תוקעת את הסבב ומפילה גם את השידור ל-MQTT.
        int batchCalls = 0;
        var h = new FakeHandler(req =>
        {
            if (req.RequestUri!.AbsolutePath.Contains("token"))
                return (HttpStatusCode.OK, TokenBody);
            batchCalls++;
            return (HttpStatusCode.Unauthorized, "nope");
        });

        var w = new SupabaseWriter(Cfg(), new HttpClient(h));
        var r = await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.False(r.Ok);
        Assert.Equal(2, batchCalls);   // המקורי + ניסיון אחד. לא יותר.
    }

    [Fact]
    public async Task NetworkFailureIsReturnedNotThrown()
    {
        // ⚠️ **זו הבדיקה שמגנה על הסבב כולו.** חריגה שמטפסת מכאן הייתה
        // מפילה את הלולאה, כולל את השידור ל-MQTT — כלומר מסלול חדש שנופל
        // היה שובר את המסלול הישן שעובד.
        var h = new ThrowingHandler();
        var w = new SupabaseWriter(Cfg(), new HttpClient(h));

        var r = await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.False(r.Ok);
        Assert.Equal(0, r.Status);
        Assert.NotNull(r.Error);
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new HttpRequestException("אין רשת");
    }

    [Fact]
    public async Task DisabledConfigNeverTouchesTheNetwork()
    {
        // ⚠️ הכיבוי חייב להיות מוחלט. סוכן עם הגדרות ריקות ששולח בקשה
        // אחת בכל סבב היה ממלא את הלוג ב-16 אתרים שאיש לא הפעיל.
        var h = new FakeHandler(_ => (HttpStatusCode.OK, "[]"));
        var w = new SupabaseWriter(new SupabaseConfig(), new HttpClient(h));

        var r = await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.False(r.Ok);
        Assert.Empty(h.Paths);
        // ⚠️ **הסיבה נבדקת, לא רק הכישלון.** בלי השורה הזו הבדיקה עברה
        // גם כשהסרתי את בדיקת Enabled: כתובת ריקה מייצרת URI יחסי,
        // HttpClient זורק, החריגה נתפסת, והתוצאה כישלון — כלומר הטענה
        // התקיימה במקרה. מוטציה שעוברת היא בדיקה שאינה בודקת.
        Assert.Contains("כבויה", r.Error);
    }

    [Fact]
    public async Task EmptyBatchIsNotSent()
    {
        // באתר שקט זו בקשה כל 30 שניות, כל היום, בלי מה לכתוב.
        var h = new FakeHandler(_ => (HttpStatusCode.OK, "[]"));
        var w = new SupabaseWriter(Cfg(), new HttpClient(h));

        var r = await w.SendAsync([], CancellationToken.None);

        Assert.True(r.Ok);
        Assert.Empty(h.Paths);
    }

    [Fact]
    public async Task BodyIsTheContractShapeAndCarriesTheToken()
    {
        var h = new FakeHandler(req =>
            req.RequestUri!.AbsolutePath.Contains("token")
                ? (HttpStatusCode.OK, TokenBody)
                : (HttpStatusCode.OK, "[]"));

        var w = new SupabaseWriter(Cfg(), new HttpClient(h));
        await w.SendAsync(OneItem(), CancellationToken.None);

        string body = h.Bodies[1];
        Assert.Contains("\"p_messages\"", body);
        Assert.Contains("\"kind\":\"state\"", body);
        // ⚠️ הסיסמה נשלחת רק בהתחברות, ולעולם לא בגוף האצווה.
        Assert.DoesNotContain("pw", body);
    }

    [Fact]
    public async Task TokenResponseWithoutAccessTokenIsAFailureNotASilentPass()
    {
        // ⚠️ תשובה 200 בלי אסימון היא בדיוק הצורה שמייצרת שקט: הכותב היה
        // ממשיך לשלוח בלי Authorization, מקבל 401 בכל פעם, ואיש לא היה
        // מבין למה.
        var h = new FakeHandler(req =>
            req.RequestUri!.AbsolutePath.Contains("token")
                ? (HttpStatusCode.OK, """{"token_type":"bearer"}""")
                : (HttpStatusCode.OK, "[]"));

        var w = new SupabaseWriter(Cfg(), new HttpClient(h));
        var r = await w.SendAsync(OneItem(), CancellationToken.None);

        Assert.False(r.Ok);
        Assert.Contains("access_token", r.Error);
        Assert.DoesNotContain("/rest/v1/rpc/ingest_batch", h.Paths);
    }
}
