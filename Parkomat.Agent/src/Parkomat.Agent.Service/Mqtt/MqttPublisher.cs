using MQTTnet;
using MQTTnet.Protocol;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Time;
using Parkomat.Agent.Service.Logging;
using System.Text.Json;

namespace Parkomat.Agent.Service.Mqtt;

/// <summary>
/// מפרסם הודעות ל-Broker דרך MQTT.
/// אחראי על החיבור, על ה-LWT (הצוואה no_comm), ועל שידור
/// הודעות state ו-operation ל-topics הנכונים ב-QoS 1.
/// </summary>
public class MqttPublisher : IAsyncDisposable
{
    private readonly MqttConfig _config;
    private readonly string _siteCode;
    private readonly IMqttClient _client;

    // השעון המסונכרן (NTP). אופציונלי — בלעדיו נופלים לשעון המקומי, כך
    // שקורא שלא מספק שעון מתנהג בדיוק כמו קודם.
    private readonly AgentClock _clock;

    public MqttPublisher(MqttConfig config, string siteCode, AgentClock? clock = null)
    {
        _config = config;
        _siteCode = siteCode;
        _clock = clock ?? new AgentClock();

        var factory = new MqttClientFactory();
        _client = factory.CreateMqttClient();

        // מאזין להודעות מ-Mosquitto — בפרט למצב חיבור הגשר ל-HiveMQ.
        _client.ApplicationMessageReceivedAsync += OnMessageReceived;
    }

    public bool IsConnected => _client.IsConnected;

    // נכתב על thread ה-callback של MQTTnet ונקרא על thread לולאת ה-Worker.
    // volatile מבטיח שה-Worker לא יקרא ערך ישן (barrier) — בלעדיו reconnect של
    // הגשר עלול "להתפספס" (אין resync → השרת נשאר ב-no_comm).
    private volatile bool _hiveMqBridgeConnected;

    // האם המנוי ל-topic מצב-הגשר הצליח. אם SubscribeAsync נכשל בעוד החיבור עלה,
    // בלי הדגל הזה החיבור נחשב "תקין" אך *לא מנוי* לצמיתות — ומצב-הגשר לא יתעדכן
    // לעולם (ה-Tray אפור, ו-bridgeJustReconnected לא ייורה). EnsureConnected בודק
    // את הדגל ומנסה מנוי מחדש.
    private bool _subscribed;

    /// <summary>
    /// האם גשר ה-Mosquitto מחובר כרגע ל-HiveMQ (לפי הודעת ה-notification המקומית).
    /// false עד שמתקבל דיווח "1", וכן בכל ניתוק.
    /// </summary>
    public bool HiveMqBridgeConnected => _hiveMqBridgeConnected;

    // מטפל בהודעות נכנסות: מעדכן את מצב הגשר ל-HiveMQ לפי ה-topic הייעודי.
    private Task OnMessageReceived(MqttApplicationMessageReceivedEventArgs e)
    {
        if (e.ApplicationMessage.Topic == BridgeConfigWriter.RemoteBridgeStateTopic(_siteCode))
        {
            string payload = e.ApplicationMessage.ConvertPayloadToString()?.Trim() ?? "";
            _hiveMqBridgeConnected = payload == "1";
        }
        return Task.CompletedTask;
    }

    // ה-topics לפי החוזה: sites/{code}/state ו-sites/{code}/operation.
    private string StateTopic => $"sites/{_siteCode}/state";
    private string OperationTopic => $"sites/{_siteCode}/operation";

    /// <summary>
    /// מתחבר ל-Broker. מגדיר את ה-LWT מראש: אם ה-Agent מתנתק,
    /// ה-Broker ישדר בשמו הודעת no_comm ל-topic של המצב.
    /// </summary>
    public async Task ConnectAsync(CancellationToken ct = default)
    {
        // בכל חיבור מחדש מאפסים את מצב הגשר עד שנקבל דיווח עדכני (retained),
        // וכן את דגל המנוי (נרשמים מחדש בכל חיבור).
        _hiveMqBridgeConnected = false;
        _subscribed = false;

        // ה-payload של הצוואה — בדיוק כמו החוזה: { "timestamp": 0, "state": "no_comm" }
        var willMessage = new StateMessage
        {
            Timestamp = 0,
            State = SiteState.NoComm
        };
        string willJson = JsonSerializer.Serialize(willMessage);

        // ה-Agent תמיד מתחבר ל-Mosquitto המקומי (localhost, פורט 1883, ללא הצפנה).
        // Mosquitto הוא זה שמגשר ל-HiveMQ עם הפרטים שבהגדרות.
        var options = new MqttClientOptionsBuilder()
            .WithTcpServer("localhost", 1883)
            .WithClientId($"agent-{_siteCode}")   // ייחודי לכל אתר — מונע ניתוק הדדי
            .WithWillTopic(StateTopic)
            .WithWillPayload(willJson)
            .WithWillQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce) // QoS 1
            .WithWillRetain(false)
            .Build();

