using System.Diagnostics;

namespace Parkomat.Agent.Core.Modbus;

/// <summary>
/// ערוץ Modbus RTU — טורי, דרך פורט COM במחשב האתר (1.0.61, 20/10/2026).
///
/// <para>נבנה לבקר הראשון שאין בו Ethernet: הגישה היחידה היא פורט RS232 של הבקר, בכבל USB-Serial למחשב
/// שבאתר. מסמך הבקר: 9600, 8 ביטים, בלי זוגיות, ביט עצירה 1; יחידה 1; פונקציה 03; בקשה אחת מ-405, כמות 3:</para>
///
/// <code>
/// בקשה:   01 03 01 95 00 03 14 1B
/// תשובה:  01 03 06 00 3E 00 01 00 00 59 70      (מונה 62, MODE 1, כרטיס 0)
///         unit FC bc  ───── נתונים ─────  CRC (הבית הנמוך ראשון)
/// </code>
///
/// <para>⚠️ <b>ערוץ משלנו ולא NModbus</b>, מאותו נימוק כמו <c>ModbusUdpChannel</c>: מסגרת RTU היא שמונה
/// בתים ו-CRC, ופונקציה טהורה שבונה ומפענחת אותה ניתנת לבדיקה מול הבתים המדויקים מהמסמך, בלי בקר ובלי פורט.
/// NModbus דורשת גם חבילה נוספת ומתאם לפורט, ומחזיקה את הפורט פתוח — וזה בדיוק מה שאסור כאן (למטה).</para>
///
/// <para>⚠️ <b>הפורט נפתח לכל קריאה ונסגר מיד אחריה.</b> אותו כבל משמש את הטכנאי לתכנות הבקר, ורק תוכנה
/// אחת יכולה להחזיק את COM6 בכל רגע (המסמך: "מומלץ לפתוח את הפורט לכל קריאה ולסגור אותו מיד אחריה").
/// סוכן שמחזיק את הפורט פתוח היה נועל את הטכנאי בחוץ. בזמן שהטכנאי מחובר הקריאה נכשלת — וזה תקין: אחרי
/// עשרה כשלים הסוכן מדווח תקלה, כמו נתק בכל אתר (בעלת המוצר, 20/10/2026: "תקלה, כמו נתק בכל אתר").</para>
/// </summary>
public sealed class ModbusRtuChannel
{
    /// <summary>תשובה תקינה קצרה ביותר: יחידה, פונקציה, קוד שגיאה, CRC (תשובת שגיאה).</summary>
    public const int MinResponseLength = 5;

    private readonly Func<IRtuPort> _openPort;
    private readonly int _timeoutMs;
    private readonly string _describe;

    /// <param name="settings">הפורט והגדרות התקשורת מ-<c>PlcConfig</c>.</param>
    /// <param name="timeoutMs">כמה לחכות לתשובה מלאה. המסמך: עד 500 מילישניות.</param>
    public ModbusRtuChannel(RtuSettings settings, int timeoutMs)
        : this(() => new SerialRtuPort(settings), timeoutMs, settings.Describe())
    {
    }

    /// <summary>לבדיקות: פורט מדומה במקום פורט COM אמיתי.</summary>
    public ModbusRtuChannel(Func<IRtuPort> openPort, int timeoutMs, string describe)
    {
        _openPort = openPort;
        _timeoutMs = timeoutMs;
        _describe = describe;
    }

    // ============================================================
    // ⚠️ פתיחה חוזרת מיד אחרי סגירה — ממתינים מעט, ולא מוותרים
    // ============================================================
    // התיעוד של SerialPort אומר שפורט שנסגר אינו בהכרח משוחרר מיד, ושפתיחה מחדש מיד אחרי סגירה עלולה
    // להיכשל ב-UnauthorizedAccessException — אותה חריגה כמו פורט שתוכנה אחרת מחזיקה. אצלנו זה קורה כשטקסט
    // התקלה נקרא באותו סבב, אחרי הקריאה הרגילה. לכן שני ניסיונות נוספים, 100 מילישניות זה מזה. פורט שהטכנאי
    // מחזיק באמת ממשיך להיכשל אחריהם, והכישלון עולה רק 200 מילישניות נוספות.
    private const int OpenRetries = 2;
    private const int OpenRetryDelayMs = 100;

    /// <summary>קורא רגיסטרים. <paramref name="holding"/> = FC 0x03, אחרת FC 0x04.</summary>
    public ushort[] ReadRegisters(byte unitId, bool holding, int address, int count)
    {
        byte fc = holding ? (byte)0x03 : (byte)0x04;
        byte[] request = BuildRequest(unitId, fc, address, count);

        using IRtuPort port = _openPort();
        OpenWithRetry(port);

        // שאריות מהבקר (תשובה מאוחרת לבקשה שכבר נכשלה) — לפני השליחה, כמו בערוץ ה-UDP
        port.DiscardInBuffer();
        port.Write(request, 0, request.Length);

        byte[] response = ReadFrame(port, count, address, fc);
        return Parse(response, unitId, fc, count, address);
        // ⚠️ ה-using סוגר את הפורט כאן — הטכנאי יכול להתחבר עד הקריאה הבאה
    }

