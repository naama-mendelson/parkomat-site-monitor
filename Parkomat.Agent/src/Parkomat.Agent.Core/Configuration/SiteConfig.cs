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

    /// <summary>
    /// כתיבה ישירה ל-Supabase — **כבויה עד שממלאים אותה**.
    ///
    /// ⚠️ חיה **לצד** MQTT ולא במקומו. כל עוד השדות ריקים הסוכן מתנהג
    /// בדיוק כמו קודם, ולכן אפשר לשגר את הגרסה ל-16 האתרים בלי לשנות דבר
    /// בהתנהגותם. הפעלה היא מילוי ארבעה שדות באתר **אחד**, וכיבוי הוא
    /// מחיקתם — אותו דפוס בדיוק כמו מתג VITE_SUPABASE_DIRECT בדשבורד.
    /// </summary>
    public SupabaseConfig Supabase { get; set; } = new();

    /// <summary>
    /// האם לשדר ב-MQTT. <b>נגזר, ולא נקרא ישירות מהקובץ</b>.
    ///
    /// ============================================================
    /// ⚠️ כיבוי MQTT תופס רק כשיש מסלול ישיר שעובד
    /// ============================================================
    /// <c>Mqtt.Disabled</c> לבדו אינו מספיק. אתר שבו כיבו את MQTT ואין בו
    /// סיסמת Supabase אינו "אתר במצב חדש" — הוא <b>אתר שאינו מדווח לשום
    /// מקום</b>, והכשל שקט לחלוטין: הסוכן רץ, ה-PLC נקרא, הסמל ירוק, ואף
    /// שורה בלוג אינה אומרת שהנתונים אינם מגיעים לאיש.
    ///
    /// לכן הכיבוי מותנה ב-<c>Supabase.Enabled</c>. אותו שיקול בדיוק שבגללו
    /// <c>SupabaseConfig.Enabled</c> נגזר ואינו נשמר: <b>מצב שאסור שיתקיים
    /// לא צריך להיות ניתן לביטוי</b>.
    ///
    /// ⚠️ ולכן גם אין תיבת סימון בטופס. אין כאן גמישות אלא מלכודת — לחיצה
    /// אחת של טכנאי בשדה הייתה משביתה אתר, בדיוק כמו שהוסרה תיבת ה-TLS.
    /// ההפעלה היא עריכה ידנית של <c>config.json</c>, פעולה מודעת.
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool MqttEnabled => !(Mqtt.Disabled && Supabase.Enabled);

    /// <summary>כל כמה מילי-שניות לקרוא מה-PLC. ברירת מחדל: שנייה.</summary>
    public int PollIntervalMs { get; set; } = 1000;

    /// <summary>
    /// שרת ה-NTP שממנו נלקח הזמן לחותמות של הפעולות.
    ///
    /// חותמת הזמן של פעולה קובעת *מתי בדיוק היא קרתה באתר*, ולכן היא לא יכולה
    /// להישען על שעון Windows של מחשב שאיש לא מתחזק. הסוכן שואל את השרת הזה
    /// אחת לשעה, מחשב היסט, ומחיל אותו על מה שהוא משדר (ראה AgentClock).
    ///
    /// ריק = מכבה את הסנכרון וחוזר לשעון המקומי. באתר עם UDP/123 חסום אפשר
    /// להזין כאן שרת NTP פנימי של הארגון.
    /// </summary>
    public string NtpServer { get; set; } = "pool.ntp.org";

    /// <summary>כל כמה דקות לסנכרן מול שרת ה-NTP. 0 ומטה = ברירת המחדל (60).</summary>
    public int NtpSyncIntervalMinutes { get; set; } = 60;
}

/// <summary>הגדרות החיבור והכתובות ב-PLC (Modbus, מעל TCP או UDP).</summary>
public class PlcConfig
{
    /// <summary>כתובת ה-IP של ה-PLC.</summary>
    public string IpAddress { get; set; } = "192.168.1.3";

    /// <summary>פורט Modbus. ברירת המחדל התקנית היא 502, גם ב-TCP וגם ב-UDP.</summary>
    public int Port { get; set; } = 502;

