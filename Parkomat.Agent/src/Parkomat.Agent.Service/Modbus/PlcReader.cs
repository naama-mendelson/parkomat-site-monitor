using NModbus;
using Parkomat.Agent.Core.Configuration;
using System.Net.Sockets;

namespace Parkomat.Agent.Service.Modbus;

/// <summary>
/// קורא נתונים מה-PLC דרך Modbus-TCP.
/// אחראי רק על הקריאה הגולמית — פותח חיבור, קורא את שלושת ה-registers,
/// ומחזיר PlcReading. לא מפרש ולא מחליט כלום.
/// מיישם IDisposable כדי לסגור את החיבור בצורה מסודרת.
/// </summary>
public class PlcReader : IDisposable
{
    // כמה מילי-שניות לחכות לחיבור TCP ולתשובת Modbus לפני שמכריזים על כשל.
    // בלי אלה, PLC "תקוע" (מקבל חיבור אך לא עונה) היה חוסם את הלולאה לזמן רב.
    private const int ConnectTimeoutMs = 3000;
    private const int IoTimeoutMs = 3000;

    private readonly PlcConfig _config;

    private TcpClient? _tcpClient;
    private IModbusMaster? _master;

    public PlcReader(PlcConfig config)
    {
        _config = config;
    }

    // האם יש כרגע חיבור פתוח ותקין ל-PLC.
    public bool IsConnected => _tcpClient?.Connected ?? false;

    /// <summary>
    /// מוודא שיש חיבור פתוח ל-PLC. אם אין — פותח אחד חדש.
    /// בטוח לקרוא לזה בכל דגימה; אם כבר מחוברים, לא קורה כלום.
    /// </summary>
    private void EnsureConnected()
    {
        if (IsConnected)
            return;

        // סוגרים שאריות של חיבור קודם, אם יש.
        Dispose();

        _tcpClient = new TcpClient();

        // חיבור עם timeout: אם ה-PLC לא זמין, נכשלים תוך שניות ולא נתקעים
        // על ברירת המחדל הארוכה של מערכת ההפעלה (~21 שניות).
        using (var cts = new CancellationTokenSource(ConnectTimeoutMs))
        {
            try
            {
                _tcpClient.ConnectAsync(_config.IpAddress, _config.Port, cts.Token)
                          .AsTask().GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
                throw new TimeoutException(
                    $"Timed out connecting to PLC at {_config.IpAddress}:{_config.Port} after {ConnectTimeoutMs} ms.");
            }
        }

        // timeout על קריאה/כתיבה ברמת ה-socket.
        _tcpClient.ReceiveTimeout = IoTimeoutMs;
        _tcpClient.SendTimeout = IoTimeoutMs;

        var factory = new ModbusFactory();
        _master = factory.CreateMaster(_tcpClient);

        // timeout ברמת ה-Modbus, שגם הוא לא ייתקע אם ה-PLC לא עונה.
        _master.Transport.ReadTimeout = IoTimeoutMs;
        _master.Transport.WriteTimeout = IoTimeoutMs;
    }

    /// <summary>
    /// קורא את שלושת ה-registers מה-PLC ומחזיר PlcReading.
    /// זורק חריגה אם החיבור נכשל — מי שקורא צריך לטפל בזה.
    /// </summary>
    public PlcReading Read()
    {
        EnsureConnected();

        try
        {
            // ה-slave address של ה-PLC ב-Modbus. בדרך כלל 1 (נהפוך להגדרה בהמשך אם צריך).
            const byte slaveId = 1;

            int modeAddr = _config.ModeRegister;
            int cardAddr = _config.CardRegister;
            int cycleAddr = _config.CycleRegister;

            // כתובת register מחוץ ל-[0,65535] הייתה נגללת בשקט ב-cast ל-ushort
            // (70000→4464) → קריאה מרגיסטר שגוי עם נתונים "סבירים אך לא-נכונים".
            // מכריזים על תקלה ברורה (תיכתב ללוג) במקום להטעות בשקט.
            ValidateRegister(modeAddr, nameof(_config.ModeRegister));
            ValidateRegister(cardAddr, nameof(_config.CardRegister));
            ValidateRegister(cycleAddr, nameof(_config.CycleRegister));

            ushort mode, card, cycle;

            // אם שלוש הכתובות רצופות (ברירת המחדל 290/291/292) — קוראים ב-round-trip
            // *אחד* ⇒ תצלום אטומי. אחרת ה-PLC עלול להתקדם בין קריאות נפרדות ולזווג
            // MODE של רגע אחד עם card/cycle של רגע אחר (רשומת כניסה/יציאה שגויה).
            // מספר הכרטיס הוא 16 ביט (עד 65535) — אושר מול האתר שלא חורג.
            if (cardAddr == modeAddr + 1 && cycleAddr == modeAddr + 2)
            {
                ushort[] r = _master!.ReadInputRegisters(slaveId, (ushort)modeAddr, 3);
                mode = r[0];
                card = r[1];
                cycle = r[2];
            }
            else
            {
                mode = ReadRegister(slaveId, modeAddr);
                card = ReadRegister(slaveId, cardAddr);
                cycle = ReadRegister(slaveId, cycleAddr);
            }

            return new PlcReading
            {
                Mode = mode,
                CardNumber = card == 0 ? "" : card.ToString(),
                CycleCounter = cycle
            };
        }
        catch
        {
            // קריאה נכשלה (timeout / socket half-open — ה-PLC מקבל TCP אך הפסיק
            // לענות). במצב הזה _tcpClient.Connected עלול להישאר true, כך ש-
            // EnsureConnected לא היה בונה את החיבור מחדש והכשל היה נמשך ללא סוף.
            // סוגרים מפורשות כדי שהדגימה הבאה תפתח socket חדש ותוכל להתאושש.
            Dispose();
            throw;
        }
    }

