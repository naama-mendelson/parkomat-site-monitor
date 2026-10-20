using System.Diagnostics;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Modbus;
using Parkomat.Agent.Service.Modbus;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// Modbus RTU טורי (1.0.61, 20/10/2026) — מול מסמך הבקר הראשון בלי Ethernet, בית-בבית:
///
/// <code>
/// בקשה:   01 03 01 95 00 03 14 1B                 (יחידה 1, FC 03, מ-405, כמות 3)
/// תשובה:  01 03 06 00 3E 00 01 00 00 59 70        (מונה 62, MODE 1, כרטיס 0)
/// </code>
///
/// <para>⚠️ <b>הבדיקות רצות בלי פורט COM</b>: <see cref="FakeRtuPort"/> מוסר את התשובה בחלקים, כמו פורט טורי
/// אמיתי (11 בתים ב-9600 מגיעים בכמה Read). ומונה פתיחות וסגירות — כי פתיחה לכל קריאה וסגירה מיד אחריה
/// היא דרישה של המסמך: אותו כבל משמש את הטכנאי.</para>
/// </summary>
public class ModbusRtuChannelTests
{
    private static readonly byte[] DocRequest = { 0x01, 0x03, 0x01, 0x95, 0x00, 0x03, 0x14, 0x1B };
    private static readonly byte[] DocResponse = { 0x01, 0x03, 0x06, 0x00, 0x3E, 0x00, 0x01, 0x00, 0x00, 0x59, 0x70 };

    private static byte[] WithCrc(params byte[] body)
    {
        ushort c = ModbusRtuChannel.Crc16(body);
        return body.Concat(new[] { (byte)(c & 0xFF), (byte)(c >> 8) }).ToArray();
    }

    // ---------------- המסגרת: בנייה, CRC, פענוח ----------------

    [Fact]
    public void TheRequestIsByteForByteTheDocumentExample()
    {
        Assert.Equal(DocRequest, ModbusRtuChannel.BuildRequest(1, 0x03, 405, 3));
    }

    [Fact]
    public void Crc16MatchesTheDocumentForTheRequestAndTheResponse()
    {
        Assert.Equal(0x1B14, ModbusRtuChannel.Crc16(DocRequest.AsSpan(0, 6)));
        Assert.Equal(0x7059, ModbusRtuChannel.Crc16(DocResponse.AsSpan(0, 9)));
    }

    [Fact]
    public void TheDocumentResponseReadsAsCounter62Mode1Card0()
    {
        Assert.Equal(new ushort[] { 62, 1, 0 }, ModbusRtuChannel.Parse(DocResponse, 1, 0x03, 3, 405));
    }

    // ⚠️ רעש בקו נראה כמו נתון סביר. בלי בדיקת CRC מונה 62 שהפך ל-63 היה נכנס להיסטוריה.
    [Fact]
    public void ABadCrcIsRejectedRatherThanReadAsData()
    {
        byte[] noisy = (byte[])DocResponse.Clone();
        noisy[4] = 0x3F;
        var ex = Assert.Throws<IOException>(() => ModbusRtuChannel.Parse(noisy, 1, 0x03, 3, 405));
        Assert.Contains("CRC", ex.Message);
    }

    [Fact]
    public void AnExceptionResponseIsReportedWithItsCode()
    {
        var ex = Assert.Throws<IOException>(() => ModbusRtuChannel.Parse(WithCrc(0x01, 0x83, 0x02), 1, 0x03, 3, 405));
        Assert.Contains("קוד שגיאה 2", ex.Message);
    }

    [Fact]
    public void AnAnswerFromAnotherUnitIsRejected()
    {
        byte[] other = WithCrc(0x02, 0x03, 0x06, 0x00, 0x3E, 0x00, 0x01, 0x00, 0x00);
        var ex = Assert.Throws<IOException>(() => ModbusRtuChannel.Parse(other, 1, 0x03, 3, 405));
        Assert.Contains("יחידה 2", ex.Message);
    }

    [Fact]
    public void AByteCountThatDoesNotMatchTheRequestIsRejected()
    {
        byte[] two = WithCrc(0x01, 0x03, 0x04, 0x00, 0x3E, 0x00, 0x01);
        var ex = Assert.Throws<IOException>(() => ModbusRtuChannel.Parse(two, 1, 0x03, 3, 405));
        Assert.Contains("4 בתים במקום 6", ex.Message);
    }

