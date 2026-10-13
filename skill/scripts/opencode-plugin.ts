// OpenCode plugin: inject this project's shared memories into the system prompt.
// Installed by install.py to ~/.config/opencode/plugins/shared-memory.ts
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"

const MEM = `${homedir()}/.agents/skills/shared-memory-mcp/scripts/mem.py`

export const SharedMemory = async ({ directory }: { directory: string }) => {
  let context: string | undefined

  const load = () => {
    if (context === undefined) {
      try {
        context = execFileSync("python3", [MEM, "context", "--cwd", directory], {
          encoding: "utf8",
          timeout: 20000,
        }).trim()
      } catch {
        context = "" // memory server down must never break OpenCode
      }
    }
    return context
  }

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      const text = load()
      if (text) output.system.push(text)
    },
    "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
      output.context.push(
        "Keep in the summary every decision, preference, and project status change from this session " +
          "that has not yet been saved to shared memory (mem_add / mem_update), so it can still be saved.",
      )
    },
  }
}
