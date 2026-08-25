using Parkomat.Agent.Core.Configuration;
using System.Threading;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Time;
using Parkomat.Agent.Service.Diagnostics;
using Parkomat.Agent.Service.Logic;
using Parkomat.Agent.Service.Modbus;
using Parkomat.Agent.Service.Mqtt;

namespace Parkomat.Agent.Service;

/// <summary>
/// הלב הפועם של ה-Agent. רץ ברקע כשירות, ובלולאה:
/// קורא מה-PLC ‹ מעביר למוח ‹ משדר את ההודעות שהמוח החזיר.
/// כולל זיהוי נתק PLC: אם ה-PLC לא מגיב לאורך זמן, משדר state: error.
/// </summary>
public class Worker : BackgroundService
{
    private readonly ILogger<Worker> _logger;

    // כמה קריאות כושלות רצופות עד שמכריזים על תקלת PLC.
    private const int MaxConsecutiveFailures = 10;

    public Worker(ILogger<Worker> logger)
    {
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // --- טעינת הגדרות ---
        SiteConfig config = ConfigStore.Load();
        _logger.LogInformation("=== Parkomat Agent starting ===");
        _logger.LogInformation("Config loaded for site '{SiteId}'", config.SiteId);

        // ============================================================
        // בלי מזהה אתר אין למי לשדר — ועוצרים כאן
        // ============================================================
        // ⚠️ **זה הכשל השקט ביותר במערכת הזו.** בלי מזהה, הנושאים יוצאים
        // `sites//state` ו-`sites//operation` — נושאים תקינים לחלוטין מבחינת
        // MQTT, שהשרת אינו מנוי אליהם ולעולם לא יראה. וכל שכבה אחרת מדווחת
        // הצלחה **אמיתית**: הבקר עונה, Mosquitto מחובר, הגשר ל-HiveMQ עולה,
        // סמל ה-Tray צבעוני. אף אחת מהן אינה בודקת לאן.
        //
        // בשטח זה לא נראה כתקלה אלא כתעלומה: "בבקר כתוב שיש תקשורת,
        // בדשבורד כתוב שאין" — וזה עולה שעות של חיפוש בכיוון הלא נכון.
        //
        // ⚠️ **נשארים בחיים ולא יוצאים.** יציאה הייתה גוררת את ה-Tray
        // להפעיל מחדש בלולאה (RestartPolicy), וכל הפעלה הייתה מוחקת את
        // ההודעה מהלוג לפני שמישהו הספיק לקרוא אותה.
        //
        // ⚠️ **ולא כותבים heartbeat.** זה מה שהופך את השקט לגלוי: הסמל
        // נשאר אפור, הטכנאי פותח "בדוק חיבור", ורואה שם שורה אדומה שמסבירה
        // בדיוק מה חסר. אילו היינו כותבים פעימות, הסמל היה ירוק ושום דבר
        // לא היה מצביע על הבעיה.
        //
        // ההגדרה עצמה כבר חסומה בטופס (SettingsForm מסרב לשמור ריק), ולכן
        // המצב הזה מגיע ממקום אחר: התקנה טרייה שאיש עוד לא פתח בה הגדרות.
        SiteIdCheck idCheck = SiteIdRule.Check(config.SiteId);
        if (!idCheck.IsValid)
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                _logger.LogCritical(
                    "SITE ID IS INVALID — the agent is publishing NOTHING. Configured value: '{SiteId}'. " +
                    "The MQTT topic would be 'sites/{SiteId}/state', which the server is not subscribed " +
                    "to, so the site would look connected here and absent in the dashboard. " +
                    "Fix: tray icon -> Settings -> site number -> Save. " +
                    "Nothing else is broken: the PLC and the cloud connection are unaffected. {Reason}",
                    config.SiteId, config.SiteId, idCheck.Message);

                // כל 5 דקות — מספיק כדי שההודעה תהיה בלוג בכל חלון שמישהו
                // יסתכל בו, ולא כל שנייה, שהיה הופך את הקובץ לבלתי קריא.
                await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
            }
            return;
        }
        _logger.LogInformation(
            "PLC target: {Ip}:{Port} | registers MODE={Mode} Card={Card} Cycle={Cycle} | poll={Poll}ms",
            config.Plc.IpAddress, config.Plc.Port,
            config.Plc.ModeRegister, config.Plc.CardRegister, config.Plc.CycleRegister,
            config.PollIntervalMs);
        // כתובת ה-HiveMQ מגיעה לגשר של Mosquitto — נרשמת לאבחון, בלי הסיסמה.
        // TLS אינו מוצג כערך: הוא תמיד פעיל ואין דרך לכבותו.
        _logger.LogInformation(
            "HiveMQ (via Mosquitto bridge): {Host}:{Port} | TLS=always | user='{User}' (password not logged)",
            config.Mqtt.Host, config.Mqtt.Port, config.Mqtt.Username);

        // --- מוודאים שתעודת ה-CA נמצאת בנתיב ה-ASCII הקבוע (ProgramData) ---
        // מעתיקים אותה מתיקיית Mosquitto שבהתקנה אם צריך. כך Mosquitto (שרץ כתהליך
        // משתמש) קורא אותה מנתיב בלי תווים לא-לטיניים — גם אם שם המשתמש בעברית.
        EnsureCaCertPresent();

        // --- כתיבת קובץ הגישור של Mosquitto לפי ההגדרות ---
        try
        {
            _logger.LogInformation("Writing Mosquitto bridge config to {Path}...", AgentPaths.BridgeConfigFile);
            BridgeConfigWriter.Write(config);
            _logger.LogInformation("Mosquitto bridge config written successfully.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to write bridge config: {Message}", ex.Message);
        }

        // בדיקת בטיחות לתעודת ה-CA: bridge.conf מפנה ל-AgentPaths.CaCertFile.
        // TLS פעיל תמיד, ולכן התעודה היא דרישה — לא תלות מותנית.
        // בלעדיה ה-TLS של הגשר ייכשל ושום הודעה לא תגיע לענן, ולכן זה
        // Error ולא Warning: זו תקלה חוסמת, לא הערה.
        if (File.Exists(AgentPaths.CaCertFile))
        {
            _logger.LogInformation("Using CA cert at {Path}", AgentPaths.CaCertFile);
        }
        else
        {
            _logger.LogError(
                "CA cert NOT found at {Path} — the HiveMQ bridge uses TLS (always) and will fail its " +
                "handshake, so NO message will reach the cloud. Reinstall so the certificate is placed " +
                "at this fixed location.",
                AgentPaths.CaCertFile);
        }

        // --- שעון מסונכרן NTP ---
        // חותמת הזמן של פעולה אומרת "מתי בדיוק זה קרה באתר", ולכן אסור שתהיה
        // תלויה בשעון Windows של מחשב שאיש לא מתחזק. הסנכרון רץ *ברקע*: הלולאה
        // הראשית לעולם לא ממתינה לרשת, ואתר בלי גישה ל-NTP ממשיך לעבוד בדיוק
        // כמו קודם (היסט 0 = השעון המקומי).
        var clock = new AgentClock();
        // גשר על החלון שבין עליית הסוכן לסנכרון הראשון: אם יש היסט שמור ועדיין
        // תקף (עד 24 שעות), מחילים אותו מיד. אחרת מתחילים בלי תיקון — תמיד
        // ברירת המחדל הבטוחה.
        if (clock.TryLoadPersisted())
            _logger.LogInformation("Restored last known clock offset {Seconds:F3}s from disk (pending fresh NTP sync).",
                clock.Offset.TotalSeconds);
        _ = SyncClockLoopAsync(clock, config, stoppingToken);

        // דוח שעון חד-פעמי ללוג: מצב w32time + ההיסט שנמדד. fire-and-forget
        // בכוונה — הוא מריץ פקודות חיצוניות (sc/w32tm) ואסור לו לעכב את הלולאה
        // הראשית ולו בשנייה. בלעדיו שעון סוטה באתר נשאר בלתי-נראה לחלוטין.
        _ = HostClockDiagnostics.ReportAsync(_logger, clock, config.NtpServer, stoppingToken);

        // --- יצירת שלושת הרכיבים ---
        var detector = new OperationDetector(clock.UnixNow);

        // ==========================================================
        // ממשיכים מאיפה שהפסקנו, במקום לפתוח פעולה חדשה
        // ==========================================================
        // ה-detector הוא edge-triggered, ולכן בלי MODE קודם כל עלייה באמצע
        // מחזור (MODE 2/3) פותחת פעולה עם חותם "עכשיו". זה נכון להתקנה
        // טרייה ושגוי אחרי הפעלה-מחדש — שם הפעולה כבר הייתה פתוחה, וכל
        // עלייה ייצרה שורה נוספת שמנפחת את מכנה אחוז הכשל.
        DetectorState? saved = DetectorState.TryLoad();
        if (saved is not null)
        {
            detector.Restore(saved.PreviousMode, saved.OperationCard);
            _logger.LogInformation(
                "Resuming detector state from previous run (MODE={Mode}, card='{Card}') — no phantom operation will be opened.",
                saved.PreviousMode, saved.OperationCard);
        }
        else
        {
            _logger.LogInformation(
                "No recent detector state — starting fresh. A first reading inside MODE 2/3 will open an operation.");
        }
        using var plc = new PlcReader(config.Plc);
        await using var mqtt = new MqttPublisher(config.Mqtt, config.SiteId, clock);

        // --- התחברות ל-Broker (כולל הגדרת ה-LWT) ---
        try
        {
            _logger.LogInformation("Attempting to connect to local broker (localhost:1883)...");
            await mqtt.ConnectAsync(stoppingToken);
            _logger.LogInformation("Connected to local broker.");
        }
        catch (Exception ex)
        {
            _logger.LogError(
                "Failed to connect to local broker on startup: {Message}. Will keep retrying in the loop.",
                ex.Message);
        }

        // מונה כשלונות רצופים של ה-PLC, ודגל שמונע שידור error חוזר שוב ושוב.
        int consecutiveFailures = 0;
        bool plcErrorReported = false;

        // ⚠️ אזהרת אריזת התווים נרשמת **פעם אחת לכל חיי השירות**. בלי הדגל
        // היא הייתה חוזרת בכל תקלה ומציפה את הלוג — ואז איש לא היה קורא
        // אותה, וזה בדיוק ההפך ממה שהיא נועדה להשיג.
        // ⚠️ 250ms: מספיק לבקר לכתוב, ואינו מעכב את שידור **המצב** —
        // הוא נשלח בנפרד. התקלה מגיעה למסך בזמן; רק התיאור מחכה.
        // ⚠️ דגימה כל 100ms עד שנייה אחת. ברוב המקרים הטקסט זז מיד,
        // ואז אין עיכוב כלל — הלולאה יוצאת בדגימה הראשונה.
        const int FaultTextPollMs = 100;
        const int FaultTextMaxWaitMs = 1000;
        bool faultTextPackingWarned = false;

        // ============================================================
        // תיאור התקלה — נקרא בשני מקומות, ולכן יושב בפונקציה אחת
        // ============================================================
        // ⚠️ **שני מסלולים שונים מגיעים לשרת עם "תקלה", ושניהם חייבים לשאת
        // את התיאור:**
        //
        //   1. **שינוי מצב** — הרגיל, מה שקורה כשהמכונה נופלת.
        //   2. **שידור מחדש (resync)** — אחרי חזרת הגשר, חזרת ה-PLC, או
        //      עלייה מחדש של השירות.
        //
        // המסלול השני שידר תקלה **בלי תיאור**, וזה לא מקרה קצה: אתר בתקלה
        // שמאבד תקשורת מסומן בשרת `no_comm`, וכשהוא חוזר ה-resync פותח
        // **מקטע תקלה חדש** — שהיה נרשם ריק. הכרטיס היה מציג "מושבת" בלי
        // תיאור, והשורה בלוג נשארת ריקה לתמיד. ובאתר תקול, נפילת תקשורת
        // היא בדיוק מה שקורה.
        //
        // ⚠️ **קוראים מה-PLC ולא זוכרים במשתנה.** הבקר מחזיק את התיאור
        // הנוכחי; זיכרון מקומי היה מת בכל הפעלה מחדש של השירות — כלומר
        // דווקא במקרה שהוא נועד לכסות.
        //
        // מחזיר null כשאין תיאור, כדי שהשדה יושמט מה-JSON לגמרי.
        string? ReadFaultTextOrNull(SiteState state)
        {
            if (state != SiteState.Error) return null;

            // ============================================================
            // ⚠️ ממתינים עד שהטקסט **משתנה**, לא זמן קבוע
            // ============================================================
            // הטקסט יושב בכתובת 2 וה-MODE ב-290 — שתי קריאות נפרדות.
            // נמדד באתר 1376: הבקר עבר תחזוקה→תקלה תוך 12 שניות והטקסט
            // עוד לא נכתב; מעברים של 25 שניות ומעלה החזירו עברית תקינה.
            //
            // ⚠️ המתנה קבועה היא ניחוש. 250ms עבדו במדידה אחת — ואין שום
            // ערובה שהם מספיקים לבקר אחר, ביום עמוס, או אחרי שדרוג.
            //
            // לכן: לוכדים את הערך **שהיה שם ברגע שהמצב הפך לתקלה** —
            // הוא בהכרח הישן — ומחכים עד שהוא זז. ברגע שהוא זז, זה הטקסט
            // החדש. ברוב המקרים זה קורה בדגימה הראשונה, ואז אין עיכוב
            // בכלל.
            FaultText stale = plc.ReadFaultText();
            FaultText ft = stale;
            bool settled = false;

            for (int waited = 0; waited < FaultTextMaxWaitMs; waited += FaultTextPollMs)
            {
                Thread.Sleep(FaultTextPollMs);
                ft = plc.ReadFaultText();
                if (ft.Text != stale.Text) { settled = true; break; }
            }

            // ============================================================
            // ⚠️ מה שנשאר לא ניתן להכרעה — ונאמר במפורש
            // ============================================================
            // אם הטקסט לא זז עד הסוף, יש שתי אפשרויות שאי אפשר להפריד
            // ביניהן מבחוץ: **אותה תקלה חזרה** (הערך נכון), או **הבקר
            // מעולם לא כתב** (הערך ישן).
            //
            // ⚠️ אין כאן ניחוש. השורה בלוג היא מה שיאמר לנו אם זה קורה
            // בכלל, וכמה — ורק PLC שיחשוף דגל 'טקסט עודכן' או מונה
            // גרסה יכול לסגור את זה לגמרי. זו בקשה לצד הבקר, לא באג אצלנו.
            if (!settled && !string.IsNullOrEmpty(ft.Text))
            {
                _logger.LogWarning(
                    "Fault text did not change within {Ms}ms of the fault. " +
                    "It is either the same fault recurring, or the PLC has not written " +
                    "the new text yet - these are indistinguishable. Value: '{Text}'",
                    FaultTextMaxWaitMs, ft.Text);
            }
            if (ft.HadUnknown && !faultTextPackingWarned)
            {
                faultTextPackingWarned = true;
                // ⚠️ **הערכים הגולמיים, לא רק הטקסט.** ההערה מעל טענה
                // שהם מודפסים — והקוד הדפיס את המפוענח בלבד. בלי הערכים
                // אי אפשר לזהות את הקידוד מרחוק, וזו כל מטרת האזהרה.
                _logger.LogWarning(
                    "Fault text: {Count} register value(s) were not recognised and became '?'. " +
                    "The text is half-readable and must not be trusted. Decoded: '{Text}' | raw: {Raw}",
                    ft.UnknownChars, ft.Text, ft.RawHex);
            }

            if (string.IsNullOrEmpty(ft.Text)) return null;

            _logger.LogInformation("Fault text from PLC: {Text}", ft.Text);
            return ft.Text;
        }

        // האם היינו מחוברים ל-Broker בסבב הקודם. משמש לזהות "חזרנו להתחבר"
        // כדי לשדר מחדש את המצב הנוכחי (אחרת שינוי שקרה בזמן הנתק אובד).
        bool mqttWasConnected = mqtt.IsConnected;

        // האם הגשר ל-HiveMQ היה מחובר בסבב הקודם. משמש לזהות "הגשר חזר"
        // ולשדר מחדש את המצב הנוכחי — ראה ההסבר בשלב ג'.
        bool bridgeWasConnected = mqtt.HiveMqBridgeConnected;

        // "הודעת לידה" (birth message): בעליית ה-Agent — התקנה חדשה, reboot, או
        // הפעלה-מחדש כדי להתאושש מ-no_comm — נשדר *פעם אחת* את המצב הנוכחי, בלי
        // לחכות לשינוי MODE. בלי זה, אם בעלייה הכול מתחבר נקי (אין reconnect שמפעיל
        // resync), האתר נשאר על מה שהשרת חשב (למשל no_comm שהשאיר סוכן שהתנתק) עד
        // שינוי המצב האמיתי הבא בבקר — שעלול לא להגיע שעות.
        bool birthMessageSent = false;

        // המצב המתורגם האחרון שראינו (לא-null). משמש כ-fallback ל-resync כשה-MODE
        // הנוכחי אינו ממופה (MODE 4 = init → null): כך אתר שהתאושש-לתוך-init, או
        // שהשרת חושב עליו error/no_comm, לא נשאר תקוע עד המעבר הממופה הבא.
        SiteState? lastKnownState = null;

        // תור פעולות שטרם שודרו בהצלחה. פעולה (כניסה/יציאה) היא אירוע שאסור לאבד:
        // ה-detector הוא edge-triggered ומקדם את מצבו מיד, ולכן אם השידור נכשל אין
        // דרך "לזהות שוב" את המעבר. שומרים כאן כל פעולה *עם החותם המקורי שלה* עד
        // שידור מוצלח; כשל → נשארת ותשודר בסבב הבא (אותו חותם ⇒ ה-dedup של השרת
        // סופג כפילות QoS-1). הרצפה גבוהה מספיק לכל אורך נתק סביר של הברוקר המקומי.
        var pendingOps = new List<OperationMessage>();
        const int MaxPendingOps = 1000;

        // מונה המחזורים מהקריאה הקודמת, לזיהוי ירידה (גלישה/איפוס). מאותחל
        // ל-int.MinValue כדי שהקריאה הראשונה לעולם לא תיראה כירידה.
        int previousCycle = int.MinValue;

        // מה שכבר נשמר לדיסק, כדי לא לכתוב את אותו מצב שוב בכל דגימה.
        // מאותחלים ממה שנטען (או null), כך שהשמירה הראשונה תקרה רק על שינוי אמיתי.
        int? savedMode = saved?.PreviousMode;
        string savedCard = saved?.OperationCard ?? "";

        // ה-MODE שנרשם לאחרונה ללוג. משמש כדי לרשום (ב-Information) *כל* שינוי MODE
        // ואת התרגום שלו — כך שבשדה רואים מה הבקר מחזיר ואם הערך בכלל ממופה ל-state.
        int? previousLoggedMode = null;

        // --- הלולאה הראשית ---
        while (!stoppingToken.IsCancellationRequested)
        {
            // ===== חיוּת: "הלולאה מסתובבת" — לפני הכול, ובלי תנאי =====
            // נכתב כאן ולא אחרי הקריאה, ובכוונה: זו הצהרה על כך שהתהליך לא
            // תקוע, ולא על כך שהבקר עונה. ראה AgentPaths.LivenessFile —
            // הערבוב בין השניים הרג את הסוכן לפני שהספיק לדווח תקלת PLC.
            WriteLiveness();

            // ===== שלב א': קריאה מה-PLC (טיפול שגיאות נפרד מה-MQTT) =====
            // מוצהר בלי null: נתיב הכשל ב-catch מסתיים ב-continue, כך שאם הגענו
            // מעבר ל-try/catch — הקריאה הצליחה ו-reading הושם בוודאות.
            PlcReading reading;
            bool plcJustRecovered;
            try
            {
                reading = plc.Read();

                // אם קדמו לזה כשלונות — זו התאוששות; רושמים אותה (Information),
                // אבל קריאות שגרה רגילות נשארות Debug כדי לא להציף את הקובץ.
                plcJustRecovered = consecutiveFailures > 0;

                // הצליח — מאפסים את מונה הכשלונות.
                consecutiveFailures = 0;
                plcErrorReported = false;

                // כותבים פעימת לב: הזמן הנוכחי, לסימן שהקריאה הצליחה.
                // ממשק המשתמש יקרא את זה כדי לדעת אם ה-Agent באמת עובד.
                WriteHeartbeat();

                // כותבים את סטטוס ה-HiveMQ ל-Tray: "מחובר" רק אם גם ה-Broker המקומי
                // וגם הגשר ל-HiveMQ חיים — כדי שהסמל יהיה צבעוני רק בחיבור מלא.
                WriteHiveMqStatus(mqtt.IsConnected && mqtt.HiveMqBridgeConnected);

                if (plcJustRecovered)
                {
                    _logger.LogInformation(
                        "PLC connection restored — read OK (MODE={Mode}, Card='{Card}', Cycle={Cycle}).",
                        reading.Mode, reading.CardNumber, reading.CycleCounter);
                }
                else
                {
                    // רישום שגרתי ברמת Debug בלבד — אחרת בכל שנייה נציף את הלוג.
                    _logger.LogDebug(
                        "PLC read -> MODE={Mode}, Card='{Card}', Cycle={Cycle}",
                        reading.Mode, reading.CardNumber, reading.CycleCounter);
                }
            }
            catch (Exception ex)
            {
                // קריאה נכשלה — סופרים, אך לא מעבר לסף (כדי שהלוג לא יראה 11/10).
                bool firstFailure = consecutiveFailures == 0;
                if (consecutiveFailures < MaxConsecutiveFailures)
                    consecutiveFailures++;

                // מדווחים את הכשל הראשון ב-Warning (כדי שיופיע בקובץ), ואת ההמשך
                // ב-Debug — כדי שנתק PLC ממושך לא ייצור שורה בכל שנייה.
                if (firstFailure)
                    _logger.LogWarning("PLC read failed: {Message}", ex.Message);
                else
                    _logger.LogDebug(
                        "PLC read still failing ({Count}/{Max}): {Message}",
                        consecutiveFailures, MaxConsecutiveFailures, ex.Message);

                // עברנו את הסף, ועדיין לא דיווחנו — משדרים תקלה פעם אחת.
                if (consecutiveFailures >= MaxConsecutiveFailures && !plcErrorReported)
                {
                    _logger.LogError(
                        "PLC unresponsive for {Count} reads — reporting error state.",
                        consecutiveFailures);

                    var errorState = new StateMessage
                    {
                        Timestamp = clock.UnixNow(),
                        State = SiteState.Error
                    };

                    if (await TryPublishAsync(mqtt, () => mqtt.PublishStateAsync(errorState, stoppingToken),
                            "error state (PLC timeout)", stoppingToken))
                    {
                        plcErrorReported = true;   // לא נשדר error שוב עד שה-PLC יחזור
                        mqttWasConnected = true;
                        _logger.LogInformation("-> Published STATE: error (PLC timeout)");
                    }
                    else
                    {
                        mqttWasConnected = false;
                    }
                }

                // קריאה נכשלה — אין מה למסור למוח; ממתינים וממשיכים לסבב הבא.
                await Task.Delay(config.PollIntervalMs, stoppingToken);
                continue;
            }

            // ===== שלב ב': המוח מחליט מה לשדר =====
            DetectionResult result = detector.Process(
                reading.Mode, reading.CardNumber, reading.CycleCounter);

            // שומרים את מצב ה-detector כדי שהפעלה מחדש תמשיך ולא תפתח פעולה
            // חדשה. **רק כשמשהו זז** — כתיבה בכל דגימה הייתה עוד I/O לשנייה
            // בלי שום תועלת, והחותם בקובץ ממילא מתעדכן בכל שינוי אמיתי.
            if (detector.PreviousMode != savedMode || detector.OperationCard != savedCard)
            {
                savedMode = detector.PreviousMode;
                savedCard = detector.OperationCard;
                new DetectorState(reading.Mode, detector.OperationCard).Save();
            }

            // המצב הנוכחי המתורגם — לשימוש בשידור-מחדש אחרי חיבור-מחדש.
            SiteState? currentState = ModeTranslator.FromMode(reading.Mode);

            // זוכרים את המצב האחרון שכן ממופה — ה-fallback ל-resync ב-MODE לא-ממופה.
            if (currentState.HasValue)
                lastKnownState = currentState;

            // לוכדים את הפעולות שהמוח זיהה *מיד* לתוך תור השידור — לפני כל ניסיון
            // שידור (שעלול לזרוק). כך אף כניסה/יציאה לא אובדת גם אם הברוקר נופל כאן.
            foreach (var op in result.Operations)
            {
                if (pendingOps.Count >= MaxPendingOps)
                {
                    _logger.LogError(
                        "Pending-operations buffer full ({Max}) — dropping oldest. Broker unreachable too long?",
                        MaxPendingOps);
                    pendingOps.RemoveAt(0);
                }
                pendingOps.Add(op);
            }

            // ===== אבחון: מונה מחזורים שירד =====
            // ==========================================================
            // למה רק מדווחים, ולא "מתקנים"
            // ==========================================================
            // המונה נקרא מרגיסטר Modbus יחיד — 16 ביט, כלומר תקרה של 65,535.
            // ירידה בערך יכולה לנבוע משתי סיבות **שאי אפשר להבחין ביניהן
            // מהנתון עצמו**:
            //   • גלישה (65,530 → 5) — הבקר המשיך לספור, המונה התהפך.
            //   • איפוס בקר (65,530 → 0) — ספירה אמיתית שהתחילה מחדש.
            //
            // השרת מפרש ירידה כאיפוס ואינו מוסיף את ההפרש (ראה
            // master/CLAUDE.md, applyCycleCounter). אם זו הייתה גלישה, המשמעות
            // היא ספירה בחסר של עד 65,535 מחזורים בכל התהפכות.
            //
            // ניחוש כאן היה מסוכן יותר מהבעיה: הוספת 65,536 אוטומטית על כל
            // ירידה הייתה מנפחת את המונה בכל *איפוס אמיתי*. לכן הסוכן מדווח
            // בלבד — והלוג נותן בדיוק את המידע שנדרש כדי להכריע: אם הקפיצות
            // מגיעות תמיד סביב 65,535 זו גלישה וצריך לקרוא 32 ביט (שני
            // רגיסטרים), ואם הן מכל ערך — אלה איפוסי בקר אמיתיים.
            if (reading.CycleCounter < previousCycle)
            {
                _logger.LogWarning(
                    "Cycle counter DROPPED: {Prev} -> {Now}. Either the 16-bit register wrapped " +
                    "(max 65535 — the server counts this as a reset and loses the delta) or the PLC " +
                    "counter was reset. If drops cluster near 65535, the counter is wider than one " +
                    "register and CycleRegister should read 32 bits.",
                    previousCycle, reading.CycleCounter);
            }
            previousCycle = reading.CycleCounter;

            // ===== אבחון: רושמים כל שינוי ב-MODE ואת התרגום שלו =====
            // זה הצעד הכי חשוב לאבחון בשדה: הוא חושף מה הבקר באמת מחזיר, והאם
            // הערך בכלל ממופה ל-state. אם לא — כאן נראה בדיוק למה שום state לא נשלח.
            // רושמים רק על *שינוי* MODE (כולל הקריאה הראשונה), כדי לא להציף את הקובץ.
            if (reading.Mode != previousLoggedMode)
            {
                string prev = previousLoggedMode?.ToString() ?? "(none)";
                if (currentState.HasValue)
                {
                    _logger.LogInformation(
                        "PLC MODE {Prev} -> {Mode}  =>  state={State}",
                        prev, reading.Mode, currentState.Value);
                }
                else if (reading.Mode == 4)
                {
                    _logger.LogInformation(
                        "PLC MODE {Prev} -> {Mode}  =>  init (no state published for this value)",
                        prev, reading.Mode);
                }
                else
                {
                    // הסיבה הסבירה ביותר לכך ש-state לא נשלח בשדה: ערך MODE לא-מוכר.
                    _logger.LogWarning(
                        "PLC MODE {Prev} -> {Mode}  =>  UNRECOGNIZED value (expected 0-5). " +
                        "No state will be published for this value — verify the MODE register address " +
                        "(0-based vs 1-based), the Modbus function code (input vs holding register), " +
                        "or the PLC's MODE encoding.",
                        prev, reading.Mode);
                }

                previousLoggedMode = reading.Mode;
            }

            // ===== שלב ג': שידור ל-Broker (טיפול שגיאות נפרד; כולל חיבור-מחדש) =====
            try
            {
                // מוודא חיבור — יתחבר מחדש אם התנתקנו (או אם Mosquitto רק עכשיו עלה).
                await mqtt.EnsureConnectedAsync(stoppingToken);

                // סנכרון מצב מאולץ בשלושה מקרים:
                //  1. חזרנו להתחבר ל-Broker המקומי (אחרת שינוי בזמן הנתק היה אובד).
                //  2. ה-PLC התאושש מתקלה — לאחר שידור error צריך לשדר שוב את המצב האמיתי,
                //     אחרת אם ה-MODE זהה למה שהיה לפני התקלה, ה-detector לא ישדר כלום
                //     והשרת יישאר "תקוע" על error.
                //  3. **הגשר ל-HiveMQ חזר** — וזה קריטי מאז שהשרת מסמן no_comm
                //     כשהגשר נופל.
                //
                //     בזמן נתק אינטרנט ה-Agent ממשיך לשדר ל-Mosquitto המקומי,
                //     שמצבור את ההודעות ומזרים אותן כשהגשר חוזר — עם חותמי הזמן
                //     *המקוריים*. אבל השרת כבר פתח מקטע no_comm, וההגנה מפני
                //     הודעות מאוחרות (backfill) תדחה כל הודעת state ישנה ממנו.
                //     בלי הסנכרון הזה האתר היה נשאר תקוע ב"אין תקשורת" עד
                //     שינוי המצב האמיתי הבא — שעלול לא להגיע שעות.
                //
                //     שידור עם חותם זמן *טרי* סוגר את מקטע ה-no_comm ומחזיר את
                //     המצב האמיתי. הפעולות (operation) לא נפגעות ממילא — הן
                //     נשמרות בלי קשר להגנה הזו.
                bool bridgeJustReconnected = mqtt.HiveMqBridgeConnected && !bridgeWasConnected;

                // ההחלטה עצמה (מתי/מה לשדר מחדש, כולל ה-birth בעלייה) חיה ב-ResyncPolicy —
                // פונקציה טהורה שמכוסה ב-unit tests. כאן רק מבצעים אותה.
                ResyncDecision resync = ResyncPolicy.Decide(
                    birthMessageSent, mqttWasConnected, plcJustRecovered,
                    bridgeJustReconnected, currentState, lastKnownState);

                if (resync.ShouldPublish)
                {
                    _logger.LogInformation(
                        "Resyncing current state to broker ({Reason}) -> {State}.",
                        resync.Reason, resync.State);
                    await mqtt.PublishStateAsync(new StateMessage
                    {
                        Timestamp = clock.UnixNow(),
                        State = resync.State,
                        // ⚠️ בלי זה, אתר שנפל **ואז** איבד תקשורת חוזר לשרת
                        // כתקלה חדשה וריקה — ראה ReadFaultTextOrNull.
                        FaultText = ReadFaultTextOrNull(resync.State)
                    }, stoppingToken);
                    birthMessageSent = true;   // שודר לפחות פעם אחת — ה"לידה" בוצעה
                }
                mqttWasConnected = true;
                bridgeWasConnected = mqtt.HiveMqBridgeConnected;

                // משדרים את מה שהמוח החליט (אם יש) — שינוי state.
                //
                // הסוכן משדר *רק על שינוי*, ובכוונה. אין כאן סימן חיים תקופתי:
                // זיהוי הניתוק הוא תפקידו של פרוטוקול ה-MQTT (keepalive + LWT),
                // בשתי השכבות — הסוכן מול Mosquitto, והגשר מול HiveMQ
                // (ראה BridgeConfigWriter). הצפת הברוקר בהודעות "אני חי" כל 30
                // שניות × מספר האתרים רק כדי לשחזר מידע שהפרוטוקול כבר נותן
                // בחינם היא בזבוז, והיא גם מסתירה את הבעיה האמיתית במקום לתקן אותה.
                if (result.State is not null)
                {
                    // ============================================================
                    // תיאור התקלה — נקרא רק כשיש תקלה, ורק על שינוי מצב
                    // ============================================================
                    // עד היום כל התקלות נראו זהות במסך: "מושבת". אין דרך לדעת
                    // אם זו תקלת חיישן, כרטיס שלא נקרא או תקלה מכנית.
                    //
                    // ⚠️ **התנאי הכפול חוסך פי כמה מאות בתעבורה.** 80 registers
                    // הם קריאה גדולה בהרבה מהרגילה (3), והיא רלוונטית רק ברגע
                    // אחד: כשהמצב משתנה לתקלה. קריאה בכל דגימה הייתה מכפילה את
                    // העומס על הבקר בלי להוסיף מידע.
                    //
                    // ⚠️ וכשל בקריאה אינו מפיל את השידור: ReadFaultText מחזיר
                    // ריק, והתקלה משודרת בלי תיאור. **התקלה עצמה חשובה יותר
                    // מהתיאור שלה**, ובקר ישן שאין בו את הכתובת הזו חייב
                    // להמשיך לעבוד בדיוק כמו קודם.
                    result.State.FaultText = ReadFaultTextOrNull(result.State.State);

                    _logger.LogInformation("State changed -> {State}; publishing...", result.State.State);
                    await mqtt.PublishStateAsync(result.State, stoppingToken);
                    _logger.LogInformation("-> Published STATE: {State}", result.State.State);
                }

                // מרוקנים את תור הפעולות בסדר. הודעה מתפרסמת → יורדת מהתור. אם אחת
                // זורקת, יוצאים ל-catch כשהיא עדיין ראש התור — כך היא (וכל מה שאחריה)
                // תשודר שוב בסבב הבא, עם החותם המקורי. אין אובדן ואין קידום-לפני-שידור.
                while (pendingOps.Count > 0)
                {
                    // חיוּת גם *בתוך* הריקון: התור מחזיק עד 1000 פעולות, ולכל
                    // שידור timeout של 5 שניות. מול ברוקר איטי (לא מת — מת נכשל
                    // מהר) ריקון ארוך היה עובר את סף התקיעה בזמן שהסוכן עובד
                    // כשורה, ה-watchdog היה הורג אותו, **והתור חי בזיכרון בלבד**
                    // — כלומר כל הפעולות שהוא נועד להציל היו אובדות בדיוק כאן.
                    WriteLiveness();

                    var op = pendingOps[0];
                    await mqtt.PublishOperationAsync(op, stoppingToken);
                    pendingOps.RemoveAt(0);
                    _logger.LogInformation(
                        "-> Published OPERATION: {StartEnd}/{EntryExit} card='{Card}' cycle={Cycle}",
                        op.StartEnd, op.EntryExit, op.User, op.CycleCounter);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // כיבוי מסודר — לא שגיאה.
                break;
            }
            catch (Exception ex)
            {
                // תקלת Broker (למשל Mosquitto לא זמין) — נרשמת בנפרד מתקלות PLC,
                // ולא נוגעת במונה כשלי ה-PLC. ננסה להתחבר שוב בסבב הבא.
                // מדווחים את *איבוד* החיבור פעם אחת (Warning); בזמן שהוא עדיין למטה
                // ממשיכים ב-Debug כדי לא לרשום שורה בכל שנייה.
                if (mqttWasConnected)
                    _logger.LogWarning("Broker connection lost, will keep retrying: {Message}", ex.Message);
                else
                    _logger.LogDebug("Broker still unavailable: {Message}", ex.Message);

                mqttWasConnected = false;
            }

            // המתנה עד הדגימה הבאה, לפי ההגדרות.
            await Task.Delay(config.PollIntervalMs, stoppingToken);
        }

        _logger.LogInformation("Worker stopped.");
    }

    // מנסה לפרסם הודעה תוך הבטחת חיבור, ומחזיר האם הצליח (בלי לזרוק).
    // משמש בנתיב תקלת ה-PLC, כדי ששידור ה-error לא יפיל את הלולאה אם ה-Broker למטה.
    private async Task<bool> TryPublishAsync(
        MqttPublisher mqtt, Func<Task> publish, string description, CancellationToken ct)
    {
        try
        {
            await mqtt.EnsureConnectedAsync(ct);
            await publish();
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Failed to publish {Description}: {Message}", description, ex.Message);
            return false;
        }
    }

    // מוודא שתעודת ה-CA קיימת בנתיב ה-ASCII הקבוע (AgentPaths.CaCertFile).
    // אם היא חסרה, מעתיק אותה מתיקיית Mosquitto שליד ה-exe של השירות
    // ({app}\mosquitto\cacert.pem). כך גם בהתקנה למשתמש (localappdata, שם המשתמש
    // עשוי להיות בעברית) Mosquitto מקבל נתיב תעודה נקי מתווים לא-לטיניים.
    private void EnsureCaCertPresent()
    {
        try
        {
            if (File.Exists(AgentPaths.CaCertFile))
                return;

            string source = Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "mosquitto", "cacert.pem"));

            if (File.Exists(source))
            {
                AgentPaths.EnsureBaseFolderExists();
                File.Copy(source, AgentPaths.CaCertFile, overwrite: false);
                _logger.LogInformation("Copied CA cert to {Dest} (from {Src}).", AgentPaths.CaCertFile, source);
            }
            else
            {
                _logger.LogWarning(
                    "Source CA cert not found at {Src} — cannot place it at {Dest}.",
                    source, AgentPaths.CaCertFile);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Failed to ensure CA cert at {Dest}: {Msg}", AgentPaths.CaCertFile, ex.Message);
        }
    }

    // כותב את הזמן הנוכחי (יוניקס-שניות) לקובץ פעימת הלב.
    // עוטף ב-try כדי שכשל בכתיבה לא יפיל את השירות.
    //
    // ⚠️ כאן דווקא *לא* משתמשים בשעון ה-NTP המתוקן, ובכוונה: הקובץ הזה הוא
    // מנגנון חיות מקומי בלבד, וה-Tray משווה אותו מול השעון המקומי *שלו*
    // (ServiceManager). אם נכתוב כאן זמן מתוקן בזמן שהשעון המקומי סוטה, ההפרש
    // ייראה ל-Tray כפעימה מהעתיד/עבר והסמל היה נשבר. הזמן המתוקן שייך רק למה
    // שמשודר לענן.
    private void WriteHeartbeat()
    {
        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            AtomicWriteAllText(AgentPaths.HeartbeatFile, now.ToString());
        }
        catch
        {
            // כשל בכתיבת פעימת לב אינו קריטי — מתעלמים.
        }
    }

    // כותב את קובץ החיוּת: "הלולאה מסתובבת", בלי קשר להצלחת הקריאה מה-PLC.
    //
    // ⚠️ **לא** לאחד את זה עם WriteHeartbeat. הם עונים על שתי שאלות שונות
    // (ראה AgentPaths.LivenessFile): heartbeat אומרת "הבקר עונה" וצובעת את
    // הסמל, וזו אומרת "התהליך אינו תקוע" ומזינה את ה-watchdog. איחוד היה
    // מחזיר בדיוק את הבאג שזה תיקן — או שנתק PLC היה נראה כתקיעה ומוביל
    // להריגה, או שאתר עם בקר מת היה נראה ירוק ב-Tray.
    //
    // כמו ב-heartbeat: שעון מקומי ולא מתוקן-NTP, כי ה-Tray משווה מול השעון
    // המקומי שלו.
    private void WriteLiveness()
    {
        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            AtomicWriteAllText(AgentPaths.LivenessFile, now.ToString());
        }
        catch
        {
            // כשל בכתיבה אינו קריטי — מתעלמים, בדיוק כמו בפעימת הלב.
        }
    }

    // כותב את סטטוס החיבור ל-HiveMQ בפורמט "<0|1> <unix-seconds>", לקריאת ה-Tray.
    // חותם הזמן מאפשר ל-Tray לדעת שהמידע עדכני (ולא שריד ישן).
    private void WriteHiveMqStatus(bool connected)
    {
        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            AtomicWriteAllText(AgentPaths.HiveMqStatusFile, $"{(connected ? 1 : 0)} {now}");
        }
        catch
        {
            // לא קריטי — מתעלמים.
        }
    }

    // כתיבה אטומית: כותבים לקובץ ‎.tmp‎ ואז מחליפים במהלך אחד (File.Move). כך
    // ה-Tray, שקורא את הקבצים האלה במקביל, לעולם לא רואה קובץ חצי-כתוב (truncate
    // באמצע כתיבה) — או הישן במלואו או החדש במלואו. בלי זה קריאה שנפלה על כתיבה
    // הפכה את אייקון ה-Tray לאפור/"מכובה" לרגע למרות שהסוכן תקין.
    private static void AtomicWriteAllText(string path, string content)
    {
        string tempFile = path + ".tmp";
        File.WriteAllText(tempFile, content);
        File.Move(tempFile, path, overwrite: true);
    }

    // ==========================================================
    // סנכרון השעון מול NTP
    // ==========================================================
    // רץ ברקע לאורך כל חיי הסוכן: מסנכרן מיד בעלייה, ואז מדי פרק זמן קבוע.
    //
    // שני כללים שלא מתפשרים עליהם:
    //   1. **לעולם לא זורק ולא חוסם.** כישלון סנכרון (UDP/123 חסום, אין
    //      אינטרנט, DNS נופל) פירושו "נשארים על השעון המקומי" — בדיוק
    //      ההתנהגות שהייתה לפני התכונה הזו. חניון לא מפסיק לדווח בגלל NTP.
    //   2. **לא נוגעים בשעון המערכת** — זה היה דורש הרשאות מנהל.
    private async Task SyncClockLoopAsync(AgentClock clock, SiteConfig config, CancellationToken ct)
    {
        string server = (config.NtpServer ?? "").Trim();
        if (server.Length == 0)
        {
            _logger.LogWarning(
                "NTP sync is disabled (no server configured) — operation timestamps will use this PC's clock as-is.");
            return;
        }

        // ההידוק נעשה כבר ב-ConfigStore.Load; חוזרים עליו כאן כי המתודה הזו חייבת
        // להיות בטוחה גם אם מישהו יקרא לה עם config שלא עבר דרך Load.
        TimeSpan interval = TimeSpan.FromMinutes(
            ConfigStore.ClampNtpSyncIntervalMinutes(config.NtpSyncIntervalMinutes));

        while (!ct.IsCancellationRequested)
        {
          try
          {
            TimeSpan? offset = await NtpClient.GetOffsetAsync(server, TimeSpan.FromSeconds(5), ct);

            if (offset.HasValue)
            {
                double seconds = offset.Value.TotalSeconds;

                // ApplyOffset מחזיר false כשההיסט מופרך (ראה
                // AgentClock.MaxPlausibleOffset) — ואז **לא הוחל כלום**. חובה
                // להבדיל: לוג שאומר "corrected" כשלא תוקן דבר הוא בדיוק הכשל
                // השקט שהחסם נועד למנוע — מי שקורא את הלוג רואה "טופל"
                // וממשיך הלאה, בזמן שהשרת דוחה כל הודעה מהאתר.
                if (!clock.ApplyOffset(offset.Value))
                {
                    // *לא* מתמידים: Persist היה כותב מחדש את ההיסט הישן, ובכך
                    // רק מרענן חותם של מדידה שכלל לא התקבלה.
                    _logger.LogError(
                        "NTP: {Server} reported an implausible offset of {Seconds:F1}s (over the {Max:F0}h limit) — REJECTED. " +
                        "The clock stays local and published timestamps are NOT corrected. " +
                        "Check this PC's clock and the time source; while this lasts the server may reject this site's messages.",
                        server, seconds, AgentClock.MaxPlausibleOffset.TotalHours);
                }
                else
                {
                    clock.Persist();   // כדי שהעלייה הבאה לא תתחיל מאפס אם אין רשת

                    // סטייה של יותר משתי שניות אינה רעש מדידה — היא שעון שגוי
                    // באתר, ושווה שתהיה גלויה בלוג. הזמן המשודר כבר מתוקן.
                    if (Math.Abs(seconds) >= 2)
                    {
                        _logger.LogWarning(
                            "NTP: this PC's clock is off by {Seconds:F1}s (per {Server}). Published timestamps are corrected.",
                            seconds, server);
                    }
                    else
                    {
                        _logger.LogInformation(
                            "NTP synced with {Server}; clock offset {Seconds:F3}s.", server, seconds);
                    }
                }
            }
            else
            {
                _logger.LogWarning(
                    "NTP sync with {Server} failed (UDP/123 blocked or no internet). Falling back to {Fallback}.",
                    server, clock.IsSynced ? "the last known offset" : "this PC's clock");
            }

            await Task.Delay(interval, ct);
          }
          catch (OperationCanceledException)
          {
              return;   // כיבוי מסודר
          }
          catch (Exception ex)
          {
              // ==========================================================
              // הלולאה הזו אסור שתמות בשקט
              // ==========================================================
              // היא רצה כמשימת רקע מנותקת (fire-and-forget), ולכן חריגה שבורחת
              // מכאן אינה מפילה את הסוכן ואינה מודפסת — היא פשוט הופכת ל-unobserved
              // task exception, וסנכרון השעון נעצר לצמיתות **בלי שום סימן**. אתר
              // היה ממשיך לדווח שנים עם שעון סוטה, ואיש לא היה יודע.
              // לכן: רושמים, ממתינים קצת, וממשיכים.
              _logger.LogError("NTP sync loop error: {Message}. Retrying in 1 minute.", ex.Message);
              try { await Task.Delay(TimeSpan.FromMinutes(1), ct); }
              catch (OperationCanceledException) { return; }
          }
        }
    }
}