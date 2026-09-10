using System.Net.Sockets;

namespace Parkomat.Agent.Core.Modbus;

/// <summary>
/// ערוץ Modbus מעל UDP — <b>במקום NModbus, ורק ב-UDP</b>.
///
/// <para>⚠️ <b>נמדד באתר 2222 ב-10/09/2026.</b> הבקר עונה נכון לחלוטין,
/// אבל כותרת ה-MBAP שלו שקרית:</para>
///
/// <code>
/// 00-00  00-00  00-00  01  03  06  02-86 00-01 00-07
///  txId   proto  אורך  unit FC  bc   646    1     7
/// </code>
///
/// <para><b>שדה האורך הוא אפס</b>, וגם מזהה הטרנזקציה אפס במקום להחזיר
/// את זה שנשלח. הנתונים עצמם — 646, 1, 7 — מדויקים.</para>
///
/// <para>⚠️ <b>ו-NModbus סומכת על שדה האורך.</b> היא קוראת שישה בתי
/// כותרת, מחשבת <c>frameLength = 0</c>, מקצה מערך <b>ריק</b>, ואז
/// <c>ModbusTransport.CreateResponse</c> ניגשת ל-<c>frame[1]</c> —
/// כלומר <c>Index was outside the bounds of the array</c>. זו הייתה
/// ההודעה בשטח, מאות פעמים ביום, והיא לא רמזה על שום דבר מזה.</para>
///
/// <para>⚠️ <b>ותשעת הבתים שנשארו מרעילים את הבקשה הבאה</b>, כי
/// <c>UdpClientAdapter</c> מחזיק מאגר מתמשך בין קריאות. לכן היו שני
/// stack traces שונים לאותה תקלה אחת.</para>
///
/// <para>⚠️ <b>modpoll קורא את אותו דטגרם בלי בעיה</b> — כי הוא מתעלם
/// משדה האורך ומפענח לפי מונה הבתים של ה-PDU. זה כל ההפרש, וזה מה
/// שנעשה כאן.</para>
///
/// <para>⚠️ <b>TCP נשאר על NModbus בכוונה.</b> הוא עובד ב-20 האתרים
/// האחרים, ואין שום סיבה להחליף מימוש שעובד כדי לתקן בקר אחד. הפיצול
/// הוא בדיוק בגבול שבו הבעיה נמצאת.</para>
/// </summary>
public sealed class ModbusUdpChannel : IDisposable
{
    /// <summary>אורך כותרת ה-MBAP: מזהה טרנזקציה, פרוטוקול, אורך.</summary>
    public const int HeaderLength = 6;

    /// <summary>המיקום המינימלי של תשובה שאפשר לפענח: כותרת + unit + FC + מונה בתים.</summary>
    public const int MinResponseLength = HeaderLength + 3;

    private readonly UdpClient _udp;
    private readonly string _ip;
    private readonly int _port;
    private readonly int _timeoutMs;
    private ushort _transactionId;

    public ModbusUdpChannel(string ipAddress, int port, int timeoutMs)
    {
        _ip = ipAddress;
        _port = port;
        _timeoutMs = timeoutMs;

        _udp = new UdpClient();
        _udp.Connect(ipAddress, port);
        _udp.Client.ReceiveTimeout = timeoutMs;
        _udp.Client.SendTimeout = timeoutMs;
    }

