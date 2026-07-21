using System.Globalization;
using System.Text.Json;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Logging;

/// <summary>
/// יומן audit מקומי של הודעות ה-MQTT ששודרו — רשומת אמת של מה שה-Agent *באמת*
/// שלח, להשוואה מול הדשבורד אם משהו נראה לא תקין.
///
/// זו **תופעת-לוואי בלבד**: לעולם לא חוסמת, מאטה או מפילה את ה-Agent. כל שגיאה
/// (דיסק מלא, קובץ נעול, הרשאות) נבלעת בשקט וה-Agent ממשיך בדיוק כרגיל.
///
/// פורמט: JSONL — שורה אחת (אובייקט JSON) לכל הודעה, בקובץ יומי
/// ...\Parkomat\Agent\logs\agent-sent-YYYY-MM-DD.jsonl (לצד ה-agent-*.log הרגיל).
/// כל שורה: { "ts": &lt;זמן UTC בפרסום, בסיומת Z&gt;, "topic": &lt;ה-topic&gt;, "payload": &lt;ה-JSON שנשלח&gt; }.
/// חותמת הזמן וגם תאריך הקובץ היומי הם ב-UTC — עקבי עם ה-DB וה-server (הכול UTC),
/// כדי שההשוואה מול הדשבורד תהיה ישירה.
/// שמירה: 31 הימים האחרונים; קבצים ישנים יותר נמחקים בהפעלה (בשידור הראשון) ופעם ביום.
/// </summary>
public static class SentAuditLog
{
    private const int RetentionDays = 31;

    // מסנכרן כתיבות מקבילות. שידורים נדירים יחסית (state/operation), ולכן ה-lock זניח.
    private static readonly object _gate = new();

    // היום שבו רץ הניקוי לאחרונה — כדי לנקות פעם ביום (וגם בשידור הראשון, כש-MinValue).
    private static DateTime _lastCleanupDate = DateTime.MinValue;

    /// <summary>
    /// רושם הודעה ששודרה *בהצלחה*. <paramref name="payloadJson"/> הוא ה-JSON המדויק
    /// שנשלח — מוטמע כאובייקט מקונן (לא כמחרוזת כפולת-קידוד). לעולם לא זורק.
    /// </summary>
    public static void Log(string topic, string payloadJson)
    {
        try
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;

            // בונים את השורה ידנית כדי שה-payload יוטמע כאובייקט ולא כמחרוזת.
            // ts ו-topic עוברים JSON-escape תקין דרך JsonSerializer; payloadJson כבר JSON.
            // חותמת UTC בסיומת Z (3 ספרות מילישנייה) — כמו חותמות הזמן ב-DB.
            string ts = JsonSerializer.Serialize(
                now.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            string topicJson = JsonSerializer.Serialize(topic);
            string line = $"{{\"ts\":{ts},\"topic\":{topicJson},\"payload\":{payloadJson}}}";

            lock (_gate)
            {
                Directory.CreateDirectory(AgentPaths.LogsFolder);
                MaybeCleanup(now.Date);

                string file = Path.Combine(AgentPaths.LogsFolder, $"agent-sent-{now:yyyy-MM-dd}.jsonl");
                // AppendAllText פותח-כותב-סוגר בכל שורה: ה-flush מובטח, כך שקריסה
                // לא מאבדת את השורות האחרונות.
                File.AppendAllText(file, line + Environment.NewLine);
            }
        }
        catch
        {
            // תופעת-לוואי בלבד — כישלון רישום לעולם לא משפיע על ה-Agent.
        }
    }

    // מוחק קבצי audit מעל 31 יום. רץ פעם ביום (וגם בשידור הראשון, כש-_lastCleanupDate
    // עדיין MinValue). נקרא בתוך ה-lock, ולכן לא מתנגש עם כתיבה.
    private static void MaybeCleanup(DateTime today)
    {
        if (today == _lastCleanupDate)
            return;
        _lastCleanupDate = today;

        try
        {
            DateTime cutoff = today.AddDays(-RetentionDays);
            foreach (string path in Directory.EnumerateFiles(AgentPaths.LogsFolder, "agent-sent-*.jsonl"))
            {
                string name = Path.GetFileNameWithoutExtension(path); // agent-sent-YYYY-MM-DD
                if (name.Length < 10)
                    continue;

                string datePart = name[^10..]; // YYYY-MM-DD
                if (DateTime.TryParseExact(datePart, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                        DateTimeStyles.None, out DateTime fileDate)
                    && fileDate < cutoff)
                {
                    try { File.Delete(path); } catch { /* קובץ נעול — ננסה שוב מחר */ }
                }
            }
        }
        catch
        {
            // ניקוי הוא nice-to-have; כשל בו לא משפיע על ה-Agent.
        }
    }
}
