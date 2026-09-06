using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// כיבוי MQTT — המצב שבו הכתיבה הישירה היא המסלול <b>היחיד</b>.
///
/// ⚠️ <b>הכלל היחיד שחייב להחזיק: אתר תמיד מדווח לאיפשהו.</b> אתר שאינו
/// מדווח לשום מקום הוא התקלה הגרועה ביותר במערכת הזו — הסוכן רץ, ה-PLC
/// נקרא, הסמל ירוק, ואף שורה בלוג אינה אומרת שהנתונים אינם מגיעים לאיש.
/// בדיוק לכן הכיבוי <b>נגזר</b> ואינו נקרא ישירות מהקובץ.
/// </summary>
public class DirectOnlyTests
{
    private static SiteConfig Configured()
    {
        var c = new SiteConfig { SiteId = "2438" };
        c.Supabase.SiteId = "2438";
        c.Supabase.Password = "issued-once";
        return c;
    }

    [Fact]
    public void ByDefaultMqttIsOn()
    {
        // 17 האתרים שלא נגעו בהם חייבים להישאר בדיוק כפי שהם.
        Assert.True(new SiteConfig().MqttEnabled);
        Assert.False(new SiteConfig().Mqtt.Disabled);
    }

    [Fact]
    public void DisablingMqttWorksOnlyWhenTheDirectPathIsConfigured()
    {
        var c = Configured();
        Assert.True(c.Supabase.Enabled, "התנאי המקדים לא מתקיים — הבדיקה חסרת ערך");

        c.Mqtt.Disabled = true;
        Assert.False(c.MqttEnabled);
    }

    [Fact]
    public void ASiteWithNoDirectPathStaysOnMqttEvenIfAskedToStop()
    {
        // ⚠️ **זה הלב.** מי שיערוך את config.json ידנית באתר שאין בו סיסמה
        // מקבל אתר שאינו מדווח לשום מקום — וזה כשל שקט לחלוטין. המצב הזה
        // פשוט אינו ניתן לביטוי, אותו עיקרון בדיוק כמו SupabaseConfig.Enabled.
        var c = new SiteConfig { SiteId = "1358" };
        c.Supabase.SiteId = "1358";      // בלי סיסמה
        c.Mqtt.Disabled = true;

        Assert.False(c.Supabase.Enabled);
        Assert.True(c.MqttEnabled, "אתר בלי מסלול ישיר כובה מ-MQTT — הוא אינו מדווח לאיש");
    }

    [Fact]
    public void LosingTheSupabasePasswordBringsMqttBack()
    {
        // ⚠️ והתרחיש שנמדד בשטח כל היום: הסיסמה נמחקת בשדרוג. באתר שכובה
        // מ-MQTT זה היה משאיר אותו **מת**, ולא "מדווח בערוץ הישן".
        // הגזירה הופכת את זה לנפילה חזרה למסלול שעובד.
        var c = Configured();
        c.Mqtt.Disabled = true;
        Assert.False(c.MqttEnabled);

        c.Supabase.Password = "";        // מה שההתקנה עשתה
        Assert.True(c.MqttEnabled, "אתר שאיבד את הסיסמה נשאר בלי שום מסלול");
    }

    [Fact]
    public void TheChoiceSurvivesAnUpgrade()
    {
        // ⚠️ אחרת כל שדרוג מדליק מחדש את MQTT באתר שכובה בכוונה — והוא
        // מתחיל לשדר בשני המסלולים בלי שאיש ביקש.
        var inTheField = Configured();
        inTheField.Mqtt.Disabled = true;

        var after = ConfigStore.BuildResetConfig(inTheField);
        Assert.True(after.Mqtt.Disabled);

        after.Supabase.SiteId = after.SiteId;
        Assert.False(after.MqttEnabled);
    }

    [Fact]
    public void TheDecisionIsPersistedButTheDerivationIsNot()
    {
        // Disabled נשמר לקובץ (זו החלטה), MqttEnabled לא (הוא נגזר) —
        // אחרת קובץ ישן היה יכול לשאת ערך נגזר שסותר את המקורות שלו.
        var c = Configured();
        c.Mqtt.Disabled = true;
        string json = ConfigStore.ToJson(c);

        Assert.Contains("\"Disabled\": true", json);
        Assert.DoesNotContain("MqttEnabled", json);
    }