    // ============================================================
    // תעבורה: TCP או UDP
    // ============================================================
    // יש בקרים שחושפים Modbus מעל UDP בלבד. NModbus תומכת בשניהם
    // (‏CreateMaster מקבל גם TcpClient וגם UdpClient), אז זו בחירה ולא פורט.
    //
    // ⚠️ **מחרוזת ולא bool, ובכוונה.** ‏`UseUdp=false` היה קורא "לא UDP"
    // ולא אומר מה כן; ‏`Transport="tcp"` הוא מה שכתוב בקובץ וגם מה
    // שהטכנאי רואה. וכשיתווסף RTU טורי, לא צריך bool שני שסותר את הראשון.
    /// <summary>‏"tcp" (ברירת מחדל) או "udp".</summary>
    public string Transport { get; set; } = "tcp";

    /// <summary>
    /// האם לדבר UDP. <b>נגזר, ולא נקרא ישירות מהקובץ.</b>
    ///
    /// ⚠️ ערך לא מוכר (‏"UDP ", "tcp/udp", שגיאת הקלדה) נופל ל-<b>TCP</b>,
    /// כלומר להתנהגות של היום — ולא לקריסה ולא ל-UDP. אותו עיקרון כמו
    /// <c>MqttEnabled</c>: מצב שאסור שיתקיים לא צריך להיות ניתן לביטוי,
    /// ובספק — ההתנהגות הקיימת והעובדת.
    ///
    /// אבל <b>שקט זו לא התשובה</b>: <c>TransportIsKnown</c> קיים כדי
    /// שהסוכן יכתוב שורת אזהרה. ערך שגוי שנבלע היה מייצר אתר שקורא
    /// ב-TCP בזמן שהקובץ אומר UDP, ואת זה אי אפשר לאבחן מרחוק.
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool UseUdp => NormalizedTransport == "udp";

    /// <summary>האם הערך שבקובץ הוא אחד מהערכים המוכרים (או ריק).</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool TransportIsKnown =>
        NormalizedTransport is "" or "tcp" or "udp";

    private string NormalizedTransport => (Transport ?? "").Trim().ToLowerInvariant();

    /// <summary>
    /// פקודת ה-Modbus לקריאה: <b>4</b> = Input Registers (ברירת מחדל),
    /// <b>3</b> = Holding Registers.
    ///
    /// <para>⚠️ <b>מספר ולא מחרוזת</b>, בניגוד ל-<c>Transport</c>. שם היו
    /// שני ערכים שקולים ("tcp"/"udp") שאין ביניהם סדר, וכתיב שגוי הוא
    /// תקלה שקטה; כאן הערך הוא <b>מספר הפקודה עצמו</b> כפי שהוא מופיע
    /// בתקן ובתיעוד של יצרן הבקר, וכל ערך אחר הוא פשוט לא-פקודה.</para>
    ///
    /// <para>⚠️ <b>4 היא ברירת המחדל מפני שהיא נכונה לכל 21 האתרים
    /// הקיימים</b> — לא מפני שהיא "הרגילה". שינוי ברירת המחדל היה משנה
    /// את התנהגות כל הצי בהתקנה הבאה.</para>
    /// </summary>
    public int FunctionCode { get; set; } = 4;

    /// <summary>
    /// ⚠️ <b>נגזר, ולא נשמר.</b> אותו עיקרון כמו <c>UseUdp</c>: שדה שני
    /// שאפשר לסתור את הראשון הוא מצב שאסור שיהיה ניתן לביטוי.
    ///
    /// <para>⚠️ וכל ערך שאינו 3 נופל ל-FC 04 — <b>ההתנהגות הקיימת</b>.
    /// קובץ עם ערך שגוי לא יהפוך אתר עובד לאתר שקורא בפקודה אחרת.
    /// <c>FunctionCodeIsKnown</c> קיים כדי שהסוכן יכתוב אזהרה במקום
    /// לבלוע בשקט, בדיוק כמו <c>TransportIsKnown</c>.</para>
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool UseHoldingRegisters => FunctionCode == 3;

    /// <summary>האם הערך שבקובץ הוא פקודת קריאה מוכרת.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool FunctionCodeIsKnown => FunctionCode is 3 or 4;

    /// <summary>כתובת ה-register שממנה נקרא את ה-MODE.</summary>
    public int ModeRegister { get; set; } = 290;

    /// <summary>כתובת ה-register שממנה נקרא את מספר הכרטיס.</summary>
    public int CardRegister { get; set; } = 291;