    // מוודא שכתובת register בטווח החוקי של Modbus (0..65535) לפני ה-cast ל-ushort.
    private static void ValidateRegister(int address, string name)
    {
        if (address < 0 || address > 65535)
            throw new ArgumentOutOfRangeException(name, address,
                "כתובת register חייבת להיות בטווח 0..65535.");
    }

    // ============================================================
    // טקסט התקלה — קריאה נפרדת, ובכוונה
    // ============================================================
    // ⚠️ **זו קריאה שנייה ולא אטומית עם ה-MODE.** הכתובות אינן רצופות
    // (2 מול 290) ואי אפשר לאחד אותן ל-round-trip אחד. הטקסט מגיע ממילי-
    // שנייה אחרת מה-MODE.
    //
    // כאן זה מקובל, ולא היה מקובל לכרטיס: תיאור התקלה משתנה כשהתקלה
    // משתנה, ולא בתוך אותה תקלה. הכרטיס לעומת זאת מתחלף בכל מעבר רכב,
    // ולכן שלושת ה-registers שלו נקראים יחד — ראה ReadAsync.
    //
    // ⚠️ **וקוראים רק כשיש תקלה.** 80 registers כל שנייה × 12 אתרים זו
    // תעבורה מיותרת פי 27 מהקריאה הרגילה, על נתון שרלוונטי רק במצב אחד.
    // ההחלטה מתי לקרוא נמצאת ב-Worker, שם ה-MODE ידוע.
    //
    // ⚠️ **כשל כאן אינו מפיל את הקריאה הרגילה.** אם הבקר אינו חושף את
    // הכתובת הזו, או שהקריאה נכשלת מכל סיבה — מחזירים ריק. תיאור תקלה
    // הוא מידע נוסף; זיהוי התקלה עצמה אינו רשאי להיעלם בגללו.
    public FaultText ReadFaultText()
    {
        int addr = _config.FaultTextRegister;
        if (addr <= 0) return FaultText.Empty;      // 0 = התכונה מכובה

        try
        {
            ValidateRegister(addr, nameof(_config.FaultTextRegister));

            // ⚠️ תקרת Modbus היא 125 registers בקריאה אחת. ערך גדול יותר
            // בהגדרות היה נכשל מול הבקר בזמן ריצה — נחתך כאן במקום.
            int count = Math.Clamp(_config.FaultTextMaxChars, 1, 125);

            EnsureConnected();
            ushort[] raw = _master!.ReadInputRegisters(1, (ushort)addr, (ushort)count);
            return FaultTextDecoder.Decode(raw);
        }
        catch
        {
            // ⚠️ **בלי Dispose כאן.** ב-ReadAsync כשל סוגר את החיבור כדי
            // להתאושש מ-socket חצי-פתוח. כאן זה היה מזיק: קריאה שנכשלת רק
            // מפני שהכתובת אינה קיימת בבקר הייתה מפילה את החיבור התקין
            // ומאלצת בנייה מחדש **בכל שנייה שיש בה תקלה**.
            return FaultText.Empty;
        }
    }

    // קורא input register בודד (פקודת Modbus FC 04) ומחזיר את הערך.
    private ushort ReadRegister(byte slaveId, int address)
    {
        // ReadInputRegisters = FC 04, כפי שה-PLC דורש.
        // מחזיר מערך; אנחנו קוראים אחד, אז לוקחים את הראשון.
        ushort[] values = _master!.ReadInputRegisters(slaveId, (ushort)address, 1);
        return values[0];
    }

    /// <summary>סוגר את החיבור ומשחרר משאבים.</summary>
    public void Dispose()
    {
        _master?.Dispose();
        _master = null;

        _tcpClient?.Close();
        _tcpClient?.Dispose();
        _tcpClient = null;
    }
}