    /// <summary>קורא רגיסטרים. <paramref name="holding"/> = FC 0x03, אחרת FC 0x04.</summary>
    public ushort[] ReadRegisters(byte unitId, bool holding, int address, int count)
    {
        byte fc = holding ? (byte)0x03 : (byte)0x04;

        // ============================================================
        // ⚠️ מרוקנים שאריות **לפני** השליחה, ולא מתאימים אחריה
        // ============================================================
        // ב-UDP תשובה מאוחרת לבקשה קודמת מגיעה כשהבאה כבר בדרך, ואז
        // MODE מרגע אחד מזווג עם מונה מרגע אחר. הדרך הרגילה למנוע זאת
        // היא מזהה הטרנזקציה — **והבקר הזה מחזיר בו אפס**, כלומר הכלי
        // הזה אינו זמין. ריקון לפני שליחה כן זמין, והוא מספיק כאן: יש
        // בקשה אחת בכל רגע, והתשובה מגיעה או שיש timeout.
        while (_udp.Available > 0)
        {
            try { _udp.Receive(ref _drain); }
            catch (SocketException) { break; }
        }

        unchecked { _transactionId++; }
        byte[] request = BuildRequest(_transactionId, unitId, fc, address, count);

        _udp.Send(request, request.Length);

        byte[] response;
        try
        {
            response = _udp.Receive(ref _drain);
        }
        catch (SocketException ex)
        {
            throw new IOException(
                $"אין תגובה מהבקר {_ip}:{_port} תוך {_timeoutMs} מילי-שניות "
                + $"(FC=0x{fc:X2}, רגיסטר {address}, כמות {count})", ex);
        }

        return Parse(response, fc, count, address);
    }

    private System.Net.IPEndPoint _drain = new(System.Net.IPAddress.Any, 0);

    /// <summary>בונה בקשת Modbus/TCP. טהורה — ניתנת לבדיקה בלי רשת.</summary>
    public static byte[] BuildRequest(ushort transactionId, byte unitId, byte functionCode, int address, int count)
    {
        return new byte[]
        {
            (byte)(transactionId >> 8), (byte)(transactionId & 0xFF),
            0x00, 0x00,                 // מזהה פרוטוקול — תמיד 0
            0x00, 0x06,                 // אורך: unit + FC + כתובת + כמות
            unitId,
            functionCode,
            (byte)(address >> 8), (byte)(address & 0xFF),
            (byte)(count >> 8), (byte)(count & 0xFF),
        };
    }

    // ============================================================
    // ⚠️ הפענוח מתעלם משדה האורך — וזו כל הנקודה
    // ============================================================
    // הפונקציה טהורה בכוונה: הבאג בשטח היה בפענוח, לא ברשת, ולכן הוא
    // חייב להיות ניתן לשחזור בבדיקה בלי בקר ובלי socket.
    /// <summary>מפענח תשובת קריאת רגיסטרים. טהורה.</summary>
    public static ushort[] Parse(byte[] datagram, byte expectedFunctionCode, int count, int address)
    {
        if (datagram.Length < MinResponseLength)
            throw new IOException(
                $"הבקר החזיר {datagram.Length} בתים — קצר מהמינימום {MinResponseLength} "
                + $"(רגיסטר {address})");

        byte fc = datagram[HeaderLength + 1];

        // ⚠️ תשובת שגיאה של Modbus: הביט העליון של קוד הפונקציה דלוק,
        // והבית שאחריו הוא הקוד. בלי הזיהוי הזה היינו מפרשים את קוד
        // השגיאה כמונה בתים ומחזירים זבל כאילו הוא נתון.
        if ((fc & 0x80) != 0)
            throw new IOException(
                $"הבקר דחה את הבקשה: FC=0x{expectedFunctionCode:X2}, "
                + $"קוד שגיאה {datagram[HeaderLength + 2]}, רגיסטר {address}");

        if (fc != expectedFunctionCode)
            throw new IOException(
                $"הבקר ענה בפקודה 0x{fc:X2} במקום 0x{expectedFunctionCode:X2} (רגיסטר {address})");

        int byteCount = datagram[HeaderLength + 2];

        if (byteCount != count * 2)
            throw new IOException(
                $"הבקר החזיר {byteCount} בתים במקום {count * 2} "
                + $"עבור {count} רגיסטרים מכתובת {address}");

        if (datagram.Length < HeaderLength + 3 + byteCount)
            throw new IOException(
                $"הדטגרם קטוע: {datagram.Length} בתים, נדרשים {HeaderLength + 3 + byteCount} "
                + $"(רגיסטר {address})");

        var values = new ushort[count];
        for (int i = 0; i < count; i++)
        {
            int at = HeaderLength + 3 + (i * 2);
            values[i] = (ushort)((datagram[at] << 8) | datagram[at + 1]);
        }

        return values;
    }

    public void Dispose() => _udp.Dispose();
}
