import { ProcessTerminal, type Terminal, TuiAltScreen } from '@dock/tui'
import { type CliOptions, parseCliOptions } from './cli-options.js'
import { createDockRuntime, type CreateDockRuntimeOptions } from './runtime/create-runtime.js'
import { DockTuiApp } from './ui/dock-tui-app.js'

export type StartDockOptions = CreateDockRuntimeOptions & {
  cli?: CliOptions
  terminal?: Terminal
}

export async function startDock(options: StartDockOptions): Promise<void> {
  const cli = options.cli ?? parseCliOptions(options.args)
  if (cli.print) throw new Error('Print mode must use the headless runner')
  const runtime = await createDockRuntime({ ...options, cli })
  const tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal())
  const app = new DockTuiApp({
    controller: runtime.controller,
    agentCommands: runtime.agentCommands,
    memoryNotificationBroker: runtime.memoryNotificationBroker,
    permissionBroker: runtime.permissionBroker,
    userInteractionBroker: runtime.userInteractionBroker,
    taskCommands: runtime.taskCommands,
    sandboxNetworkPermissionBroker: runtime.sandboxNetworkPermissionBroker,
    sandboxCommands: runtime.sandboxCommands,
    sessionCommands: runtime.sessionCommands,
    startupNotices: runtime.startupNotices,
    tui,
  })
  runtime.setAgentWakeHandler(() => app.notifyTasksChanged())
  try {
    app.start()
    app.notifyTasksChanged()
    await app.waitUntilStopped()
  } finally {
    try {
      await app.stop()
    } finally {
      await runtime.close()
    }
  }
}