        await _client.ConnectAsync(options, ct);

        // נרשמים ל-topic של מצב הגשר ל-HiveMQ (retained — נקבל את הערך הנוכחי מיד).
        await SubscribeBridgeAsync(ct);
    }

    // מנוי ל-topic מצב-הגשר, ומסמן הצלחה בדגל. מופרד כדי ש-EnsureConnected יוכל
    // לנסות מנוי מחדש אם הוא נכשל בעוד החיבור עצמו נשאר פתוח.
    private async Task SubscribeBridgeAsync(CancellationToken ct)
    {
        var subscribe = new MqttClientSubscribeOptionsBuilder()
            .WithTopicFilter(BridgeConfigWriter.RemoteBridgeStateTopic(_siteCode), MqttQualityOfServiceLevel.AtLeastOnce)
            .Build();
        await _client.SubscribeAsync(subscribe, ct);
        _subscribed = true;
    }

    /// <summary>
    /// מוודא שיש חיבור פתוח ל-Broker. אם כבר מחוברים — לא קורה כלום;
    /// אחרת מנסה להתחבר מחדש. בטוח לקרוא לזה לפני כל פרסום, כדי להתאושש
    /// מניתוקים (למשל כש-Mosquitto עדיין לא עלה בזמן שה-Agent התחיל).
    /// זורק חריגה אם ההתחברות נכשלה — מי שקורא צריך לטפל ולנסות שוב.
    /// </summary>
    public async Task EnsureConnectedAsync(CancellationToken ct = default)
    {
        if (!_client.IsConnected)
        {
            await ConnectAsync(ct);
            return;
        }

        // מחוברים אך המנוי נכשל בחיבור קודם — מנסים להירשם שוב. אחרת מצב-הגשר
        // לא יתעדכן לעולם, ה-Tray יישאר אפור, וה-resync של layer-2 לא ייורה.
        if (!_subscribed)
            await SubscribeBridgeAsync(ct);
    }

    /// <summary>משדר הודעת state ל-topic של המצב.</summary>
    /// <summary>
    /// נקרא אחרי **כל** פרסום מוצלח, עם ההודעה עצמה.
    ///
    /// ⚠️ קיים כדי שיהיה מקום **אחד** שרואה את כל מה שהסוכן שידר. Worker
    /// משדר משישה מקומות, ושכפול בכל אחד מהם הוא הזמנה לפספס את השביעי.
    /// </summary>
    public Action<object>? OnPublished { get; set; }

    public Task PublishStateAsync(StateMessage message, CancellationToken ct = default)
        => PublishAsync(StateTopic, message, ct);

    /// <summary>
    /// משדר הודעת operation ל-topic של הפעולות.
    ///
    /// ⚠️ <b>ואינו מודיע לצופה — בכוונה.</b> תפעולים נכנסים ל-<c>PendingQueue</c>
    /// לפני השידור ומשודרים משם, וכשל משאיר אותם בתור לניסיון הבא. לכן
    /// הודעה אחת עוברת כאן <b>פעם אחת לכל ניסיון</b>, לא פעם אחת בחיים —
    /// והודעה לצופה כאן הייתה שולחת אותה ל-Supabase שוב ושוב לאורך כל
    /// הנתק, כלומר מאות בקשות מיותרות בדיוק במצב שהמסלול השני קיים בשבילו.
    ///
    /// המרכוז שלהם קורה ב-<c>Worker</c> ברגע ההכנסה לתור — פעם אחת לכל
    /// פעולה, וזו נקודת ה<b>הפקה</b> האמיתית שלה.
    /// </summary>
    public Task PublishOperationAsync(OperationMessage message, CancellationToken ct = default)
        => PublishAsync(OperationTopic, message, ct, notifyObserver: false);

    // הליבה המשותפת: הופך אובייקט ל-JSON ומפרסם ב-QoS 1.
    private async Task PublishAsync(string topic, object payload, CancellationToken ct,
                                    bool notifyObserver = true)
    {
        string json = JsonSerializer.Serialize(payload);

        var mqttMessage = new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload(json)
            .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce) // QoS 1
            .WithRetainFlag(false)   // לפי החוזה: retain=false בכל ההודעות
            .Build();

        // ============================================================
        // ⚠️ הצופה יורה **לפני** ניסיון הפרסום, ובכוונה
        // ============================================================
        // הוא ישב כאן אחרי הפרסום, עם הנימוק "הודעה שנכשלה ב-MQTT אינה
        // אמורה להיכתב במקום אחר כאילו נמסרה". הנימוק היה נכון **כל עוד
        // MQTT הוא ערוץ המסירה** וה-Supabase רק משקף אותו.
        //
        // ⚠️ **אבל זו בדיוק הסיבה שאי אפשר היה לכבות את MQTT:** הכתיבה
        // הישירה הייתה מראה של פרסום מוצלח, לא ערוץ מסירה עצמאי. ברוקר
        // מת פירושו אפס פרסומים, אפס קריאות לצופה, ואפס כתיבה ל-Supabase —
        // בזמן שהדופק ממשיך לפעום ולהראות שהאתר בסדר גמור.
        //
        // ⚠️ **ונמדד בשטח, לא רק נקרא בקוד.** באתר 2438, כל שש הכתיבות
        // הישירות בלוג התרחשו **אחרי** שהברוקר חזר:
        //     14:14:37  Broker connection lost
        //     14:14:39  reconnected
        //     14:14:40  -> Supabase: 1 message written directly
        // אף כתיבה ישירה אחת לא קרתה בזמן שהברוקר היה למטה.
        //
        // עכשיו ההודעה נמסרת ל-Supabase גם כשהברוקר נפל — וזה **אינו**
        // "כאילו נמסרה": היא באמת נמסרה, בערוץ אחר. `SentAuditLog` נשאר
        // אחרי הפרסום, כי הוא כן מתעד מה יצא ב-MQTT בלבד.
        if (notifyObserver)
        {
            try { OnPublished?.Invoke(payload); }
            catch { /* צופה שנכשל לעולם אינו מפיל שידור */ }
        }

        // timeout על ה-publish: socket half-open (הצד השני נעלם בלי RST) היה מקפיא
        // את QoS-1 בהמתנה ל-PUBACK עד ה-keepalive הפנימי (~15s) — וכל לולאת ה-Worker
        // (קריאת PLC, heartbeat) נתקעת. מנתקים על timeout כדי שהסבב הבא יתחבר מחדש.
        using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            cts.CancelAfter(TimeSpan.FromSeconds(5));
            try
            {
                await _client.PublishAsync(mqttMessage, cts.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // ה-timeout *שלנו* נורה (ולא כיבוי המערכת): שוברים את ה-socket התקוע
                // כדי שה-EnsureConnected הבא יבנה חיבור חדש; ההודעה תשודר שוב בסבב הבא.
                try { await _client.DisconnectAsync(); } catch { }
                _subscribed = false;
                throw new TimeoutException($"MQTT publish to '{topic}' timed out (broker unresponsive).");
            }
        }

        // תופעת-לוואי בלבד, *אחרי* פרסום מוצלח: רישום ה-audit המקומי (מה נשלח).
        // נבלע בשקט אם ייכשל — לא משנה לוגיקה, תזמון או אמינות של השידור עצמו.
        //
        // ⚠️ **וזה נשאר כאן ולא עבר למעלה עם הצופה**: הוא עונה על "מה שודר
        // ב-MQTT", וזו שאלה אחרת מ"מה נמסר". ערבוב השניים היה הופך את
        // `agent-sent-*.jsonl` לחסר משמעות בדיוק כשחוקרים נתק.
        SentAuditLog.Log(topic, json);
    }

    /// <summary>מתנתק בצורה מסודרת ומשחרר משאבים.</summary>
    public async ValueTask DisposeAsync()
    {
        if (_client.IsConnected)
        {
            // ניתוק "נקי" (DisconnectAsync) *זורק* את ה-LWT לפי תקן MQTT, כך שעל
            // עצירה מסודרת (reboot / עדכון / שירות שנעצר) השרת לא היה מקבל no_comm
            // והאתר היה נראה "פועל" עד שה-keepalive של הגשר יבחין. משדרים no_comm
            // מפורשות לפני הניתוק — עקבי עם מסלול ה-Kill של ה-Tray, שכן מפעיל LWT.
            // best-effort בלבד, עם timeout קצר, כדי לא לתקוע את הכיבוי.
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                var down = new StateMessage
                {
                    Timestamp = _clock.UnixNow(),  // שניות שלמות (חוזה), משעון מסונכרן NTP
                    State = SiteState.NoComm
                };
                await PublishStateAsync(down, cts.Token);
            }
            catch { /* עצירה — לא מפילים על כשל שידור הפרידה */ }

            try { await _client.DisconnectAsync(); } catch { /* כנ"ל */ }
        }

        _client.Dispose();
    }
}