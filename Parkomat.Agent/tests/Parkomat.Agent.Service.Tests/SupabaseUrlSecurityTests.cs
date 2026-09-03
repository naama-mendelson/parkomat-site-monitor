using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הכתיבה הישירה פועלת רק מול <b>https</b>.
///
/// ⚠️ <b>מה שזה מונע, במפורש:</b> הבקשה הראשונה של הסוכן היא התחברות —
/// <c>POST /auth/v1/token</c> עם <b>הסיסמה של האתר בגוף</b>. אחריה כל
/// אצווה נושאת את האסימון בכותרת. ב-<c>http</c> שניהם עוברים בטקסט גלוי
/// ברשת החניון, יחד עם ההרשאה לכתוב לאתר הזה.
///
/// ⚠️ <b>וזו לא הייתה בדיקה תיאורטית.</b> עד לתיקון לא הייתה כאן שום
/// ולידציה: <c>SupabaseWriter</c> משרשר את הכתובת מהטופס כמות שהיא
/// (<c>$"{_cfg.Url.TrimEnd('/')}/auth/v1/token"</c>), וטכנאי שהקליד
/// <c>http://</c> היה מקבל סוכן <b>שעובד</b> — וזה בדיוק מה שהופך את
/// הכשל לבלתי נראה.
/// </summary>
public class SupabaseUrlSecurityTests
{
    private static SupabaseConfig Cfg(string url) => new()
    {
        SiteId = "2438",
        Url = url,
        Password = "s3cret",
    };

    [Theory]
    [InlineData("https://xvfsikwaaaohnmldjbtv.supabase.co")]
    [InlineData("https://xvfsikwaaaohnmldjbtv.supabase.co/")]
    // ⚠️ רווחים בקצוות — הדבקה מהדפדפן גוררת אותם, והם אינם סיבה לכבות.
    [InlineData("  https://xvfsikwaaaohnmldjbtv.supabase.co  ")]
    public void HttpsIsAccepted(string url)
    {
        Assert.True(Cfg(url).Enabled);
    }

    [Theory]
    [InlineData("http://xvfsikwaaaohnmldjbtv.supabase.co")]
    // ⚠️ **גדול/קטן אינו מגן.** Uri מנרמל את הסכימה, ולכן HTTP:// נתפס
    // כמו http:// — ובדיקת מחרוזת פשוטה הייתה מפספסת אותו.
    [InlineData("HTTP://xvfsikwaaaohnmldjbtv.supabase.co")]
    // כתובת יחסית: אין לה סכימה כלל, ו-HttpClient היה זורק בזמן ריצה.
    [InlineData("xvfsikwaaaohnmldjbtv.supabase.co")]
    public void AnythingButHttpsTurnsTheDirectPathOff(string url)
    {
        Assert.False(Cfg(url).Enabled);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void AnEmptyOverrideMeansTheBuiltInAddress(string url)
    {
        // ⚠️ **זה הפוך ממה שהיה, וזו ההחלטה ולא תקלה.** קודם כתובת ריקה
        // כיבתה את המסלול, כי היא הייתה שדה שחייבים למלא. עכשיו היא
        // **העקיפה** — ריק פירושו ברירת המחדל הצרובה, שהיא https.
        Assert.True(Cfg(url).Enabled);
        Assert.Equal(SupabaseDefaults.Url, Cfg(url).EffectiveUrl);
    }

    [Fact]
    public void TheBuiltInAddressIsItselfHttps()
    {
        // ⚠️ אם ברירת המחדל תוחלף פעם ב-http, כל 16 האתרים היו שולחים
        // סיסמה בטקסט גלוי — ו**שום בדיקה אחרת כאן לא הייתה נדלקת**, כי
        // כולן מזינות כתובת מפורשת.
        Assert.True(SupabaseConfig.IsSecureUrl(SupabaseDefaults.Url));
    }

    [Fact]
    public void ThePasswordIsTheOnlyThingThatTurnsItOn()
    {
        // ⚠️ שאר השדות נגזרים או צרובים, ולכן הסיסמה היא המתג היחיד.
        var c = Cfg("");
        c.Password = "";
        Assert.False(c.Enabled);

        c.Password = "   ";
        Assert.False(c.Enabled);   // רווחים אינם ערך

        c.Password = "s3cret";
        Assert.True(c.Enabled);
    }

    [Fact]
    public void WithoutASiteCodeThereIsNoUser()
    {
        // ⚠️ שם המשתמש נגזר מקוד האתר. סוכן שטרם הוגדר קוד אתר שלו היה
        // מנסה להתחבר כ-"site-@parkomat.co.il", מקבל 400 בכל סבב, וממלא
        // את הלוג — בדיוק המצב ש-Enabled קיים כדי שלא ניתן יהיה לבטא.
        var c = Cfg("");
        c.SiteId = "";
        Assert.False(c.Enabled);
    }

    [Fact]
    public void TheFormTellsTheTechnicianWhatToDo()
    {
        // ⚠️ **בדיקה מבנית, ובכוונה.** הטופס אינו מציג עוד כתובת, ולכן
        // המשפט על https אינו שייך לו — מה שכן חייב להיות שם הוא ההסבר
        // שהסיסמה היא המתג, ושהשאר נקבע לפי קוד האתר. בלעדיו טכנאי מחפש
        // שדות שאינם קיימים ומסיק שהמסך שבור.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string form = File.ReadAllText(Path.Combine(
            dir!.FullName, "src", "Parkomat.Agent.Tray", "Forms", "SettingsForm.cs"));
        Assert.Contains("סיסמת האתר", form);
        Assert.Contains("מחיקתה מכבה", form);
        Assert.Contains("קוד האתר", form);
    }
}
