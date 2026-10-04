using System.Net.Sockets;

namespace Parkomat.Agent.Core.Supabase;

/// <summary>
/// תרגום כשל רשת מול Supabase להודעה שטכנאי בשטח יכול לפעול לפיה.
///
/// ============================================================
/// למה זה קיים
/// ============================================================
/// מסך "בדיקת חיבור" הציג את <c>ex.GetBaseException().Message</c> כמות שהוא.
/// באתר 2431 (04/10/2026) זה היה:
///
///     The requested name is valid, but no data of the requested type was found
///
/// כלומר WSANO_DATA (11004) — שם השרת אינו מתורגם לכתובת ברשת האתר. משפט
/// אנגלי של Winsock אינו אומר לטכנאי <b>מה לבדוק</b>, ושתי הסיבות הנפוצות
/// בשטח נראות בו כמעט זהות: DNS של הרשת, וחומת אש שחוסמת יציאה (22/09:
/// חמישה אתרים, <c>DefaultOutboundAction = Block</c>, ו-10013 "forbidden by
/// its access permissions").
///
/// ⚠️ ב-Core ולא ב-Tray: פרויקט הבדיקות אינו מפנה ל-Tray (net10.0-windows),
/// והסיווג הוא הדבר היחיד כאן שראוי לבדיקה — פונקציה טהורה, בלי רשת.
/// </summary>
public static class NetworkFailure
{
    /// <summary>
    /// מחזיר הסבר בעברית לפי קוד ה-Socket שבתוך החריגה, או את הודעת הבסיס
    /// כשהקוד אינו מוכר. <b>לעולם אינו זורק.</b>
    /// </summary>
    public static string Describe(Exception ex)
    {
        SocketException? sock = FindSocketException(ex);
        string? why = sock is null ? null : Explain(sock.SocketErrorCode);
        if (why is null)
            return ex.GetBaseException().Message;

        // ⚠️ **הקוד המקורי נשאר בהודעה.** ב-1326 (CLAUDE.md של הסוכן) האבחון
        // לקח דקות בדיוק כי המסך הציג את שגיאת מערכת ההפעלה עצמה (10013) —
        // ההסבר בעברית נוסף עליה, לא במקומה.
        return $"{why} (קוד {sock!.ErrorCode})";
    }

    private static string? Explain(SocketError code) => code switch
    {
        SocketError.HostNotFound      // 11001
            or SocketError.NoData     // 11004 — מה שנצפה ב-2431
            or SocketError.TryAgain   // 11002
            => "שם השרת של Supabase אינו מתורגם ברשת האתר (DNS). " +
               "יש לבדוק את הגדרות ה-DNS של הרשת או של המחשב.",

        SocketError.AccessDenied      // 10013
            => "חומת האש של Windows חוסמת יציאה. יש להוסיף חוק יציאה " +
               "ל-Parkomat.Agent.Service.exe ול-Parkomat.Agent.Tray.exe ב-TCP 443.",

        SocketError.ConnectionRefused
            or SocketError.TimedOut
            or SocketError.NetworkUnreachable
            or SocketError.HostUnreachable
            => "אין חיבור ל-Supabase ב-HTTPS — ייתכן שהרשת חוסמת יציאה ב-443.",

        _ => null
    };

    // ⚠️ מחפשים בכל השרשרת ולא רק בבסיס: HttpClient עוטף את ה-SocketException
    // ב-HttpRequestException, ולפעמים בשכבה נוספת (IOException ב-TLS).
    private static SocketException? FindSocketException(Exception? ex)
    {
        for (Exception? e = ex; e is not null; e = e.InnerException)
            if (e is SocketException s) return s;
        return null;
    }
}
