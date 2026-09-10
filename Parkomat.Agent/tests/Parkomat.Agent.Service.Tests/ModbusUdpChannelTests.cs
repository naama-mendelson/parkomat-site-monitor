using System.Net;
using System.Net.Sockets;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Modbus;
using Parkomat.Agent.Service.Modbus;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>הדטגרם האמיתי מאתר 2222, בית-בבית.</b>
///
/// <para>נלכד ב-10/09/2026 בשליחת הבקשה המדויקת של הסוכן:</para>
///
/// <code>
/// 00-00  00-00  00-00  01  03  06  02-86 00-01 00-07
///  txId   proto  אורך  unit FC  bc   646    1     7
/// </code>
///
/// <para>שדה האורך <b>אפס</b>, מזהה הטרנזקציה <b>אפס</b> — והנתונים
/// מדויקים. NModbus סומכת על שדה האורך, מקצה מערך ריק, וניגשת ל-
/// <c>frame[1]</c>: <c>Index was outside the bounds of the array</c>.</para>
///
/// <para>⚠️ <b>וזו הסיבה שהבדיקות האלה עובדות על בתים ולא על "בקר".</b>
/// סלייב תקני של NModbus לעולם לא היה מייצר את הכותרת הזו, ולכן שום
/// בדיקה מול סלייב כזה לא הייתה תופסת את התקלה — וגם לא תפסה, במשך
/// יום שלם.</para>
/// </summary>
public class ModbusUdpChannelTests
{
    // הדטגרם כפי שנלכד בשטח.
    private static readonly byte[] FieldResponse =
    {
        0x00, 0x00,             // מזהה טרנזקציה — הבקר מחזיר אפס
        0x00, 0x00,             // מזהה פרוטוקול
        0x00, 0x00,             // ⚠️ אורך = 0 — כאן NModbus נשברת
        0x01,                   // unit
        0x03,                   // FC
        0x06,                   // מונה בתים
        0x02, 0x86,             // 646
        0x00, 0x01,             // 1
        0x00, 0x07,             // 7
    };

    [Fact]
    public void TheFieldDatagramIsReadCorrectlyDespiteTheZeroLengthHeader()
    {
        ushort[] v = ModbusUdpChannel.Parse(FieldResponse, 0x03, 3, 105);

        Assert.Equal(new ushort[] { 646, 1, 7 }, v);
    }

    // ⚠️ הבקשה נבדקת בית-בבית מול מה ש-modpoll שולח בהצלחה לבקר הזה.
    [Fact]
    public void TheRequestMatchesWhatTheControllerAnswers()
    {
        byte[] q = ModbusUdpChannel.BuildRequest(1, 1, 0x03, 105, 3);

        Assert.Equal(new byte[]
        {
            0x00, 0x01,   // מזהה טרנזקציה
            0x00, 0x00,   // פרוטוקול
            0x00, 0x06,   // אורך
            0x01,         // unit
            0x03,         // FC
            0x00, 0x69,   // 105
            0x00, 0x03,   // שלושה רגיסטרים
        }, q);
    }

    // ⚠️ תשובת שגיאה של Modbus **אינה** תשובה קצרה: הביט העליון של קוד
    // הפונקציה דלוק. בלי הזיהוי היינו קוראים את קוד השגיאה כמונה בתים
    // ומחזירים זבל כאילו הוא נתון מהבקר.
    [Fact]
    public void AModbusExceptionResponseIsNotMistakenForData()
    {
        byte[] err = { 0, 0, 0, 0, 0, 0, 0x01, 0x83, 0x02 };

        var ex = Assert.Throws<IOException>(() => ModbusUdpChannel.Parse(err, 0x03, 3, 105));

        Assert.Contains("2", ex.Message);
        Assert.Contains("105", ex.Message);
    }

    [Fact]
    public void AByteCountThatDoesNotMatchTheRequestIsRejected()
    {
        byte[] two = { 0, 0, 0, 0, 0, 0, 0x01, 0x03, 0x04, 0x02, 0x86, 0x00, 0x01 };

        var ex = Assert.Throws<IOException>(() => ModbusUdpChannel.Parse(two, 0x03, 3, 105));

        Assert.Contains("4", ex.Message);
    }

    [Fact]
    public void ATruncatedDatagramIsRejectedRatherThanIndexed()
    {
        // מונה הבתים מבטיח 6, אבל יש רק 2 — בדיוק המצב שהחזיר
        // "Index was outside the bounds of the array" מהספרייה.
        byte[] cut = { 0, 0, 0, 0, 0, 0, 0x01, 0x03, 0x06, 0x02, 0x86 };

        var ex = Assert.Throws<IOException>(() => ModbusUdpChannel.Parse(cut, 0x03, 3, 105));

        Assert.DoesNotContain("Index was outside", ex.Message);
    }

