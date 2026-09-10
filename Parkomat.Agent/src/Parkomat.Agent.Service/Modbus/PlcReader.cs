using NModbus;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Modbus;
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
    private ModbusUdpChannel? _udpChannel;
    private IModbusMaster? _master;

    public PlcReader(PlcConfig config)
    {
        _config = config;
    }

    // ============================================================
    // ⚠️ "מחובר" ב-UDP אינו אותה שאלה כמו ב-TCP
    // ============================================================
    // ב-TCP יש לחיצת יד, ולכן `Connected` באמת אומר שהצד השני קיים.
    // ב-UDP אין חיבור: `UdpClient.Connect` רק קובע יעד ברירת מחדל, והוא
    // מצליח גם מול כתובת שאין בה דבר. לכן כאן הוא עונה רק על "האם
    // הכנתי socket", ו**כשל אמיתי מתגלה כ-timeout בקריאה**, לא כאן.
    //
    // זה בסדר, כי הלולאה ב-Worker ממילא סופרת קריאות שנכשלו ולא בודקת
    // את הדגל הזה — אבל מי שיסתמך עליו כדי לענות "האם ה-PLC חי" יקבל
    // תשובה נכונה ב-TCP ושגויה ב-UDP.
    public bool IsConnected => _config.UseUdp
        ? _udpChannel is not null
        : _tcpClient?.Connected ?? false;

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

        if (_config.UseUdp)
        {
            ConnectUdp();
            return;
        }

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
    /// פותח את צד ה-UDP. בקרים מסוימים חושפים Modbus מעל UDP בלבד.
    ///
    /// ============================================================
    /// ⚠️ אין כאן timeout לחיבור, וזה לא השמטה
    /// ============================================================
    /// ב-UDP אין לחיצת יד: <c>Connect</c> רק קובע יעד ברירת מחדל ומצליח
    /// מיידית גם מול כתובת שאין בה כלום. לכן <c>ConnectTimeoutMs</c> אינו
    /// רלוונטי כאן, ו**כשל מתגלה רק ב-timeout של הקריאה** —
    /// <c>IoTimeoutMs</c> הוא מה שמגן, ולכן הוא נקבע על שני המקומות:
    /// ה-socket עצמו וה-transport של NModbus.
    ///
    /// ⚠️ <c>Connect</c> **חובה**, לא נוחות: NModbus דורשת יעד קבוע
    /// ("UdpClient must be bound to a default remote host").
    ///
    /// ⚠️ <b>וכאן ישבה הנחה שגויה, שעלתה יום שלם בשטח.</b> נכתב כאן
    /// ש-NModbus מאמתת את מזהה הטרנזקציה ולכן "לא לכתוב כאן התאמה
    /// משלנו". הבקר באתר 2222 מחזיר <b>אפס</b> במזהה הטרנזקציה
    /// <b>וגם אפס בשדה האורך</b> — כלומר הכלי שסמכנו עליו אינו קיים,
    /// ו-NModbus נשברת על הדטגרם לגמרי (ראה <c>ModbusUdpChannel</c>).
    ///
    /// ⚠️ לכן ה-UDP אינו עובר יותר דרך NModbus כלל. ההגנה על זיווג
    /// תשובות היא <b>ריקון שאריות לפני כל שליחה</b>, שאינו תלוי בשדה
    /// שהבקר ממלא נכון.
    /// </summary>
    private void ConnectUdp()
    {
        _udpChannel = new ModbusUdpChannel(_config.IpAddress, _config.Port, IoTimeoutMs);
    }

    // ============================================================
    // ⚠️ כמה זמן עולה קריאה שנכשלה — וזה מספר שכבר כויל פעם אחת בכאב
    // ============================================================
    // ה-watchdog של ה-Tray מכריז "תקוע" אחרי 30 שניות בלי סימן חיים
    // (‏RestartPolicy.WedgedAfterSeconds עם דגימה של שנייה), וסימן החיים
    // נכתב **בראש כל סבב** — כלומר המרווח בין שני סימני חיים הוא בדיוק
    // אורך סבב אחד, שנשלט על ידי קריאת PLC שנכשלת.
    //
    // ⚠️ וזה בדיוק היחס שכבר עלה לנו פעם: הסוכן נהרג 12 שניות לפני
    // שהספיק לדווח `state: error`, וההריגה איפסה את מונה הכשלים — כך
    // ש**התקלה לא דווחה מעולם**. WatchdogVsPlcErrorTests נועל את זה.
    //
    // ⚠️ **ו-UDP שובר את הכיול בשקט.** NModbus מנסה שוב על אי-תשובה
    // (‏Retries=3, כלומר 4 ניסיונות), ולכן קריאה שנכשלה עולה פי ארבעה:
    // **נמדד — TCP 3,010ms מול UDP 12,830ms** עם אותו IoTimeoutMs.
    // עדיין מתחת ל-30, אבל המרווח מצטמצם מ-27 שניות ל-17, ומחשב אתר
    // עמוס יכול לאכול את ההפרש.
    //
    // הפתרון אינו לוותר על הניסיונות החוזרים — הם **הסיבה** ש-UDP עובד
    // בכלל, כי דטגרמה אבודה אינה משודרת מחדש בשכבה שמתחת. במקום זה
    // מחלקים את אותה תקרה בין הניסיונות: הכישלון עולה כמו ב-TCP,
    // ובדרך יש **ארבע** הזדמנויות להתאושש מאיבוד במקום אחת.
    //
    // בקר ב-LAN עונה במילישניות, אז 750ms לניסיון הוא נדיב.
    private const int UdpRetries = 3;   // ברירת המחדל של NModbus, מפורשת כאן כדי שהחישוב יהיה קריא
    private const int UdpAttemptTimeoutMs = IoTimeoutMs / (UdpRetries + 1);

    /// <summary>
    /// קורא את שלושת ה-registers מה-PLC ומחזיר PlcReading.
    /// זורק חריגה אם החיבור נכשל — מי שקורא צריך לטפל בזה.
    /// </summary>
    // ⚠️ שמונה ולא 125 (תקרת Modbus): שלושת הרגיסטרים שאנחנו קוראים
    // יושבים בפועל צמודים זה לזה בכל האתרים, וטווח רחב יותר פירושו
    // קריאת כתובות שאיש לא ביקש — ובבקר שחלקן אינן ממופות בו, כשל.
    private const int MaxBlockSpan = 8;

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

            // ============================================================
            // ⚠️ מערכת שנייה — נכנסת לאותו טווח, ולכן לאותה בקשה
            // ============================================================
            // באתר פלורנטין הרגיסטרים הם 290..294 — טווח של חמישה, מתחת
            // לתקרת השמונה. כלומר שתי המערכות נדגמות **באותו רגע בדיוק**,
            // בלי בקשה נוספת ובלי סיכון שמצב של מערכת 1 יזווג עם רכב של
            // מערכת 2. זה לא במקרה: אותו שיקול שבגללו שלושת הרגיסטרים
            // של מערכת אחת נקראים יחד.
            bool two = _config.HasSecondSystem;
            int mode2Addr = _config.ModeRegister2;
            int card2Addr = _config.CardRegister2;

            if (two)
            {
                ValidateRegister(mode2Addr, nameof(_config.ModeRegister2));
                ValidateRegister(card2Addr, nameof(_config.CardRegister2));
            }

            ushort mode, card, cycle;
            ushort? mode2 = null, card2 = null;

            // ============================================================
            // ⚠️ בלוק אחד לכל טווח קצר — לא רק לסדר עולה מדויק
            // ============================================================
            // התנאי כאן היה `cardAddr == modeAddr + 1 && cycleAddr == modeAddr + 2`,
            // כלומר **רק** הסידור העולה המדויק. אתר 2222 מוגדר
            // `MODE=106 Card=107 Cycle=105` — **אותם שלושה רגיסטרים בדיוק**,
            // בסדר אחר — ולכן הוא נפל למסלול של שלוש קריאות נפרדות.
            //
            // ⚠️ **ומה שהמסלול הזה עושה ברשת אמיתית הוא הבעיה:** שלוש
            // בקשות/תשובות נפרדות מעל UDP, בלי הבטחת סדר, כשתשובה מאוחרת
            // לבקשה קודמת מגיעה כשהבאה כבר בדרך.
            //
            // ⚠️ **מה שלא הוכח, ולא ייטען כאן:** ייחסתי את
            // `Index was outside the bounds of the array` למערך ריק שחוזר
            // מ-NModbus. במעבדה זה **הופרך** — סלייב שמחזיר פחות רגיסטרים
            // ממה שהתבקש מפיל את NModbus בהודעה משלה
            // (`Unexpected byte count. Expected 6, received 2`). המנגנון
            // המדויק של הכשל בשטח עדיין אינו ידוע, ולכן הוא **אינו** ההצדקה
            // לשינוי כאן; ההצדקה היא זו שלמטה, והיא עומדת בפני עצמה.
            //
            // ⚠️ **וגם מעל loopback אי אפשר לשחזר את הכשל** — שלוש קריאות
            // מצליחות שם תמיד. לכן הבדיקות אינן משוות ערכים אלא **סופרות
            // בקשות**: `TheThreeRegistersCostOneRequestNotThree`. מוטציה
            // שהחזירה את התנאי המקורי עברה ירוקה עד שהספירה נוספה.
            //
            // הטווח, ולא הסדר, הוא מה שקובע: 105..107 הם שלושה רגיסטרים
            // ואין שום סיבה לשלוש בקשות. כאן קוראים את הטווח כולו פעם
            // אחת ובוחרים לפי היסט — תצלום אטומי, גם כשהסדר אינו עולה.
            int lo = Math.Min(modeAddr, Math.Min(cardAddr, cycleAddr));
            int hi = Math.Max(modeAddr, Math.Max(cardAddr, cycleAddr));

            if (two)
            {
                lo = Math.Min(lo, Math.Min(mode2Addr, card2Addr));
                hi = Math.Max(hi, Math.Max(mode2Addr, card2Addr));
            }

            int span = hi - lo + 1;

            // ⚠️ **תקרה, כי טווח אינו מספר.** `MODE=100 Cycle=300` הם 201
            // רגיסטרים — מעל תקרת ה-125 של Modbus, וגם קריאה של מאתיים
            // כתובות שאיש לא ביקש, שחלקן עלולות לא להיות ממופות בבקר.
            // מעבר לתקרה חוזרים לקריאות נפרדות, על כל חסרונן.
            if (span <= MaxBlockSpan)
            {
                ushort[] r = ReadBlock(slaveId, lo, span);

                // ⚠️ **הגנה, ולא תיקון של תקלה שנצפתה.** דרך NModbus התנאי
                // הזה אינו ניתן להגעה — היא בודקת את אורך המסגרת בעצמה
                // וזורקת קודם. הוא נשאר כי הגישה למטה היא לפי היסט, ומערך
                // קצר היה חוזר לחריגה חסרת הפשר שהתחלנו ממנה. **אין בדיקה
                // שמכסה אותו**, וזה נאמר במפורש כדי שאיש לא יחשוב שיש.
                if (r.Length < span)
                    throw new InvalidOperationException(
                        $"הבקר החזיר {r.Length} רגיסטרים במקום {span} "
                        + $"עבור טווח {lo}..{hi}");

                mode = r[modeAddr - lo];
                card = r[cardAddr - lo];
                cycle = r[cycleAddr - lo];

                if (two)
                {
                    mode2 = r[mode2Addr - lo];
                    card2 = r[card2Addr - lo];
                }
            }
            else
            {
                mode = ReadRegister(slaveId, modeAddr);
                card = ReadRegister(slaveId, cardAddr);
                cycle = ReadRegister(slaveId, cycleAddr);

                if (two)
                {
                    mode2 = ReadRegister(slaveId, mode2Addr);
                    card2 = ReadRegister(slaveId, card2Addr);
                }
            }

            return new PlcReading
            {
                Mode = mode,
                CardNumber = card == 0 ? "" : card.ToString(),
                CycleCounter = cycle,

                // ⚠️ null ולא 0 — אפס הוא MODE חוקי (תחזוקה).
                Mode2 = mode2,
                CardNumber2 = card2 is null ? null : (card2 == 0 ? "" : card2.Value.ToString()),
            };
        }
        catch (Exception ex)
        {
            // ⚠️ **החריגה נעטפת בתיאור היעד.** ‏`Worker` רושם `ex.Message`
            // בלבד, ולכן בשטח נראתה שורה שאינה מזכירה בקר, כתובת, תעבורה,
            // פקודה או רגיסטר: *"PLC read failed: Index was outside the
            // bounds of the array"*. שורת "PLC target" נכתבת פעם אחת בעלייה
            // ובקובץ שהתגלגל היא כבר איננה. מעכשיו כל כשל קריאה נושא את
            // היעד המלא איתו.
            //
            // קריאה נכשלה (timeout / socket half-open — ה-PLC מקבל TCP אך הפסיק
            // לענות). במצב הזה _tcpClient.Connected עלול להישאר true, כך ש-
            // EnsureConnected לא היה בונה את החיבור מחדש והכשל היה נמשך ללא סוף.
            // סוגרים מפורשות כדי שהדגימה הבאה תפתח socket חדש ותוכל להתאושש.
            Dispose();

            throw new InvalidOperationException(
                $"קריאה מהבקר נכשלה [{PlcTargetLine.Describe(_config)}]: {ex.Message}", ex);
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
            ushort[] raw = ReadBlock(1, addr, count);
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

    // ============================================================
    // ⚠️ **שער אחד לכל קריאה — וזו הנקודה**
    // ============================================================
    // קודם היו כאן **שלוש** קריאות נפרדות ל-`ReadInputRegisters`:
    // הבלוק הרצוף, טקסט התקלה, ורגיסטר בודד. בקר שחושף רק
    // Holding Registers דורש ש**כולן** ישתנו, ושלוש נקודות נפרדות
    // הן שלוש הזדמנויות לשכוח אחת — והנשכחת תהיה טקסט התקלה,
    // שנקרא רק כשיש תקלה ולכן הכשל שלו מתגלה באיחור רב.
    //
    // אותו נימוק בדיוק כמו "הטפסים עורכים במקום": רשימה שצריך
    // לזכור לעדכן היא רשימה שמישהו לא יעדכן.
    private ushort[] ReadBlock(byte slaveId, int address, int count)
    {
        // ⚠️ UDP אינו עובר דרך NModbus — הבקר באתר 2222 שולח כותרת MBAP
        // עם אורך אפס, והספרייה נשברת עליה. הפיצול הוא בדיוק בגבול
        // הבעיה: TCP עובד ב-20 האתרים האחרים ונשאר כפי שהוא.
        if (_udpChannel is not null)
            return _udpChannel.ReadRegisters(slaveId, _config.UseHoldingRegisters, address, count);

        return _config.UseHoldingRegisters
            ? _master!.ReadHoldingRegisters(slaveId, (ushort)address, (ushort)count)   // FC 03
            : _master!.ReadInputRegisters(slaveId, (ushort)address, (ushort)count);    // FC 04
    }

    // קורא רגיסטר בודד ומחזיר את הערך.
    //
    // ⚠️ **אורך התשובה נבדק.** `values[0]` על מערך ריק זרק
    // `Index was outside the bounds of the array` — הודעה שאינה מזכירה
    // בקר, רגיסטר או רשת, ושעלתה בשטח באתר 2222. טכנאי שקורא אותה אינו
    // יודע אפילו באיזו שכבה להתחיל לחפש.
    private ushort ReadRegister(byte slaveId, int address)
    {
        ushort[] values = ReadBlock(slaveId, address, 1);

        if (values.Length == 0)
            throw new InvalidOperationException(
                $"הבקר לא החזיר ערך לרגיסטר {address} "
                + $"(FC=0x{(_config.UseHoldingRegisters ? "03" : "04")})");

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

        // ⚠️ **שני הצדדים משוחררים תמיד, בלי לבדוק את ההגדרה.** `Dispose`
        // נקרא גם מ-`EnsureConnected` לפני פתיחה מחדש, ואם מישהו יערוך את
        // `Transport` בזמן ריצה, ניקוי לפי ההגדרה **הנוכחית** היה משאיר את
        // ה-socket של התעבורה הקודמת פתוח לנצח. שדה null זול לשחרר.
        _udpChannel?.Dispose();
        _udpChannel = null;
    }
}