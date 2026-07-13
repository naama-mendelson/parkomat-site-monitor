using MQTTnet;
using MQTTnet.Protocol;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
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

    public MqttPublisher(MqttConfig config, string siteCode)
    {
        _config = config;
        _siteCode = siteCode;

        var factory = new MqttClientFactory();
        _client = factory.CreateMqttClient();

        // מאזין להודעות מ-Mosquitto — בפרט למצב חיבור הגשר ל-HiveMQ.
        _client.ApplicationMessageReceivedAsync += OnMessageReceived;
    }

    public bool IsConnected => _client.IsConnected;

    /// <summary>
    /// האם גשר ה-Mosquitto מחובר כרגע ל-HiveMQ (לפי הודעת ה-notification המקומית).
    /// false עד שמתקבל דיווח "1", וכן בכל ניתוק.
    /// </summary>
    public bool HiveMqBridgeConnected { get; private set; }

    // מטפל בהודעות נכנסות: מעדכן את מצב הגשר ל-HiveMQ לפי ה-topic הייעודי.
    private Task OnMessageReceived(MqttApplicationMessageReceivedEventArgs e)
    {
        if (e.ApplicationMessage.Topic == BridgeConfigWriter.BridgeStateTopic)
        {
            string payload = e.ApplicationMessage.ConvertPayloadToString()?.Trim() ?? "";
            HiveMqBridgeConnected = payload == "1";
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
        // בכל חיבור מחדש מאפסים את מצב הגשר עד שנקבל דיווח עדכני (retained).
        HiveMqBridgeConnected = false;

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
        var subscribe = new MqttClientSubscribeOptionsBuilder()
            .WithTopicFilter(BridgeConfigWriter.BridgeStateTopic, MqttQualityOfServiceLevel.AtLeastOnce)
            .Build();
        await _client.SubscribeAsync(subscribe, ct);
    }

    /// <summary>
    /// מוודא שיש חיבור פתוח ל-Broker. אם כבר מחוברים — לא קורה כלום;
    /// אחרת מנסה להתחבר מחדש. בטוח לקרוא לזה לפני כל פרסום, כדי להתאושש
    /// מניתוקים (למשל כש-Mosquitto עדיין לא עלה בזמן שה-Agent התחיל).
    /// זורק חריגה אם ההתחברות נכשלה — מי שקורא צריך לטפל ולנסות שוב.
    /// </summary>
    public async Task EnsureConnectedAsync(CancellationToken ct = default)
    {
        if (_client.IsConnected)
            return;

        await ConnectAsync(ct);
    }

    /// <summary>משדר הודעת state ל-topic של המצב.</summary>
    public Task PublishStateAsync(StateMessage message, CancellationToken ct = default)
        => PublishAsync(StateTopic, message, ct);

    /// <summary>משדר הודעת operation ל-topic של הפעולות.</summary>
    public Task PublishOperationAsync(OperationMessage message, CancellationToken ct = default)
        => PublishAsync(OperationTopic, message, ct);

    // הליבה המשותפת: הופך אובייקט ל-JSON ומפרסם ב-QoS 1.
    private async Task PublishAsync(string topic, object payload, CancellationToken ct)
    {
        string json = JsonSerializer.Serialize(payload);

        var mqttMessage = new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload(json)
            .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce) // QoS 1
            .WithRetainFlag(false)   // לפי החוזה: retain=false בכל ההודעות
            .Build();

        await _client.PublishAsync(mqttMessage, ct);
    }

    /// <summary>מתנתק בצורה מסודרת ומשחרר משאבים.</summary>
    public async ValueTask DisposeAsync()
    {
        if (_client.IsConnected)
            await _client.DisconnectAsync();

        _client.Dispose();
    }
}