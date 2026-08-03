' launch-hidden.vbs — מריץ את start-master.ps1 בלי שום חלון.
'
' ==========================================================
' למה VBScript ולא ישר powershell.exe במשימה
' ==========================================================
' המשימה רצה כל 5 דקות. אם היא מפעילה powershell.exe ישירות, חלון קונסול
' מהבהב על המסך בכל הרצה — 288 הבהובים ביום על מסך שאמור להציג חניונים.
' הדגל -WindowStyle Hidden אינו עוזר: הוא חל על מה ש-PowerShell *מפעיל*,
' לא על החלון של PowerShell עצמו.
'
' wscript.exe עם intWindowStyle=0 הוא הדרך היחידה בלי הרשאות מנהל להריץ
' באמת בלי חלון. (עם הרשאות מנהל אפשר "Run whether user is logged on or
' not" והמערכת מסתירה לבד — אבל הפרויקט הזה נמנע מ-UAC בכוונה.)
'
' bWaitOnReturn=False: הסקריפט מפעיל את השרת ומסיים. אין טעם שהמשימה
' תישאר תלויה כל עוד השרת חי.

Dim shell, fso, scriptPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-master.ps1")

' -NonInteractive ו-Bypass: המשימה רצה בלי אדם מולה, ומדיניות ההרצה
' המוגדרת במחשב אינה אמורה להשבית את ההפעלה האוטומטית של השרת.
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """", 0, False
