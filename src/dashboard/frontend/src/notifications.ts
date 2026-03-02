/**
 * Browser Push Notification utility for sprint events.
 * Only fires when the tab is not focused.
 */

const STORAGE_KEY = "sprint-notifications-enabled";

export function getNotificationsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function canNotify(): boolean {
  return (
    "Notification" in window &&
    Notification.permission === "granted" &&
    getNotificationsEnabled() &&
    document.hidden
  );
}

export function notify(title: string, body: string, tag?: string): void {
  if (!canNotify()) return;
  try {
    new Notification(title, { body, tag, icon: "🏃" });
  } catch {
    // Silent fail — some environments don't support Notification constructor
  }
}

/** Map sprint events to notifications. Called from handleSprintEvent. */
export function notifySprintEvent(eventName: string, payload: Record<string, unknown> | undefined): void {
  if (!canNotify()) return;

  const p = payload ?? {};

  switch (eventName) {
    case "phase:change":
      notify("Phase Change", `${String(p.from ?? "?")} → ${String(p.to ?? "?")}`, "phase");
      break;

    case "issue:done":
      notify("✅ Issue Completed", `#${p.issueNumber} done`, `issue-${p.issueNumber}`);
      break;

    case "issue:fail":
      notify("❌ Issue Failed", `#${p.issueNumber}: ${p.reason ?? "unknown error"}`, `issue-${p.issueNumber}`);
      break;

    case "sprint:complete":
      notify("🏁 Sprint Complete", `Sprint ${p.sprintNumber} finished`, "sprint-complete");
      break;

    case "sprint:error":
      notify("💥 Sprint Error", String(p.error ?? "Unknown error"), "sprint-error");
      break;

    case "sprint:planned": {
      const issues = p.issues as Array<{ number: number }> | undefined;
      notify("📋 Sprint Planned", `${issues?.length ?? 0} issues selected`, "sprint-planned");
      break;
    }
  }
}