    private void OpenWithRetry(IRtuPort port)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                port.Open();
                return;
            }
            catch (UnauthorizedAccessException ex)
            {
                if (attempt < OpenRetries) { Thread.Sleep(OpenRetryDelayMs); continue; }
                // ⚠️ הודעה שאומרת מה קרה ומה התקין: "Access to the port is denied" לבדה נקראת כמו בעיית הרשאות
                throw new IOException(
                    $"הפורט תפוס בידי תוכנה אחרת [{_describe}] — כנראה תוכנת הטכנאי מחוברת לבקר. "
                    + "הקריאות יחזרו כשהיא תשחרר את הפורט.", ex);
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or InvalidOperationException)
            {
                // ⚠️ פורט שאינו קיים — לרוב הכבל עבר לשקע USB אחר ומספר ה-COM השתנה. ההודעה מונה את הפורטים
                // שכן קיימים, כי זה בדיוק מה שהטכנאי צריך כדי לתקן בהגדרות → רגיסטרים.
                string[] present = SerialRtuPort.PresentPorts();
                throw new IOException(
                    $"לא ניתן לפתוח את הפורט [{_describe}]: {ex.Message} "
                    + (present.Length > 0 ? $"פורטים שקיימים במחשב: {string.Join(", ", present)}." : "אין במחשב פורט COM מחובר."),
                    ex);
            }
        }
    }

    // ============================================================
    // קריאת מסגרת שלמה — הבתים מגיעים בחלקים
    // ============================================================
    // בפורט טורי התשובה אינה מגיעה בבת אחת: 11 בתים ב-9600 הם כ-11 מילישניות, ו-Read מחזיר מה שהגיע עד
    // אותו רגע. קוראים עד שיש מסגרת שלמה — שלושה בתים קובעים את האורך: בתשובת שגיאה (הביט העליון בפונקציה
    // דלוק) המסגרת היא 5 בתים, אחרת 3 + מונה הבתים + 2 (CRC). מגבלת זמן אחת לכל המסגרת, לא לכל Read.
    private byte[] ReadFrame(IRtuPort port, int count, int address, byte fc)
    {
        var buffer = new byte[3 + 255 + 2];
        int have = 0;
        int need = 3;
        var sw = Stopwatch.StartNew();

        while (have < need)
        {
            int left = _timeoutMs - (int)sw.ElapsedMilliseconds;
            if (left <= 0) throw NoAnswer(have, fc, address, count);
            int got;
            try { got = port.Read(buffer, have, need - have, left); }
            catch (TimeoutException) { throw NoAnswer(have, fc, address, count); }
            if (got <= 0) continue;
            have += got;

            if (have >= 2 && (buffer[1] & 0x80) != 0) need = MinResponseLength;
            else if (have >= 3 && need == 3) need = 3 + buffer[2] + 2;
        }

        return buffer[..need];
    }

    private IOException NoAnswer(int have, byte fc, int address, int count) => new(
        have == 0
            ? $"אין תגובה מהבקר [{_describe}] תוך {_timeoutMs} מילי-שניות (FC=0x{fc:X2}, רגיסטר {address}, כמות {count})"
            : $"תשובה קטועה מהבקר [{_describe}]: {have} בתים תוך {_timeoutMs} מילי-שניות (FC=0x{fc:X2}, רגיסטר {address})");

    /// <summary>בונה בקשת קריאה של RTU: יחידה, פונקציה, כתובת, כמות, CRC (הבית הנמוך ראשון). טהורה.</summary>
    public static byte[] BuildRequest(byte unitId, byte functionCode, int address, int count)
    {
        var frame = new byte[8];
        frame[0] = unitId;
        frame[1] = functionCode;
        frame[2] = (byte)(address >> 8);
        frame[3] = (byte)(address & 0xFF);
        frame[4] = (byte)(count >> 8);
        frame[5] = (byte)(count & 0xFF);
        ushort crc = Crc16(frame.AsSpan(0, 6));
        frame[6] = (byte)(crc & 0xFF);
        frame[7] = (byte)(crc >> 8);
        return frame;
    }

    /// <summary>מפענח תשובת קריאת רגיסטרים של RTU, אחרי בדיקת CRC, יחידה ופונקציה. טהורה.</summary>
    public static ushort[] Parse(byte[] frame, byte unitId, byte expectedFunctionCode, int count, int address)
    {
        if (frame.Length < MinResponseLength)
            throw new IOException($"הבקר החזיר {frame.Length} בתים — קצר מהמינימום {MinResponseLength} (רגיסטר {address})");

        // ⚠️ ה-CRC נבדק ראשון: בלעדיו רעש בקו (כבל, הפרעה) היה נקרא כנתון. מסגרת שה-CRC שלה שגוי
        // אינה אומרת דבר — גם לא "הבקר דחה".
        ushort want = Crc16(frame.AsSpan(0, frame.Length - 2));
        ushort got = (ushort)(frame[^2] | (frame[^1] << 8));
        if (want != got)
            throw new IOException($"CRC שגוי בתשובת הבקר (התקבל 0x{got:X4}, מחושב 0x{want:X4}, רגיסטר {address}) — רעש בקו או הגדרות תקשורת שגויות");

        if (frame[0] != unitId)
            throw new IOException($"ענתה יחידה {frame[0]} במקום {unitId} (רגיסטר {address})");

        byte fc = frame[1];
        if ((fc & 0x80) != 0)
            throw new IOException($"הבקר דחה את הבקשה: FC=0x{expectedFunctionCode:X2}, קוד שגיאה {frame[2]}, רגיסטר {address}");

        if (fc != expectedFunctionCode)
            throw new IOException($"הבקר ענה בפקודה 0x{fc:X2} במקום 0x{expectedFunctionCode:X2} (רגיסטר {address})");

        int byteCount = frame[2];
        if (byteCount != count * 2)
            throw new IOException($"הבקר החזיר {byteCount} בתים במקום {count * 2} עבור {count} רגיסטרים מכתובת {address}");

        if (frame.Length != 3 + byteCount + 2)
            throw new IOException($"אורך המסגרת {frame.Length} אינו תואם למונה הבתים {byteCount} (רגיסטר {address})");

        var values = new ushort[count];
        for (int i = 0; i < count; i++)
            values[i] = (ushort)((frame[3 + 2 * i] << 8) | frame[4 + 2 * i]);
        return values;
    }

    /// <summary>CRC-16 של Modbus (פולינום 0xA001, ערך התחלתי 0xFFFF). טהורה.</summary>
    public static ushort Crc16(ReadOnlySpan<byte> data)
    {
        ushort crc = 0xFFFF;
        foreach (byte b in data)
        {
            crc ^= b;
            for (int i = 0; i < 8; i++)
                crc = (crc & 1) != 0 ? (ushort)((crc >> 1) ^ 0xA001) : (ushort)(crc >> 1);
        }
        return crc;
    }
}

