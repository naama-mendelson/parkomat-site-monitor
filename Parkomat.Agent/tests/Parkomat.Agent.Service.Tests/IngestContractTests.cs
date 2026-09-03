using System.Text.Json;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// החוזה מול <c>public.ingest_batch</c> — <b>קובץ אחד, שני צדדים</b>.
///
/// <para>
/// ⚠️ <b>הבעיה שזה פותר.</b> הבדיקות האחרות מוודאות שה-C# מייצר את הצורה
/// שה-C# מצפה לה — כלומר הן משוות את הקוד לעצמו. השרת הוא שכבה אחרת לגמרי,
/// בשפה אחרת, ואף בדיקה כאן אינה יכולה לשאול אותו. שדה בשם שגוי מגיע
/// כ-<c>NULL</c>, ההודעה נכתבת חסרה, ואין שגיאה בשום צד.
/// </para>
///
/// <para>
/// ⚠️ <b>לכן הקובץ.</b> <c>shared/contracts/ingest-batch.sample.json</c> הוא
/// המקור: הבדיקה כאן מוודאת שה-C# מייצר בדיוק אותו, ו-<c>check-agent-write</c>
/// בשרת <b>שולח אותו כמות שהוא</b> ל-PostgREST. אם הסוכן סוטה — הבדיקה
/// הזו נופלת. אם השרת סוטה — השער נופל. אף אחד מהם אינו יכול לזוז לבד.
/// </para>
///
/// <para>
/// ⚠️ זה בדיוק הדפוס שכבר קיים בפרויקט: "שני קוראים, חוזה אחד" בטבלת
/// <c>events</c>, ושתי זרועות המתג בדשבורד שחייבות להחזיר צורה זהה.
/// </para>
/// </summary>
public class IngestContractTests
{
    // מהתיקייה של קובצי הבדיקה אל שורש המאגר.
    private static string ContractPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "shared", "contracts")))
            dir = dir.Parent;

        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "shared", "contracts", "ingest-batch.sample.json");
    }

    /// <summary>אותה אצווה שהקובץ מתאר, נבנית מהודעות סוכן אמיתיות.</summary>
    private static string BuildSame()
    {
        long t = 1788256800;   // 2026-09-01T10:00:00Z
        return BatchPayload.Serialize([
            BatchPayload.From(new StateMessage { Timestamp = t, State = SiteState.Operating }),
            BatchPayload.From(new OperationMessage
            {
                Timestamp = t, StartEnd = "start", EntryExit = "entry",
                User = "77", CycleCounter = 100, State = SiteState.Operating,
            }),
            BatchPayload.From(new OperationMessage
            {
                Timestamp = t + 30, StartEnd = "end", EntryExit = "entry",
                User = "", CycleCounter = 101, State = SiteState.Operating,
            }),
            BatchPayload.From(new StateMessage
            {
                Timestamp = t + 35, State = SiteState.Error,
                FaultText = "מיטה 5 - בוכנה 2: זמן מקסימלי לפעולה",
            }),
        ], ContractVersion);
    }

    /// <summary>
    /// ⚠️ <b>מספר קבוע ולא הגרסה האמיתית, ובכוונה.</b> הסוכן שולח את גרסת
    /// ההרכבה שלו, שמשתנה בכל שחרור. חוזה שנועל אותה היה נשבר בכל עדכון
    /// גרסה — כישלון שאינו מעיד על דבר, ושער אדום שמופיע בכל שחרור הוא
    /// שער שלומדים להתעלם ממנו. מה שנעול כאן הוא ש<b>השדה קיים ובשמו</b>.
    /// </summary>
    private const string ContractVersion = "1.0.0-contract";

    [Fact]
    public void ContractFileExists()
    {
        // ⚠️ בלי זה, קובץ שנמחק היה הופך את שאר הבדיקות ל"עוברות" בשקט.
        Assert.True(File.Exists(ContractPath()),
            $"קובץ החוזה חסר: {ContractPath()}");
    }

    [Fact]
    public void AgentProducesExactlyTheContract()
    {
        using var expected = JsonDocument.Parse(File.ReadAllText(ContractPath()));
        using var actual = JsonDocument.Parse(BuildSame());

        // ⚠️ השוואה **מנורמלת** ולא טקסטואלית: רווחים וסדר מפתחות אינם חלק
        // מהחוזה, ו-JSON שנבדל בהזחה בלבד היה מפיל את הבדיקה על כלום. מה
        // שכן בחוזה: אילו שדות קיימים, בשמות אילו, ועם אילו ערכים.
        Assert.Equal(Normalize(expected.RootElement), Normalize(actual.RootElement));
    }

    [Fact]
    public void ContractCoversBothKindsAndTheEmptyCard()
    {
        // ⚠️ חוזה שמכסה רק את המקרה השגרתי נראה זהה לחוזה שאינו מכסה כלום.
        // שלושת אלה הם בדיוק הכללים שנמדדו בשטח: שני סוגי הודעה, סגירה
        // עם כרטיס ריק, ותיאור תקלה.
        using var doc = JsonDocument.Parse(File.ReadAllText(ContractPath()));
        var arr = doc.RootElement.GetProperty("p_messages");

        var kinds = arr.EnumerateArray().Select(e => e.GetProperty("kind").GetString()).ToList();
        Assert.Contains("state", kinds);
        Assert.Contains("operation", kinds);

        bool hasEmptyCard = arr.EnumerateArray().Any(e =>
            e.TryGetProperty("card", out var c) && c.GetString() == "");
        Assert.True(hasEmptyCard, "החוזה אינו מכסה סגירה עם כרטיס ריק");

        bool hasFault = arr.EnumerateArray().Any(e => e.TryGetProperty("fault_text", out _));
        Assert.True(hasFault, "החוזה אינו מכסה תיאור תקלה");
    }

    /// <summary>ייצוג יציב: מפתחות ממוינים, מערכים בסדרם.</summary>
    private static string Normalize(JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Object:
                var parts = e.EnumerateObject()
                    .OrderBy(p => p.Name, StringComparer.Ordinal)
                    .Select(p => $"{JsonSerializer.Serialize(p.Name)}:{Normalize(p.Value)}");
                return "{" + string.Join(",", parts) + "}";
            case JsonValueKind.Array:
                return "[" + string.Join(",", e.EnumerateArray().Select(Normalize)) + "]";
            default:
                return e.GetRawText();
        }
    }
}
