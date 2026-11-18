import { spawn } from "child_process";

/**
 * An OS notification with no third-party service: a Windows toast through
 * PowerShell's WinRT access, `osascript` on macOS, `notify-send` elsewhere.
 * The title and body are passed in environment variables (or as separate
 * arguments to notify-send), never spliced into a script, so a tool name
 * cannot become code. Any failure (a missing program, a session with no
 * notification service) is silent.
 */
export interface DesktopCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const WINDOWS_TOAST = [
  "$ErrorActionPreference = 'Stop'",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t = $xml.GetElementsByTagName('text')",
  "[void]$t.Item(0).AppendChild($xml.CreateTextNode($env:CN_NOTIFY_TITLE))",
  "[void]$t.Item(1).AppendChild($xml.CreateTextNode($env:CN_NOTIFY_BODY))",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
].join("; ");

const MAC_NOTIFY =
  'display notification (system attribute "CN_NOTIFY_BODY") with title (system attribute "CN_NOTIFY_TITLE")';

/** The command for this platform, or undefined where there is none. Pure. */
export function desktopCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): DesktopCommand | undefined {
  const env = { CN_NOTIFY_TITLE: title, CN_NOTIFY_BODY: body };
  switch (platform) {
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          WINDOWS_TOAST,
        ],
        env,
      };
    case "darwin":
      return { command: "osascript", args: ["-e", MAC_NOTIFY], env };
    case "linux":
    case "freebsd":
    case "openbsd":
      return {
        command: "notify-send",
        args: ["--app-name=Continuous", "--", title, body],
      };
    default:
      return undefined;
  }
}

export function sendDesktopNotification(title: string, body: string): void {
  const cmd = desktopCommand(process.platform, title, body);
  if (!cmd) return;
  try {
    const child = spawn(cmd.command, cmd.args, {
      env: { ...process.env, ...cmd.env },
      stdio: "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no notification service: say nothing
  }
}