/// <summary>פורט טורי, כפי שהערוץ צריך אותו. מופשט כדי שהבדיקות ירוצו בלי פורט COM.</summary>
public interface IRtuPort : IDisposable
{
    void Open();
    void DiscardInBuffer();
    void Write(byte[] buffer, int offset, int count);

    /// <summary>קורא מה שהגיע, עד <paramref name="count"/> בתים. זורק <see cref="TimeoutException"/> אם לא הגיע דבר.</summary>
    int Read(byte[] buffer, int offset, int count, int timeoutMs);
}

/// <summary>הגדרות הפורט הטורי, נגזרות מ-<c>PlcConfig</c>.</summary>
public sealed record RtuSettings(string PortName, int BaudRate, string Parity, int StopBits)
{
    /// <summary>"COM6 9600 8N1" — כפי שזה כתוב במסמכי בקרים ובכלים כמו modpoll.</summary>
    public string Describe() =>
        $"RTU {PortName} {BaudRate} 8{(Parity == "even" ? "E" : Parity == "odd" ? "O" : "N")}{StopBits}";
}

/// <summary>הפורט האמיתי — System.IO.Ports.</summary>
public sealed class SerialRtuPort : IRtuPort
{
    private readonly System.IO.Ports.SerialPort _port;

    public SerialRtuPort(RtuSettings s)
    {
        _port = new System.IO.Ports.SerialPort(s.PortName, s.BaudRate,
            s.Parity switch { "even" => System.IO.Ports.Parity.Even, "odd" => System.IO.Ports.Parity.Odd, _ => System.IO.Ports.Parity.None },
            8,   // ⚠️ RTU מחייב 8 ביטי נתונים — זה לא כוונון
            s.StopBits == 2 ? System.IO.Ports.StopBits.Two : System.IO.Ports.StopBits.One)
        {
            Handshake = System.IO.Ports.Handshake.None,
            WriteTimeout = 1000,
        };
    }

    public void Open() => _port.Open();
    public void DiscardInBuffer() => _port.DiscardInBuffer();
    public void Write(byte[] buffer, int offset, int count) => _port.Write(buffer, offset, count);

    public int Read(byte[] buffer, int offset, int count, int timeoutMs)
    {
        _port.ReadTimeout = Math.Max(1, timeoutMs);
        return _port.Read(buffer, offset, count);
    }

    public void Dispose()
    {
        // ⚠️ Close ואז Dispose: הפורט חייב להשתחרר כאן, אחרת הטכנאי לא יוכל לפתוח אותו
        try { if (_port.IsOpen) _port.Close(); } catch { /* פורט שנותק באמצע — אין מה לסגור */ }
        _port.Dispose();
    }

    /// <summary>הפורטים שקיימים עכשיו במחשב, ממוינים — להודעות שגיאה ולבורר בהגדרות.</summary>
    public static string[] PresentPorts()
    {
        try { return System.IO.Ports.SerialPort.GetPortNames().Distinct().OrderBy(p => p.Length).ThenBy(p => p).ToArray(); }
        catch { return Array.Empty<string>(); }
    }
}