    [Fact]
    public void AShortFrameIsRejectedRatherThanIndexed()
    {
        var ex = Assert.Throws<IOException>(() => ModbusRtuChannel.Parse(new byte[] { 0x01, 0x03 }, 1, 0x03, 3, 405));
        Assert.DoesNotContain("Index was outside", ex.Message);
    }

    // ---------------- הערוץ: פורט, חלקים, פתיחה וסגירה ----------------

    [Fact]
    public void AFrameDeliveredInPiecesIsAssembledAndTheRequestIsTheDocuments()
    {
        var log = new List<string>();
        var ch = new ModbusRtuChannel(() => new FakeRtuPort(log) { Respond = _ => DocResponse, Chunk = 2 }, 500, "RTU COM6 9600 8N1");

        Assert.Equal(new ushort[] { 62, 1, 0 }, ch.ReadRegisters(1, holding: true, 405, 3));
        Assert.Equal(DocRequest, FakeRtuPort.LastWritten);
        // ⚠️ שאריות נזרקות לפני השליחה, והפורט נסגר בסוף
        Assert.Equal(new[] { "open", "discard", "write", "close" }, log.Where(x => x != "read").ToArray());
    }

    // ⚠️ המסמך: "מומלץ לפתוח את הפורט לכל קריאה ולסגור אותו מיד אחריה" — אותו כבל משמש את הטכנאי.
    // סוכן שמחזיק את הפורט פתוח היה נועל אותו בחוץ.
    [Fact]
    public void ThePortIsOpenedForEachReadAndClosedRightAfterIt()
    {
        var log = new List<string>();
        var ch = new ModbusRtuChannel(() => new FakeRtuPort(log) { Respond = _ => DocResponse }, 500, "RTU COM6 9600 8N1");

        ch.ReadRegisters(1, true, 405, 3);
        Assert.Equal("close", log.Last());
        ch.ReadRegisters(1, true, 405, 3);

        string[] lifecycle = log.Where(x => x is "open" or "close").ToArray();
        Assert.Equal(new[] { "open", "close", "open", "close" }, lifecycle);
    }

    // ⚠️ פורט שתוכנת הטכנאי מחזיקה: הודעה שאומרת זאת — ולא "Access to the port is denied", שנקראת כמו
    // בעיית הרשאות. ושום בקשה לא נשלחה. (בעלת המוצר: אחרי עשרה כשלים — תקלה, כמו נתק בכל אתר.)
    [Fact]
    public void ABusyPortFailsWithAClearMessageAndSendsNothing()
    {
        var log = new List<string>();
        var ch = new ModbusRtuChannel(() => new FakeRtuPort(log) { BusyOpens = int.MaxValue }, 500, "RTU COM6 9600 8N1");

        var ex = Assert.Throws<IOException>(() => ch.ReadRegisters(1, true, 405, 3));
        Assert.Contains("תפוס", ex.Message);
        Assert.Contains("COM6", ex.Message);
        Assert.Equal(3, log.Count(x => x == "open"));      // פעם ועוד שני ניסיונות
        Assert.DoesNotContain("write", log);
    }

    // ⚠️ פתיחה מיד אחרי סגירה שלנו (טקסט התקלה נקרא באותו סבב) — הפורט לא תמיד משוחרר באותו רגע.
    [Fact]
    public void ABriefBusyRightAfterOurOwnCloseIsRiddenOut()
    {
        var log = new List<string>();
        var ch = new ModbusRtuChannel(() => new FakeRtuPort(log) { BusyOpens = 1, Respond = _ => DocResponse }, 500, "RTU COM6 9600 8N1");

        Assert.Equal(new ushort[] { 62, 1, 0 }, ch.ReadRegisters(1, true, 405, 3));
    }

