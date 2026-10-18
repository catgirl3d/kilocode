---
title: "Keep Awake"
description: "Prevent system sleep while Kilo agents work"
---

# Keep Awake

Keep Awake prevents the computer from sleeping while Kilo sessions are running. It does not keep the display on and does not disable screen locking. Agents can continue to use files, network services, and available credentials while the computer is locked.

Keep Awake is off by default and is available on macOS, Linux, and Windows.

{% tabs %}
{% tab label="VS Code" %}

Turn Keep Awake on or off with any of these controls:

| Control | Action |
|---|---|
| Command Palette | Run **Toggle Keep Awake** (`kilo-code.new.toggleCaffeination`). |
| Chat slash command | Type `/caffeinate`. The aliases `/caffenate` and `/keep-awake` also work. |
| Agent Manager | Select the coffee icon in the Agent Manager header. |

The Agent Manager coffee icon reflects the same state as the other controls.

Kilo holds the sleep inhibitor only while at least one session is busy or retrying, or while a session has a scheduled wakeup, and releases it when every session is idle and has no pending wakeup. Keep Awake stops when the VS Code window reloads.

The first time you enable Keep Awake, VS Code asks for confirmation. The answer is stored in the extension's global state, not in `kilo.jsonc`. Enable Keep Awake only in a trusted workspace. It is not available in a remote window.

{% /tab %}
{% tab label="CLI" %}

In the terminal UI, run the `/caffeinate` slash command. The alias `/caffenate` works too. You can also use the **Enable Keep Awake** and **Disable Keep Awake** entries in the **System** command category.

Kilo holds the sleep inhibitor while any session is busy or retrying, or while a session has a scheduled wakeup, and releases it when every session is idle and has no pending wakeup. The first time you enable Keep Awake, a dialog explains what it does and asks you to confirm. The answer is stored in the TUI state, not in `kilo.jsonc`.

{% /tab %}
{% /tabs %}

{% callout type="warning" %}
Keep Awake prevents system sleep only. It does not keep the display on and does not disable screen locking. Agents may continue to access files, network services, and available credentials while the computer is locked. Enable it only if your organization's device policy permits it. On Linux, Keep Awake can also block manual suspend; turn it off before suspending.
{% /callout %}

## Platform support

| Platform | Mechanism |
|---|---|
| macOS | `/usr/bin/caffeinate` |
| Linux | `systemd-inhibit` |
| Windows | `SetThreadExecutionState` through PowerShell |

If the required command is not available, Kilo reports that Keep Awake is unavailable and does not start the inhibitor.

## Sleep when agents finish

In the VS Code Agent Manager, the clock button next to the coffee icon puts the computer to sleep or hibernation once your agents are done, so you can leave while they work. The menu has two kinds of timer:

| Menu item | What it does |
|---|---|
| **Sleep when agents finish** and **Hibernate when agents finish** | Waits until your agents are done, then counts down one minute. |
| **Sleep in…** and **Hibernate in…** | Counts down from now and ignores the agents. Pick 5, 15, 30, 60 or 120 minutes, or **Custom…** for any whole number of minutes up to 1440 (24 hours). Kilo remembers your last choice. |

Choose **Cancel sleep timer** to turn the timer off, or choose another item to replace it. Only one timer is active at a time.

Kilo counts the work as finished when every session is idle or only waiting for you, for example for a permission or an answer to a question. A session that waits for you does not keep the computer awake. A retrying session, a session with a scheduled wakeup, and a parent session whose subagent is still working do.

When the work is finished, a notification counts down 60 seconds and offers **Cancel**. If new work starts during the countdown, Kilo stops it and waits again.

A timer that ignores the agents shows the same notification during its last minute. Hover the clock button to see when the computer will go down. This timer keeps running if the connection to the Kilo backend drops, and it can put the computer to sleep while agents are still working. The timer fires once. It is cleared when you cancel it, after it fires, and when the VS Code window reloads. Kilo turns Keep Awake off before the computer goes to sleep.

The first time you enable the timer, VS Code asks for confirmation. The answer is stored in the extension's global state. The timer is not available in a remote window.

| Platform | Sleep | Hibernate |
|---|---|---|
| macOS | `pmset sleepnow` | Not available |
| Linux | `systemctl suspend` | `systemctl hibernate` |
| Windows | `SetSuspendState` through PowerShell | `SetSuspendState` through PowerShell; hibernation must be on (`powercfg /hibernate on`) |

{% callout type="warning" %}
Unsaved work in other applications is not saved. On Windows computers that use Modern Standby, sleep may keep the machine partly running instead of fully suspending.
{% /callout %}
