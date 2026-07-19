using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
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

        // --- יצירת שלושת הרכיבים ---
        var detector = new OperationDetector();
        using var plc = new PlcReader(config.Plc);
        await using var mqtt = new MqttPublisher(config.Mqtt, config.SiteId);

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

        // האם היינו מחוברים ל-Broker בסבב הקודם. משמש לזהות "חזרנו להתחבר"
        // כדי לשדר מחדש את המצב הנוכחי (אחרת שינוי שקרה בזמן הנתק אובד).
        bool mqttWasConnected = mqtt.IsConnected;

        // האם הגשר ל-HiveMQ היה מחובר בסבב הקודם. משמש לזהות "הגשר חזר"
        // ולשדר מחדש את המצב הנוכחי — ראה ההסבר בשלב ג'.
        bool bridgeWasConnected = mqtt.HiveMqBridgeConnected;

        // ה-MODE שנרשם לאחרונה ללוג. משמש כדי לרשום (ב-Information) *כל* שינוי MODE
        // ואת התרגום שלו — כך שבשדה רואים מה הבקר מחזיר ואם הערך בכלל ממופה ל-state.
        int? previousLoggedMode = null;

        // --- הלולאה הראשית ---
        while (!stoppingToken.IsCancellationRequested)
        {
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
                        Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
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

            // המצב הנוכחי המתורגם — לשימוש בשידור-מחדש אחרי חיבור-מחדש.
            SiteState? currentState = ModeTranslator.FromMode(reading.Mode);

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

                if ((!mqttWasConnected || plcJustRecovered || bridgeJustReconnected)
                    && currentState.HasValue)
                {
                    string reason = !mqttWasConnected ? "reconnected to broker"
                        : bridgeJustReconnected ? "HiveMQ bridge reconnected"
                        : "PLC recovered";
                    _logger.LogInformation(
                        "Resyncing current state to broker ({Reason}) -> {State}.",
                        reason, currentState.Value);
                    await mqtt.PublishStateAsync(new StateMessage
                    {
                        Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                        State = currentState.Value
                    }, stoppingToken);
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
                    _logger.LogInformation("State changed -> {State}; publishing...", result.State.State);
                    await mqtt.PublishStateAsync(result.State, stoppingToken);
                    _logger.LogInformation("-> Published STATE: {State}", result.State.State);
                }

                foreach (var op in result.Operations)
                {
                    await mqtt.PublishOperationAsync(op, stoppingToken);
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
    private void WriteHeartbeat()
    {
        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            File.WriteAllText(AgentPaths.HeartbeatFile, now.ToString());
        }
        catch
        {
            // כשל בכתיבת פעימת לב אינו קריטי — מתעלמים.
        }
    }

    // כותב את סטטוס החיבור ל-HiveMQ בפורמט "<0|1> <unix-seconds>", לקריאת ה-Tray.
    // חותם הזמן מאפשר ל-Tray לדעת שהמידע עדכני (ולא שריד ישן).
    private void WriteHiveMqStatus(bool connected)
    {
        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            File.WriteAllText(AgentPaths.HiveMqStatusFile, $"{(connected ? 1 : 0)} {now}");
        }
        catch
        {
            // לא קריטי — מתעלמים.
        }
    }
}