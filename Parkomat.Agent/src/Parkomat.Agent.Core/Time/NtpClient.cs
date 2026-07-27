using System.Net;
using System.Net.Sockets;

namespace Parkomat.Agent.Core.Time;

/// <summary>
/// לקוח SNTP מינימלי (RFC 4330) מעל UDP/123.
///
/// למה בכלל: חותמת הזמן של כל פעולה נלקחת משעון המחשב באתר החניה. מחשב עם
/// שעון סוטה רושם את כל הפעולות שלו בזמן שגוי — והשרת לא יכול לדעת, כי סטייה
/// של דקות/שעות עדיין נראית כמו זמן סביר. כאן שואלים שרת זמן אמיתי ומחשבים
/// את ההיסט.
///
/// שים לב: אנחנו *לא* מכוונים את שעון המערכת. זה היה דורש הרשאות מנהל,
/// שהפרויקט הזה נמנע מהן בכוונה (ראה CLAUDE.md). במקום זה שומרים היסט
/// ומחילים אותו על מה שמשדרים (ראה AgentClock).
/// </summary>
public static class NtpClient
{
    private const int NtpPort = 123;

    // עידן NTP מתחיל ב-1900, לא ב-1970.
    private static readonly DateTime Epoch1900 = new(1900, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>
    /// שואל שרת NTP ומחזיר את ההיסט (זמן-אמת פחות שעון מקומי), או null אם
    /// לא הצליח. לעולם לא זורק: אתר עם UDP/123 חסום חייב להמשיך לעבוד.
    /// </summary>
    public static async Task<TimeSpan?> GetOffsetAsync(
        string server, TimeSpan timeout, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(server))
            return null;

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);

            IPAddress[] addresses = await Dns.GetHostAddressesAsync(server.Trim(), cts.Token);
            if (addresses.Length == 0)
                return null;

            using var udp = new UdpClient(addresses[0].AddressFamily);
            var endpoint = new IPEndPoint(addresses[0], NtpPort);

            // בקשת לקוח: LI=0, VN=3, Mode=3
            var request = new byte[48];
            request[0] = 0x1B;

            // ==========================================================
            // nonce בשדה ה-Transmit Timestamp — כדי שתשובה תהיה מאומתת
            // ==========================================================
            // UDP הוא ללא חיבור, וכל מי שיכול לשלוח דאטגרם ל-socket הזה יכול
            // לענות במקום שרת הזמן. תשובה מזויפת אחת קובעת את ההיסט של האתר,
            // וממנה כל חותם שהסוכן משדר שגוי — והשרת דוחה את כולם (ראה
            // AgentClock.MaxPlausibleOffset). האתר נכבה בשקט.
            //
            // לפי RFC 4330 השרת מחזיר את ה-Transmit Timestamp שלנו כמו-שהוא
            // בשדה ה-Originate Timestamp (בייטים 24-31). קודם שלחנו שם אפסים,
            // ולכן ההד היה חסר משמעות. עכשיו שולחים ערך מקרי ובודקים אותו —
            // כך תשובה שאינה למדידה *שלנו* נדחית.
            //
            // זה אינו קריפטוגרפי ואינו מתיימר להיות: הוא חוסם off-path בלבד.
            // מי שיושב על הקו יכול לראות את ה-nonce ולהחזיר אותו. ההגנה
            // האמיתית מפני זה היא החסם על גודל ההיסט.
            var nonce = new byte[8];
            System.Security.Cryptography.RandomNumberGenerator.Fill(nonce);
            Buffer.BlockCopy(nonce, 0, request, 40, 8);

            // T1/T4 נמדדים בשעון המקומי; T2/T3 מגיעים מהשרת.
            DateTime t1 = DateTime.UtcNow;
            await udp.SendAsync(request, endpoint, cts.Token);

            UdpReceiveResult result;
            byte[] buffer;

            // מתעלמים מדאטגרמים שאינם מהשרת שנשאל או שאינם תשובה למדידה הזו,
            // וממשיכים להמתין עד ה-timeout — אחרת חבילה זרה אחת הייתה מבטלת
            // סנכרון תקין.
            while (true)
            {
                result = await udp.ReceiveAsync(cts.Token);
                buffer = result.Buffer;

                // מאיזה שרת? חייב להיות זה שאליו שלחנו, ומפורט 123.
                if (!result.RemoteEndPoint.Address.Equals(endpoint.Address) ||
                    result.RemoteEndPoint.Port != endpoint.Port)
                    continue;

                if (buffer.Length < 48)
                    continue;

                // האם זו תשובה למדידה *שלנו*? ההד של ה-nonce.
                if (!buffer.AsSpan(24, 8).SequenceEqual(nonce))
                    continue;

                break;
            }

            DateTime t4 = DateTime.UtcNow;

            // Leap Indicator = 3 פירושו "השעון שלי לא מסונכרן" — השרת עצמו
            // מודה שאין לו זמן אמין. אין סיבה לתקן לפיו.
            if ((buffer[0] >> 6) == 3)
                return null;

            // Mode 4 = server. כל דבר אחר אינו תשובה לשאילתת לקוח.
            if ((buffer[0] & 0x07) != 4)
                return null;

            // Stratum 0 = "kiss-o'-death" — תשובה שאינה זמן. מעל 15 = שמור/פסול.
            if (buffer[1] == 0 || buffer[1] > 15)
                return null;

            DateTime? t2 = ReadTimestamp(buffer, 32);   // Receive Timestamp
            DateTime? t3 = ReadTimestamp(buffer, 40);   // Transmit Timestamp
            if (t2 is null || t3 is null)
                return null;

            // הנוסחה התקנית: ((T2-T1) + (T3-T4)) / 2. היא מקזזת את זמן הרשת,
            // ולכן מדויקת הרבה יותר מ"פשוט לקחת את זמן השרת".
            long ticks = ((t2.Value - t1) + (t3.Value - t4)).Ticks / 2;
            return TimeSpan.FromTicks(ticks);
        }
        catch
        {
            // DNS/רשת/timeout/חומת אש — כולם "אין סנכרון", לא תקלה.
            return null;
        }
    }

    /// <summary>קורא חותמת NTP של 64 ביט (32 שניות + 32 שבר). null = ריקה.</summary>
    private static DateTime? ReadTimestamp(byte[] buffer, int offset)
    {
        ulong seconds = ((ulong)buffer[offset] << 24) | ((ulong)buffer[offset + 1] << 16)
                      | ((ulong)buffer[offset + 2] << 8) | buffer[offset + 3];
        ulong fraction = ((ulong)buffer[offset + 4] << 24) | ((ulong)buffer[offset + 5] << 16)
                       | ((ulong)buffer[offset + 6] << 8) | buffer[offset + 7];

        if (seconds == 0 && fraction == 0)
            return null;   // חותמת ריקה — השרת לא מילא אותה

        // גלישת עידן NTP: מונה השניות הוא 32 ביט ומתאפס ב-2036. הביט העליון
        // דלוק בעידן הנוכחי (1968–2036); כשהוא כבוי מדובר בעידן הבא, ומוסיפים
        // 2^32 שניות. בלי זה הסוכן היה מדווח 1900 החל מ-2036.
        if ((seconds & 0x80000000UL) == 0)
            seconds += 0x100000000UL;

        double milliseconds = seconds * 1000.0 + (fraction * 1000.0 / 0x100000000UL);
        return Epoch1900.AddMilliseconds(milliseconds);
    }
}