    // ============================================================
    // ⚠️ מקצה לקצה מול בקר שמתנהג **בדיוק** כמו זה שבשטח
    // ============================================================
    // הבדיקות שלמעלה מוכיחות את הפענוח. זו מוכיחה את המסלול כולו —
    // PlcReader, הערוץ, ה-socket — מול משיב UDP גולמי ששולח כותרת עם
    // אורך אפס. סלייב של NModbus אינו יכול לשחזר את זה.
    [Fact]
    public void PlcReaderReadsTheSiteLayoutFromAControllerWithAZeroLengthHeader()
    {
        int port = FreePort();
        using var responder = new UdpClient(port);
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        Task server = Task.Run(() =>
        {
            var ep = new IPEndPoint(IPAddress.Any, 0);
            while (!cts.IsCancellationRequested)
            {
                byte[] req;
                try { req = responder.Receive(ref ep); }
                catch { return; }

                int start = (req[8] << 8) | req[9];
                int count = (req[10] << 8) | req[11];

                // ערכי האתר: 105=646 (מונה), 106=1 (MODE), 107=7 (כרטיס)
                var reg = new Dictionary<int, ushort> { [105] = 646, [106] = 1, [107] = 7 };

                var body = new List<byte> { 0, 0, 0, 0, 0, 0, 0x01, req[7], (byte)(count * 2) };
                for (int i = 0; i < count; i++)
                {
                    ushort v = reg.TryGetValue(start + i, out ushort found) ? found : (ushort)0;
                    body.Add((byte)(v >> 8));
                    body.Add((byte)(v & 0xFF));
                }

                byte[] answer = body.ToArray();
                responder.Send(answer, answer.Length, ep);
            }
        });

        try
        {
            // הסידור של אתר 2222 — MODE=106 Card=107 Cycle=105
            using var reader = new PlcReader(new PlcConfig
            {
                IpAddress = "127.0.0.1",
                Port = port,
                Transport = "udp",
                FunctionCode = 3,
                ModeRegister = 106,
                CardRegister = 107,
                CycleRegister = 105,
            });

            PlcReading r = reader.Read()!;

            Assert.Equal(1, r.Mode);
            Assert.Equal("7", r.CardNumber);
            Assert.Equal(646, r.CycleCounter);
        }
        finally
        {
            cts.Cancel();
            responder.Dispose();
        }
    }

    // ============================================================
    // ⚠️ תשובה מאוחרת לבקשה קודמת — הסכנה האמיתית של UDP
    // ============================================================
    // ב-UDP אין הבטחת סדר, ותשובה כפולה או מאוחרת מגיעה כשהבקשה הבאה
    // כבר בדרך. אם היא נקראת כתשובה לבקשה החדשה, ה-MODE של רגע אחד
    // מזווג עם המונה של רגע אחר — כלומר **רשומת כניסה או יציאה שגויה**,
    // וזה נתון לקוח שנשמר לתמיד.
    //
    // ⚠️ **וההגנה הרגילה אינה זמינה כאן.** מזהה הטרנזקציה הוא מה שמפריד
    // בין תשובות — והבקר באתר 2222 מחזיר בו אפס תמיד. לכן ההגנה היא
    // ריקון שאריות לפני כל שליחה, ולא התאמה אחריה.
    //
    // המשיב כאן שולח את התשובה **פעמיים** בסבב הראשון, ומשנה את הערך
    // בין סבב לסבב. בלי ריקון, הקריאה השנייה תחזיר את הערך של הראשונה.
    [Fact]
    public void ALateDuplicateAnswerIsNotPairedWithTheNextRequest()
    {
        int port = FreePort();
        using var responder = new UdpClient(port);
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        Task server = Task.Run(() =>
        {
            var ep = new IPEndPoint(IPAddress.Any, 0);
            int round = 0;
            while (!cts.IsCancellationRequested)
            {
                byte[] req;
                try { req = responder.Receive(ref ep); }
                catch { return; }

                round++;
                ushort value = (ushort)(100 + round);
                byte[] answer =
                {
                    0, 0, 0, 0, 0, 0,               // כותרת אפסים, כמו בשטח
                    0x01, req[7], 0x02,
                    (byte)(value >> 8), (byte)(value & 0xFF),
                };

                responder.Send(answer, answer.Length, ep);

                // ⚠️ הסבב הראשון עונה פעמיים — הכפילות היא השארית.
                if (round == 1)
                    responder.Send(answer, answer.Length, ep);
            }
        });

        try
        {
            using var channel = new ModbusUdpChannel("127.0.0.1", port, 3000);

            Assert.Equal(101, channel.ReadRegisters(1, true, 105, 1)[0]);

            // נותנים לכפילות להגיע לפני הבקשה הבאה.
            Thread.Sleep(150);

            // ⚠️ בלי ריקון היה חוזר כאן 101 — הערך של הבקשה **הקודמת**.
            Assert.Equal(102, channel.ReadRegisters(1, true, 105, 1)[0]);
        }
        finally
        {
            cts.Cancel();
            responder.Dispose();
        }
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }
}
