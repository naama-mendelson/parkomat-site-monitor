using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// סימן החיים — הדבר שיחליף את הצוואה של MQTT.
///
/// ============================================================
/// ⚠️ למה בדיקה מבנית, ובמפורש
/// ============================================================
/// הדופק חי בתוך לולאת <c>ExecuteAsync</c> של <c>Worker</c>, שדורשת
/// PLC, MQTT ושעון — כלומר אי אפשר להריץ אותה כאן. מה שכן אפשר לנעול
/// הוא ה<b>חיווט</b>: שהמרווח חמש דקות, שהתנאי כולל אצווה ריקה, ושהחותם
/// מתעדכן רק על הצלחה. אלה שלוש ההחלטות שאם אחת מהן תיהרס — הדופק
/// ייראה עובד ולא יגן.
///
/// ⚠️ <b>וזה בדיוק דפוס <c>SettingsFormWiringTests</c></b>, מאותה סיבה:
/// כשל שקט בשכבה שאין בה DOM ואין בה שרת.
/// </summary>
public class HeartbeatWiringTests
{
    private static string Worker()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string path = Path.Combine(dir!.FullName, "src", "Parkomat.Agent.Service", "Worker.cs");
        Assert.True(File.Exists(path), $"קובץ חסר: {path}");
        return File.ReadAllText(path);
    }

    [Fact]
    public void TheIntervalMatchesTheMqttKeepalive()
    {
        // ⚠️ 60 שניות — בדיוק ה-keepalive של MQTT היום, ו"כלל 90 השניות"
        // הוא 1.5 × אותו מספר. כלומר המעבר ל-HTTPS אינו מוסיף סקר; הוא
        // מזיז את השעון מ-HiveMQ ל-pg_cron. הסף בצד השרת (3 דקות) הוא
        // שלוש פעימות שהוחמצו, ושינוי כאן בלי שינוי שם שובר את היחס.
        Assert.Matches(new Regex(@"HeartbeatInterval\s*=\s*TimeSpan\.FromSeconds\(60\)"), Worker());
    }

    [Fact]
    public void TheBeatGoesThroughBeatAsyncAndNotSendAsync()
    {
        // ⚠️ **הבדיקה שהייתה חסרה, והפיצ'ר היה מת בלעדיה.**
        // `SendAsync` חוסם אצווה ריקה בשורה הראשונה ומחזיר `Success(0)` בלי
        // לשלוח בקשה. הגרסה הראשונה של הדופק קראה לו עם רשימה ריקה: הפעימה
        // "הצליחה", `lastBeat` התקדם, ו**שום בקשה לא יצאה לרשת מעולם**.
        // שלוש בדיקות חיווט עברו, כי כולן בדקו את Worker ולא את הכבל.
        string src = Worker();
        Assert.Matches(new Regex(@"outgoing\.Count\s*>\s*0\s*\?[\s\S]{0,300}?BeatAsync"), src);
    }

    [Fact]
    public void TheBeatCarriesTheAgentVersion()
    {
        // ⚠️ פער מתועד: *"אין דיווח גרסה בשום topic, אי אפשר לדעת מרחוק מי
        // קיבל מה"*. הפעימה יוצאת כל דקה בין כה, ולכן היא הנשא הזול ביותר.
        string src = Worker();
        Assert.Matches(new Regex(@"AssemblyInformationalVersionAttribute"), src);
        Assert.Matches(new Regex(@"BeatAsync\(agentVersion"), src);
    }

    [Fact]
    public void ItFiresOnAnEmptyBatch()
    {
        // ⚠️ **זו כל הנקודה.** אצווה עם הודעות כבר מוכיחה חיים; מה שחסר
        // הוא ההוכחה כשאין מה לשלוח. תנאי שדורש `mirrored.Count > 0`
        // בלבד היה משאיר אתר שקט להיראות מת.
        string src = Worker();
        Assert.Matches(new Regex(@"beatDue\s*=.*mirrored\.Count\s*==\s*0", RegexOptions.Singleline), src);
        // ⚠️ `outgoing` ולא `mirrored`: מאז הניסיון החוזר, האצווה היוצאת היא
        // התור + החדשות. פעימה נשלחת רק כששתיהן ריקות — אחרת יש מה לכתוב,
        // והכתיבה ממילא מעדכנת את `alive`.
        Assert.Matches(new Regex(@"outgoing\.Count\s*>\s*0\s*\|\|\s*beatDue"), src);
    }

    [Fact]
    public void TheFirstBeatGoesOutImmediately()
    {
        // ⚠️ MinValue ולא UtcNow: סוכן שעלה מחדש אחרי הפסקת חשמל חייב
        // להיראות חי מיד. אתחול ל"עכשיו" היה משאיר אותו שקט חמש דקות —
        // בדיוק בחלון שבו מישהו בודק אם הוא חזר.
        Assert.Matches(new Regex(@"lastBeat\s*=\s*DateTimeOffset\.MinValue"), Worker());
    }

    [Fact]
    public void TheStampMovesOnlyOnSuccess()
    {
        // ⚠️ פעימה שנכשלה ברשת אינה סימן חיים שהגיע ליעדו. עדכון החותם
        // ללא תנאי היה דוחה את הניסיון הבא בחמש דקות נוספות — בדיוק
        // כשהקשר רעוע, כלומר כשהוא הכי נחוץ.
        Assert.Matches(new Regex(@"if\s*\(res\.Ok\)\s*lastBeat\s*="), Worker());
    }

    [Fact]
    public void TheHeartbeatDoesNotFloodTheLog()
    {
        // ⚠️ 288 שורות ביום. ב-Information הן היו קוברות את מה שכן קרה,
        // ולוג שאי אפשר לקרוא הוא לוג שאין.
        Assert.Matches(new Regex(@"LogDebug\(""->\s*Supabase:\s*heartbeat"), Worker());
    }
}