    // ============================================================
    // החיווט ב-Worker — בדיקות מבניות, אין כאן ברוקר ואין רשת
    // ============================================================

    private static string Worker()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Worker.cs"));
    }

    [Fact]
    public void TheBrokerStageIsSkippedNotThrownOutOf()
    {
        // ⚠️ הגרסה הראשונה יצאה מהשלב ב-`throw`, וה-catch שלמטה דיווח
        // "Broker connection lost" בכל סבב — על אתר שכובה בכוונה. שורת
        // אזהרה שקרית גרועה משורה חסרה: היא שולחת מישהו לתקן ברוקר תקין.
        string w = Worker();
        Assert.DoesNotContain("mqtt-off", w);
        Assert.Contains("if (config.MqttEnabled)", w);
    }

    [Fact]
    public void TheMqttQueueIsNotFilledWhenNobodyWillDrainIt()
    {
        // ⚠️ תור שאיש לא ירוקן גדל עד התקרה ואז מוחק את הישן ביותר **בכל
        // סבב** — כתיבה ומחיקה בלי סוף על הדיסק של מחשב שמריץ מחסום, בשביל
        // הודעות שלא יישלחו לעולם.
        string w = Worker();
        Assert.Contains("if (config.MqttEnabled) pendingOps.Enqueue(op);", w);
    }

    [Fact]
    public void TheBridgeConfigIsRemovedNotJustSkipped()
    {
        // ⚠️ ה-Tray מחליט אם להעלות את Mosquitto לפי remote_username שב-
        // bridge.conf. קובץ ישן שנשאר היה מחזיר את הברוקר לאוויר בהפעלה
        // הבאה — כלומר "כיביתי את MQTT" שמחזיק עד ה-reboot הראשון.
        string w = Worker();
        Assert.Contains("File.Delete(AgentPaths.BridgeConfigFile)", w);
    }

    [Fact]
    public void TheModeIsStatedInTheLogAtStartup()
    {
        // אתר שאינו מדווח הוא התקלה שהכי קשה לאתר. "באיזה מצב האתר הזה"
        // חייב להיקרא מהלוג, בלי לפתוח config.json במחשב שיושב בחניון.
        string w = Worker();
        Assert.Contains("MQTT is OFF for this site", w);
        // ⚠️ וגם המצב שנחסם: מי שביקש לכבות בלי מסלול ישיר חייב לדעת למה
        // זה לא קרה, אחרת הוא יחשוב שהכיבוי עבד.
        Assert.Contains("MQTT was asked to be OFF but the direct path is not configured", w);
    }

    [Fact]
    public void TheTrayDecidesFromTheConfigNotFromBridgeConf()
    {
        // ============================================================
        // ⚠️ נכשל בשטח: הלוג אמר "MQTT is OFF" ו-Mosquitto רץ לצדו
        // ============================================================
        // הגרסה הראשונה הסתמכה על כך שהסוכן מוחק את bridge.conf, ושבלעדיו
        // ה-Tray לא יעלה את Mosquitto. זה מרוץ: `Start()` מפעיל את הסוכן
        // ומיד בודק את הקובץ — לפני שהסוכן הספיק למחוק אותו. האתר שידר
        // בשני המסלולים בזמן שהוגדר לאחד, ואף שורה לא אמרה זאת.
        //
        // ⚠️ ובנוסף — כיבוי **אקטיבי**: Mosquitto שכבר רץ מלפני הכיבוי לא
        // הופעל בידי איש ולא נעצר בידי איש, כלומר היה ממשיך לנצח. בלי זה
        // המתג היה דורש הפעלה מחדש כדי לתפוס, ותלוי בסדר העלייה.
        string src = Manager();

        Assert.Contains("private static bool MqttOn()", src);
        Assert.Contains("if (MqttOn() && BridgeConfigHasUsername())", src);
        Assert.Contains("if (!startMosquitto || !MqttOn())", src);
        Assert.Contains("if (IsRunning(MosquittoProcName)) KillByName(MosquittoProcName);", src);

        // ⚠️ וברירת המחדל בכשל קריאה היא **דולק**. קובץ שלא נקרא אינו סיבה
        // להשבית את מסלול הדיווח היחיד שהוכח.
        int on = src.IndexOf("private static bool MqttOn()", StringComparison.Ordinal);
        Assert.Contains("catch { return true; }", src[on..(on + 400)]);

        static string Manager()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
                dir = dir.Parent;
            Assert.NotNull(dir);
            return File.ReadAllText(Path.Combine(dir!.FullName, "src",
                "Parkomat.Agent.Tray", "Services", "ServiceManager.cs"));
        }
    }

    [Fact]
    public void SavingTheSettingsFormDoesNotTurnMqttBackOn()
    {
        // ============================================================
        // ⚠️ נמדד באתר 2438, והוליך את האבחון שולל
        // ============================================================
        // `OnSave` בונה `MqttConfig` **מאפס** מארבעה שדות של הטופס, ואין
        // בו תיבה ל-`Disabled` — בכוונה, כי לחיצה אחת בשדה הייתה משביתה
        // אתר. אבל בלי לשאת את הערך, **כל לחיצה על "שמור" מדליקה מחדש את
        // MQTT בשקט**.
        //
        // ⚠️ ובשטח זה נראה בדיוק כמו באג אחר: הדגל הודלק ידנית, ההתקנה
        // הבאה דרשה הקלדת סיסמה, ולחיצת "שמור" החזירה את Mosquitto —
        // כלומר האשמה נפלה על ההתקנה, שלא עשתה דבר.
        //
        // אותו דפוס בדיוק כמו `_sbOverrides`, שכבר מתועד באותו קובץ.
        string form = Form();

        Assert.Contains("private bool _mqttDisabled;", form);
        Assert.Contains("_mqttDisabled = c.Mqtt.Disabled;", form);
        Assert.Contains("Disabled = _mqttDisabled,", form);

        // ⚠️ והנשיאה חייבת להיות **בתוך** בניית ה-MqttConfig שב-OnSave,
        // לא איפשהו בקובץ: שורה שהתנתקה משם היא שורה שאינה עושה דבר.
        int build = form.IndexOf("Mqtt = new MqttConfig", StringComparison.Ordinal);
        Assert.True(build > 0, "לא נמצאה בניית MqttConfig ב-OnSave");
        Assert.Contains("Disabled = _mqttDisabled,", form[build..(build + 400)]);

        static string Form()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
                dir = dir.Parent;
            Assert.NotNull(dir);
            return File.ReadAllText(Path.Combine(dir!.FullName, "src",
                "Parkomat.Agent.Tray", "Forms", "SettingsForm.cs"));
        }
    }

    [Fact]
    public void ADirectOnlySiteStillReportsItsStateAtStartup()
    {
        // ============================================================
        // ⚠️ נצפה באתר 2438 דקות אחרי הכיבוי, וזה כשל אמיתי
        // ============================================================
        // הודעת ה"לידה" וה-resync חיות בתוך שלב ג', שמדולג כשה-MQTT כבוי.
        // התוצאה: הפעימות עלו כרגיל (4,294) והסטטוס נשאר תקוע על no_comm —
        // הצוואה של הגשר סימנה אותו כשה-Mosquitto נעצר, ולא היה מי שינקה.
        //
        // ⚠️ **פעימה מוכיחה חיים, לא מצב.** `alive` מתעדכן בכל דקה, אבל
        // `sites.status` משתנה רק מהודעת מצב — ובאתר שקט הודעה כזו עשויה
        // לא להגיע במשך ימים. אתר חי שנראה מנותק על המסך הוא בדיוק הכשל
        // שהמעבר למסלול ישיר נועד למנוע.
        string w = Worker();
        Assert.Contains("if (!config.MqttEnabled && supabase is not null)", w);
        Assert.Contains("Resyncing current state directly", w);

        // ⚠️ ושני הטריגרים של MQTT מנוטרלים במפורש. העברתם כ-false הייתה
        // מייצרת resync **בכל סבב** — הצפה של הודעות מצב זהות.
        int at = w.IndexOf("ResyncDecision direct = ResyncPolicy.Decide", StringComparison.Ordinal);
        Assert.True(at > 0, "לא נמצאה ההחלטה הישירה");
        string call = w[at..(at + 260)];
        Assert.Contains("mqttWasConnected: true", call);
        Assert.Contains("bridgeJustReconnected: false", call);

        // וה-birth נסגר, אחרת הוא היה חוזר בכל סבב
        Assert.Contains("birthMessageSent = true;", w);

        static string Worker()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
                dir = dir.Parent;
            Assert.NotNull(dir);
            return File.ReadAllText(Path.Combine(dir!.FullName, "src",
                "Parkomat.Agent.Service", "Worker.cs"));
        }
    }
}
