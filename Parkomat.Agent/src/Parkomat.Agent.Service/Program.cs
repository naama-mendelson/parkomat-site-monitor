using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service;
using Parkomat.Agent.Service.Logging;

// ============================================================
// ⚠️ מופע יחיד — לפני כל דבר אחר
// ============================================================
// זה חייב לרוץ **לפני** בניית ה-Host, כי הרגע שבו מופע שני מזיק הוא
// הרגע שבו הוא מתחבר ל-MQTT — ושני מופעים עם אותו clientId מנתקים זה
// את זה בלולאה אינסופית. נמדד בייצור באתר 1284. ראה SingleInstance.cs.
//
// יציאה בקוד 0 ולא בשגיאה: מופע שני שמסרב לעלות עשה **בדיוק** את מה
// שנדרש ממנו. קוד שגיאה היה גורם לשומר ב-Tray לנסות שוב ושוב.
if (!Parkomat.Agent.Service.SingleInstance.TryAcquire())
{
    Parkomat.Agent.Service.SingleInstance.LogRefusal();
    return;
}

var builder = Host.CreateApplicationBuilder(args);

// מאפשר לתוכנה לרוץ כ-Windows Service אמיתי (ולא רק כקונסול).
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "ParkomatAgent";
});

// לוג לקובץ יומי תחת ...\Parkomat\Agent\logs — כדי שטכנאי יוכל לאבחן
// למה לא נשלח מידע. רושם מרמת Information ומעלה, שומר 14 יום.
builder.Logging.AddFileLogger();

// רושם את ה-Worker — הלב שרץ ברקע.
builder.Services.AddHostedService<Worker>();

// מוודא שתיקיית ההגדרות (C:\ProgramData\Parkomat\Agent) קיימת
// לפני שה-Worker מנסה לקרוא ממנה.
AgentPaths.EnsureBaseFolderExists();
AgentPaths.EnsureLogsFolderExists();

var host = builder.Build();
host.Run();