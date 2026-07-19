namespace Parkomat.Agent.Core.Configuration;

public class SiteConfig
{
    /// <summary>מזהה ייחודי של האתר (למשל "site-01"). משמש בנתיב ה-MQTT.</summary>
    public string SiteId { get; set; } = "";

    /// <summary>שם תצוגה של האתר בדשבורד (למשל "חניון רוטשילד").</summary>
    public string SiteName { get; set; } = "";

    /// <summary>הגדרות החיבור ל-PLC.</summary>
    public PlcConfig Plc { get; set; } = new();

    /// <summary>הגדרות החיבור ל-Broker.</summary>
    public MqttConfig Mqtt { get; set; } = new();

    /// <summary>כל כמה מילי-שניות לקרוא מה-PLC. ברירת מחדל: שנייה.</summary>
    public int PollIntervalMs { get; set; } = 1000;
}

/// <summary>הגדרות החיבור והכתובות ב-PLC (Modbus-TCP).</summary>
public class PlcConfig
{
    /// <summary>כתובת ה-IP של ה-PLC.</summary>
    public string IpAddress { get; set; } = "127.0.0.1";

    /// <summary>פורט Modbus-TCP. ברירת המחדל התקנית היא 502.</summary>
    public int Port { get; set; } = 502;

    /// <summary>כתובת ה-register שממנה נקרא את ה-MODE.</summary>
    public int ModeRegister { get; set; } = 0;

    /// <summary>כתובת ה-register שממנה נקרא את מספר הכרטיס.</summary>
    public int CardRegister { get; set; } = 1;

    /// <summary>כתובת ה-register שממנה נקרא את ה-cycle counter.</summary>
    public int CycleRegister { get; set; } = 2;
}

/// <summary>הגדרות החיבור ל-Broker.</summary>
/// <summary>
/// הגדרות ההתחברות ל-HiveMQ (מוזנות לגשר ה-Mosquitto, לא ללקוח עצמו).
///
/// ==========================================================
/// אין כאן מתג TLS — וזה בכוונה.
/// ==========================================================
/// היה כאן שדה UseTls עם checkbox בטופס ההגדרות. זו הייתה טעות: הגשר
/// מתחבר ל-HiveMQ בענן, דרך האינטרנט, ומעביר את **שם המשתמש והסיסמה**
/// של האתר. חיבור בלי TLS פירושו לשדר אותם בטקסט גלוי.
///
/// מתג כזה אינו "גמישות" — הוא מלכודת: הוא נותן לטכנאי בשדה, בלחיצה
/// אחת ובלי אזהרה, להוריד את ההצפנה של כל האתר. ואם הוא נשאר כבוי בטעות,
/// שום דבר לא ייכשל בקול — ההודעות פשוט יזרמו לא מוצפנות.
///
/// TLS הוא עכשיו קבוע ולא ניתן לכיבוי (ראה BridgeConfigWriter).
/// </summary>
public class MqttConfig
{
    /// <summary>כתובת ה-Broker של HiveMQ.</summary>
    public string Host { get; set; } = "";

    /// <summary>פורט. 8883 = MQTT over TLS (הפורט של HiveMQ בענן).</summary>
    public int Port { get; set; } = 8883;

    /// <summary>שם משתמש להתחברות ל-Broker.</summary>
    public string Username { get; set; } = "";

    /// <summary>סיסמה להתחברות ל-Broker.</summary>
    public string Password { get; set; } = "";
}