    // ⚠️ תשובת שגיאה היא 5 בתים ולא 11. קריאה שממתינה ל-11 הייתה מסתיימת ב"אין תגובה" אחרי חצי שנייה,
    // ומעלימה את קוד השגיאה של הבקר — הסיבה האמיתית.
    [Fact]
    public void AnExceptionResponseOverThePortIsReportedNotTimedOut()
    {
        var log = new List<string>();
        var ch = new ModbusRtuChannel(() => new FakeRtuPort(log) { Respond = _ => WithCrc(0x01, 0x83, 0x02), Chunk = 1 }, 500, "RTU COM6 9600 8N1");

        var sw = Stopwatch.StartNew();
        var ex = Assert.Throws<IOException>(() => ch.ReadRegisters(1, true, 405, 3));
        Assert.Contains("קוד שגיאה 2", ex.Message);
        Assert.True(sw.ElapsedMilliseconds < 400, $"{sw.ElapsedMilliseconds} ms — חיכה למסגרת של 11 בתים");
    }

    [Fact]
    public void SilenceIsAReportedTimeoutWithinTheDeadline()
    {
        var log = new List<string>();
        var ch = new ModbusRtuChannel(() => new FakeRtuPort(log) { Respond = _ => null }, 300, "RTU COM6 9600 8N1");

        var sw = Stopwatch.StartNew();
        var ex = Assert.Throws<IOException>(() => ch.ReadRegisters(1, true, 405, 3));
        Assert.Contains("אין תגובה", ex.Message);
        Assert.True(sw.ElapsedMilliseconds < 2000, $"{sw.ElapsedMilliseconds} ms");
        Assert.Equal("close", log.Last());                 // גם כשל סוגר את הפורט
    }

    // ⚠️ כבל שעבר לשקע אחר משנה את מספר ה-COM. ההודעה אומרת אילו פורטים קיימים — זה מה שצריך לתקן.
    [Fact]
    public void AMissingPortSaysWhichPortsExist()
    {
        var log = new List<string>();
        var ch = new ModbusRtuChannel(() => new FakeRtuPort(log) { OpenError = new IOException("The port 'COM6' does not exist.") },
            500, "RTU COM6 9600 8N1");

        var ex = Assert.Throws<IOException>(() => ch.ReadRegisters(1, true, 405, 3));
        Assert.Contains("COM6", ex.Message);
        Assert.True(ex.Message.Contains("פורטים שקיימים במחשב") || ex.Message.Contains("אין במחשב פורט COM"), ex.Message);
    }

    // ---------------- מקצה לקצה דרך PlcReader ----------------

    [Fact]
    public void PlcReaderReadsTheSiteLayoutOverRtu()
    {
        var log = new List<string>();
        var config = new PlcConfig
        {
            Transport = "rtu", ComPort = "COM6", BaudRate = 9600, Parity = "none", StopBits = 1,
            FunctionCode = 3, CycleRegister = 405, ModeRegister = 406, CardRegister = 407,
        };
        using var reader = new PlcReader(config, () => new FakeRtuPort(log) { Respond = _ => DocResponse, Chunk = 4 });

        PlcReading r = reader.Read();

        Assert.Equal(62, r.CycleCounter);
        Assert.Equal(1, r.Mode);
        Assert.Equal("", r.CardNumber);                    // 0 = אין כרטיס, כמו בכל האתרים
        Assert.Equal(DocRequest, FakeRtuPort.LastWritten); // בקשה אחת, בדיוק של המסמך
        Assert.Equal(1, log.Count(x => x == "write"));
    }

    // ⚠️ הבדיקה הזו עברה גם בלי השמירה עצמה (מוטציה שרדה, 20/10/2026): הקריאה נכשלה על פורט ריק, ושורת
    // היעד שבהודעה אמרה "לא הוגדר פורט COM" בעצמה. מה שהשמירה עושה באמת — **לא מנסה לפתוח פורט ריק**, ואומרת
    // איפה מגדירים. שני אלה נבדקים עכשיו.
    [Fact]
    public void PlcReaderWithoutAComPortSaysWhatIsMissingAndOpensNothing()
    {
        var log = new List<string>();
        using var reader = new PlcReader(new PlcConfig { Transport = "rtu", ComPort = " " }, () => new FakeRtuPort(log));
        var ex = Assert.ThrowsAny<Exception>(() => reader.Read());
        Assert.Contains("יש לבחור אותו בהגדרות → רגיסטרים", ex.Message);
        Assert.DoesNotContain("open", log);
    }