    /// <summary>כתובת ה-register שממנה נקרא את ה-cycle counter.</summary>
    public int CycleRegister { get; set; } = 292;

    // ============================================================
    // טקסט התקלה — מחרוזת בסגנון C
    // ============================================================
    // הבקר חושף תיאור תקלה כמחרוזת: **תו אחד לכל register**, החל מכתובת 2,
    // ומסתיימת באפס (כמו C). אחריה יש אפסים.
    //
    // מה זה קונה: עד היום כל התקלות נראו זהות — "מושבת". אין דרך לדעת אם
    // זו תקלת חיישן, כרטיס שלא נקרא או תקלה מכנית. עם הטקסט אפשר לקבץ
    // תקלות לפי סוג ולומר "האתר נפל 6 פעמים, כולן מאותה סיבה".
    //
    // ⚠️ 0 = מכובה. מי שאין לו את התכונה בבקר לא ישלם עליה קריאה מיותרת,
    // ולא יקבל שדה ריק שנראה כמו נתון חסר.
    public int FaultTextRegister { get; set; } = 2;

    /// <summary>
    /// כמה registers לקרוא לכל היותר. הקריאה עוצרת באפס הראשון ממילא —
    /// זו תקרת בטיחות בלבד.
    ///
    /// ⚠️ מגבלת Modbus היא 125 registers בקריאה אחת. ערך גדול מזה היה
    /// נכשל בזמן ריצה מול הבקר, ולא בהגדרה — ולכן הוא נחתך ב-PlcReader.
    /// </summary>
    public int FaultTextMaxChars { get; set; } = 80;
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
    /// <summary>
    /// כיבוי מוחלט של מסלול ה-MQTT באתר הזה.
    ///
    /// ⚠️ <b>אינו נקרא ישירות — עוברים דרך <c>SiteConfig.MqttEnabled</c></b>,
    /// שמתנה אותו בכך שהמסלול הישיר באמת מוגדר. הנימוק המלא נמצא שם.
    ///
    /// כשהוא תופס: הסוכן אינו מתחבר לברוקר, אינו כותב <c>bridge.conf</c>
    /// (ולכן ה-Tray אינו מעלה את Mosquitto), ואינו מכניס תפעולים לתור
    /// ה-MQTT — תור שאיש לא ירוקן היה גדל עד התקרה ומוחק בכל סבב.
    /// </summary>
    public bool Disabled { get; set; } = false;

    /// <summary>כתובת ה-Broker של HiveMQ.</summary>
    public string Host { get; set; } = "af3d50e1ce154ed1af570331a0df4ff7.s1.eu.hivemq.cloud";

    /// <summary>פורט. 8883 = MQTT over TLS (הפורט של HiveMQ בענן).</summary>
    public int Port { get; set; } = 8883;

    /// <summary>שם משתמש להתחברות ל-Broker.</summary>
    public string Username { get; set; } = "agent";

    /// <summary>
    /// סיסמה להתחברות ל-Broker.
    ///
    /// ==========================================================
    /// למה זה לא מחרוזת כאן, ולמה זה גם לא סוד בקוד
    /// ==========================================================
    /// שתי דרישות שנראות סותרות, ושתיהן אמיתיות:
    ///   1. הבינארי המשוגר **חייב** להכיל את הסיסמה, אחרת כל התקנה באתר
    ///      דורשת הקלדה ידנית של טכנאי.
    ///   2. המאגר ציבורי, ולכן הסיסמה **אסורה** בקוד המקור.
    ///
    /// לכן הערך חי בקובץ אחד מוחרג-גיט — Parkomat.Agent/agent-defaults.password
    /// — וה-build צורב אותו לתוך BuildDefaults (ראה Core.csproj). בעץ מקור
    /// נקי, בלי הקובץ הזה, BuildDefaults.MqttPassword הוא **מחרוזת ריקה**,
    /// כלומר בדיוק מה שהיה כתוב כאן קודם.
    ///
    /// ניסיון קודם לפתור את זה פשוט הדביק את הסיסמה כאן. זה עמד להיכנס
    /// למאגר ציבורי. אל תחזירו את זה — עדכנו את הקובץ המוחרג.
    /// </summary>
    public string Password { get; set; } = BuildDefaults.MqttPassword;
}