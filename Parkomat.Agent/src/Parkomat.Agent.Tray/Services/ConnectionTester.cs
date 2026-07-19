using System.Net.Sockets;
using MQTTnet;
using NModbus;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Tray.Services;

/// <summary>
/// תוצאת בדיקת חיבור: הצלחה/כשל + הודעה קריאה בעברית לטכנאי.
/// </summary>
public class TestResult
{
    public bool Success { get; init; }
    public string Message { get; init; } = "";
}

/// <summary>
/// בודק על-פי דרישה, מתוך ה-Tray, את שני החיבורים שחשובים לטכנאי:
///  1. ה-PLC (Modbus/TCP) — האם הבקר בכלל נגיש וקורא.
///  2. ה-HiveMQ (MQTT + TLS) — חיבור *ישיר* לענן, כי זה מה שהטכנאי צריך לאמת
///     (ה-Agent עצמו עובד דרך Mosquitto מקומי, אז נתק ל-HiveMQ לא נראה משם).
/// שתי הבדיקות אף פעם לא זורקות — הן תמיד מחזירות TestResult.
/// </summary>
public static class ConnectionTester
{
    private const int PlcTimeoutSeconds = 5;
    private const int HiveTimeoutSeconds = 10;

    /// <summary>בודק חיבור ל-PLC: חיבור TCP + קריאת Modbus אחת, עם timeout של ~5 שניות.</summary>
    public static Task<TestResult> TestPlcAsync(PlcConfig plc)
    {
        // NModbus סינכרוני — מריצים על thread רקע כדי לא לתקוע את ה-UI.
        return Task.Run(() =>
        {
            if (string.IsNullOrWhiteSpace(plc.IpAddress))
                return new TestResult { Success = false, Message = "לא הוגדרה כתובת IP ל-PLC בהגדרות." };

            try
            {
                using var tcp = new TcpClient();
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(PlcTimeoutSeconds));

                try
                {
                    tcp.ConnectAsync(plc.IpAddress, plc.Port, cts.Token).AsTask().GetAwaiter().GetResult();
                }
                catch (OperationCanceledException)
                {
                    return new TestResult
                    {
                        Success = false,
                        Message = $"פסק זמן: אין תגובה מ-{plc.IpAddress}:{plc.Port} תוך {PlcTimeoutSeconds} שניות."
                    };
                }

                tcp.ReceiveTimeout = PlcTimeoutSeconds * 1000;
                tcp.SendTimeout = PlcTimeoutSeconds * 1000;

                var master = new ModbusFactory().CreateMaster(tcp);
                master.Transport.ReadTimeout = PlcTimeoutSeconds * 1000;
                master.Transport.WriteTimeout = PlcTimeoutSeconds * 1000;

                // קריאת register אחד (FC04) — מאמת שזה באמת PLC שמדבר Modbus.
                master.ReadInputRegisters(1, (ushort)plc.ModeRegister, 1);

                return new TestResult
                {
                    Success = true,
                    Message = $"מחובר ל-PLC בכתובת {plc.IpAddress}:{plc.Port}, וקריאת Modbus (register {plc.ModeRegister}) הצליחה."
                };
            }
            catch (Exception ex)
            {
                return new TestResult { Success = false, Message = $"החיבור ל-PLC נכשל: {Describe(ex)}" };
            }
        });
    }

    /// <summary>בודק חיבור *ישיר* ל-HiveMQ עם TLS ופרטי ההתחברות מההגדרות, timeout ~10 שניות.</summary>
    public static async Task<TestResult> TestHiveMqAsync(MqttConfig mqtt)
    {
        if (string.IsNullOrWhiteSpace(mqtt.Host))
            return new TestResult { Success = false, Message = "לא הוגדרה כתובת HiveMQ בהגדרות." };

        IMqttClient? client = null;
        try
        {
            client = new MqttClientFactory().CreateMqttClient();

            var optionsBuilder = new MqttClientOptionsBuilder()
                .WithTcpServer(mqtt.Host, mqtt.Port)
                .WithCredentials(mqtt.Username, mqtt.Password)
                .WithClientId("parkomat-connection-tester")
                .WithTimeout(TimeSpan.FromSeconds(HiveTimeoutSeconds));

            // TLS תמיד — הבדיקה חייבת לבדוק את אותו חיבור שהמערכת באמת עושה.
            // אילו הייתה בודקת חיבור לא מוצפן, היא הייתה מדווחת "הצליח" על נתיב
            // שאינו הנתיב האמיתי — והטכנאי היה עוזב את האתר בטוח שהכול תקין.
            optionsBuilder = optionsBuilder.WithTlsOptions(o =>
            {
                o.UseTls(true);

                // זו בדיקת אבחון (נגישות + פרטי-התחברות), לא גבול אבטחה.
                // הנתיב האמיתי מאמת את תעודת HiveMQ דרך cacert.pem של Mosquitto;
                // כאן אין לנו את שרשרת התעודות, אז לא נכשלים *רק* על אימות התעודה —
                // אחרת הבדיקה מציגה "נכשל" בזמן שהמערכת עובדת (false negative).
                // שאר הכשלים האמיתיים (host שגוי, סיסמה שגויה, אין רשת, סירוב חיבור)
                // עדיין נכשלים כרגיל: הם אינם קשורים לאימות התעודה.
                o.WithCertificateValidationHandler(_ => true);
            });

            var options = optionsBuilder.Build();

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(HiveTimeoutSeconds));
            var response = await client.ConnectAsync(options, cts.Token);

            if (response.ResultCode == MqttClientConnectResultCode.Success)
            {
                return new TestResult
                {
                    Success = true,
                    Message = $"החיבור ל-HiveMQ בכתובת {mqtt.Host}:{mqtt.Port} הצליח (TLS)."
                };
            }

            return new TestResult
            {
                Success = false,
                Message = $"HiveMQ דחה את החיבור: {response.ResultCode}" +
                          (string.IsNullOrEmpty(response.ReasonString) ? "" : $" ({response.ReasonString})")
            };
        }
        catch (OperationCanceledException)
        {
            return new TestResult
            {
                Success = false,
                Message = $"פסק זמן: אין תגובה מ-HiveMQ תוך {HiveTimeoutSeconds} שניות."
            };
        }
        catch (Exception ex)
        {
            return new TestResult { Success = false, Message = $"החיבור ל-HiveMQ נכשל: {Describe(ex)}" };
        }
        finally
        {
            try { if (client is { IsConnected: true }) await client.DisconnectAsync(); }
            catch { /* ניתוק שקט */ }
            client?.Dispose();
        }
    }

    // מחלץ סיבה קריאה מהחריגה (כולל חריגות מקוננות, כמו SocketException מתחת ל-TLS).
    private static string Describe(Exception ex) => ex.GetBaseException().Message;
}
