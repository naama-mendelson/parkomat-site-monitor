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

            // קוראים כל register בנפרד, לפי הכתובות מההגדרות.
            ushort mode = ReadRegister(slaveId, _config.ModeRegister);
            // מספר הכרטיס נקרא מרגיסטר בודד (16 ביט, עד 65535). אושר מול האתר
            // שמספרי הכרטיס לא חורגים מהטווח הזה, ולכן אין צורך ברגיסטר שני.
            ushort card = ReadRegister(slaveId, _config.CardRegister);
            ushort cycle = ReadRegister(slaveId, _config.CycleRegister);

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