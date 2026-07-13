using System.Windows.Forms;

namespace Parkomat.Agent.Tray;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();

        // במקום לפתוח חלון — מריצים את אפליקציית ה-Tray.
        // TrayContext מחזיק את האייקון ליד השעון, והאפליקציה חיה כל עוד הוא קיים.
        Application.Run(new TrayContext());
    }
}