    // ---------------- הגדרה, הישרדות שדרוג, שורת היעד ----------------

    [Fact]
    public void RtuIsAKnownTransportAndIsNotUdp()
    {
        var plc = new PlcConfig { Transport = " RTU " };
        Assert.True(plc.UseRtu);
        Assert.False(plc.UseUdp);
        Assert.True(plc.TransportIsKnown);
    }

    [Fact]
    public void TheSerialSettingsAreNormalisedNotTrusted()
    {
        var s = new PlcConfig { ComPort = " com6 ", BaudRate = 0, Parity = "EVEN", StopBits = 3 }.Rtu;
        Assert.Equal(new RtuSettings("COM6", 9600, "even", 1), s);
        Assert.Equal("none", new PlcConfig { Parity = "mark" }.Rtu.Parity);
    }

    // ⚠️ המתקין מאפס את ההגדרות בכל התקנה. אתר RTU שחזר ל-TCP, או שאיבד את הפורט, הוא אתר שאינו קורא.
    [Fact]
    public void AnUpgradeKeepsTheRtuTransportAndTheSerialSettings()
    {
        var field = new SiteConfig { SiteId = "1501" };
        field.Plc.Transport = "rtu";
        field.Plc.ComPort = "COM6";
        field.Plc.BaudRate = 19200;
        field.Plc.Parity = "even";
        field.Plc.StopBits = 2;

        SiteConfig after = ConfigStore.BuildResetConfig(field);

        Assert.True(after.Plc.UseRtu);
        Assert.Equal(new RtuSettings("COM6", 19200, "even", 2), after.Plc.Rtu);
    }

    [Fact]
    public void ThePlcTargetLineDescribesTheSerialPortNotAnIp()
    {
        var plc = new PlcConfig { Transport = "rtu", ComPort = "COM6", FunctionCode = 3, CycleRegister = 405, ModeRegister = 406, CardRegister = 407 };
        string line = PlcTargetLine.Describe(plc);
        Assert.StartsWith("RTU COM6 9600 8N1 | FC=0x03 | registers MODE=406 Card=407 Cycle=405", line);
        Assert.DoesNotContain("192.168", line);
        Assert.Contains("לא הוגדר פורט COM", PlcTargetLine.Describe(new PlcConfig { Transport = "rtu" }));
    }
}

/// <summary>פורט טורי מדומה: עונה לבקשה, מוסר את התשובה בחלקים, ורושם open/discard/write/read/close.</summary>
internal sealed class FakeRtuPort : IRtuPort
{
    private readonly List<string> _log;
    private readonly Queue<byte> _pending = new();
    public static byte[]? LastWritten;

    public FakeRtuPort(List<string> log) => _log = log;

    public Func<byte[], byte[]?> Respond { get; init; } = _ => null;
    public int Chunk { get; init; } = 3;
    public int BusyOpens { get; set; }
    public Exception? OpenError { get; init; }

    // ⚠️ "תפוס" נספר על פני כל הפורטים שנוצרים לאותה קריאה — הערוץ פותח שוב את אותו מופע
    public void Open()
    {
        _log.Add("open");
        if (BusyOpens-- > 0) throw new UnauthorizedAccessException("Access to the port 'COM6' is denied.");
        if (OpenError is not null) throw OpenError;
    }

    public void DiscardInBuffer() { _log.Add("discard"); _pending.Clear(); }

    public void Write(byte[] buffer, int offset, int count)
    {
        _log.Add("write");
        byte[] req = buffer.Skip(offset).Take(count).ToArray();
        LastWritten = req;
        byte[]? answer = Respond(req);
        if (answer is not null) foreach (byte b in answer) _pending.Enqueue(b);
    }

    public int Read(byte[] buffer, int offset, int count, int timeoutMs)
    {
        _log.Add("read");
        if (_pending.Count == 0) { Thread.Sleep(Math.Min(timeoutMs, 50)); throw new TimeoutException(); }
        int n = Math.Min(Math.Min(count, Chunk), _pending.Count);
        for (int i = 0; i < n; i++) buffer[offset + i] = _pending.Dequeue();
        return n;
    }

    public void Dispose() => _log.Add("close");
}
