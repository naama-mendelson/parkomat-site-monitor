using System.Text.Json;

namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// אחראי על קריאה וכתיבה של קובץ ההגדרות config.json מהדיסק.
/// גם ה-Service וגם ה-Tray משתמשים בו כדי לקרוא/לעדכן את אותו קובץ.
/// </summary>
public static class ConfigStore
{
    // אפשרויות לקריאה/כתיבה של JSON:
    // WriteIndented -> הקובץ יהיה קריא לבני אדם (עם רווחים ושורות).
    // PropertyNameCaseInsensitive -> קריאה סלחנית לגבי אותיות גדולות/קטנות.
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    /// <summary>
    /// טוען את ההגדרות מהדיסק.
    /// אם הקובץ לא קיים עדיין — יוצר קובץ ברירת מחדל ומחזיר אותו,
    /// כדי שבהרצה ראשונה במחשב חדש לא ניפול.
    /// </summary>
    public static SiteConfig Load()
    {
        AgentPaths.EnsureBaseFolderExists();

        if (!File.Exists(AgentPaths.ConfigFile))
        {
            var defaults = new SiteConfig();
            Save(defaults);
            return defaults;
        }

        string json = File.ReadAllText(AgentPaths.ConfigFile);
        SiteConfig? config = JsonSerializer.Deserialize<SiteConfig>(json, Options);

        // אם מסיבה כלשהי הקובץ ריק או פגום — מחזירים ברירת מחדל במקום לקרוס.
        return config ?? new SiteConfig();
    }

    /// <summary>
    /// שומר את ההגדרות לדיסק, בכתיבה בטוחה:
    /// כותבים קודם לקובץ זמני ואז מחליפים, כדי שאם החשמל נופל
    /// באמצע הכתיבה — קובץ ההגדרות המקורי לא נהרס.
    /// </summary>
    public static void Save(SiteConfig config)
    {
        AgentPaths.EnsureBaseFolderExists();

        string json = JsonSerializer.Serialize(config, Options);

        string tempFile = AgentPaths.ConfigFile + ".tmp";
        File.WriteAllText(tempFile, json);

        // החלפה אטומית: או שהקובץ הישן נשאר, או שהחדש נכנס במלואו.
        File.Move(tempFile, AgentPaths.ConfigFile, overwrite: true);
    }
}