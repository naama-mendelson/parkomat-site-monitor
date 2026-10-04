using System.Net.Http;
using System.Net.Sockets;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// סיווג כשל רשת מול Supabase — מה שהטכנאי קורא במסך "בדיקת חיבור".
///
/// ⚠️ באתר 2431 (04/10/2026) המסך הציג את משפט ה-Winsock כמות שהוא:
/// "The requested name is valid, but no data of the requested type was found".
/// הוא אינו אומר מה לבדוק, ושתי הסיבות הנפוצות בשטח — DNS וחומת אש
/// (22/09: חמישה אתרים, 10013) — נראות בו כמעט זהות.
/// </summary>
public class NetworkFailureTests
{
    // ⚠️ **עטוף, כמו ש-HttpClient זורק בפועל.** SocketException חשוף אינו
    // מה שמגיע ל-catch; בדיקה שבונה רק אותו הייתה עוברת גם על קוד שבודק
    // את החריגה העליונה בלבד — ונכשל בשטח על כל קריאה.
    private static Exception AsHttpClientThrowsIt(SocketError code) =>
        new HttpRequestException("wrapped", new SocketException((int)code));

    [Theory]
    [InlineData(SocketError.HostNotFound)]
    [InlineData(SocketError.NoData)]        // 11004 — מה שנצפה ב-2431
    [InlineData(SocketError.TryAgain)]
    public void ANameThatDoesNotResolveSaysDns(SocketError code)
    {
        string msg = NetworkFailure.Describe(AsHttpClientThrowsIt(code));
        Assert.Contains("DNS", msg);
        Assert.DoesNotContain("חומת האש", msg);
    }

    [Fact]
    public void AnOutboundBlockSaysFirewallAndNamesTheRule()
    {
        string msg = NetworkFailure.Describe(AsHttpClientThrowsIt(SocketError.AccessDenied));
        Assert.Contains("חומת האש", msg);
        Assert.Contains("Parkomat.Agent.Service.exe", msg);
        Assert.Contains("443", msg);
        Assert.DoesNotContain("DNS", msg);

        // ⚠️ **גם ה-Tray.** הבדיקה הזו רצה בתהליך של ה-Tray, ולכן ההודעה
        // מופיעה בדיוק כשחוק ה-Tray חסר — "החוק שנשכח" (1326). חוק לשירות
        // בלבד מתקן את הדיווח ומשאיר את "בדוק שוב" אדום, וזה נקרא "התיקון
        // לא עבד".
        Assert.Contains("Parkomat.Agent.Tray.exe", msg);
    }

    // ⚠️ **ההסבר נוסף לקוד — לא במקומו.** ב-1326 האבחון לקח דקות בדיוק
    // כי המסך הציג את שגיאת מערכת ההפעלה עצמה (10013).
    [Theory]
    [InlineData(SocketError.NoData, 11004)]
    [InlineData(SocketError.AccessDenied, 10013)]
    [InlineData(SocketError.TimedOut, 10060)]
    public void TheOriginalCodeStaysInTheMessage(SocketError code, int number)
    {
        string msg = NetworkFailure.Describe(AsHttpClientThrowsIt(code));
        Assert.Contains($"(קוד {number})", msg);
    }

    [Theory]
    [InlineData(SocketError.ConnectionRefused)]
    [InlineData(SocketError.TimedOut)]
    [InlineData(SocketError.NetworkUnreachable)]
    [InlineData(SocketError.HostUnreachable)]
    public void NoRouteSaysHttpsIsBlocked(SocketError code)
    {
        string msg = NetworkFailure.Describe(AsHttpClientThrowsIt(code));
        Assert.Contains("443", msg);
        Assert.DoesNotContain("DNS", msg);
    }

    // ⚠️ **בכל עומק.** מתחת ל-TLS יש לפעמים שכבה נוספת (IOException).
    [Fact]
    public void TheSocketErrorIsFoundAtAnyDepth()
    {
        var deep = new HttpRequestException("outer",
            new IOException("tls", new SocketException((int)SocketError.NoData)));
        Assert.Contains("DNS", NetworkFailure.Describe(deep));
    }

    // ⚠️ **קוד לא מוכר מחזיר את ההודעה המקורית — לא ניחוש.** הסבר בטוח
    // בעצמו שגוי גרוע מהמשפט האנגלי: הוא שולח לבדוק את הדבר הלא נכון.
    [Fact]
    public void AnUnknownFailureKeepsTheOriginalMessage()
    {
        var ex = new HttpRequestException("outer", new InvalidOperationException("something else"));
        Assert.Equal("something else", NetworkFailure.Describe(ex));
    }

    [Fact]
    public void AnUnmappedSocketCodeKeepsTheOriginalMessage()
    {
        var sock = new SocketException((int)SocketError.MessageSize);
        string msg = NetworkFailure.Describe(new HttpRequestException("outer", sock));
        Assert.Equal(sock.Message, msg);
    }
}
