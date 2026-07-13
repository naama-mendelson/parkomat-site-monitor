using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service;
using Parkomat.Agent.Service.Logging;

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