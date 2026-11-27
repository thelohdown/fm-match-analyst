// Settings left blank in Claude Desktop arrive as the literal "${user_config.…}"
// placeholder; they must read as unset, never as a folder or URL.
import { afterEach, describe, expect, it } from "vitest"

import { setting } from "../src/env"
import { dataFolder } from "../src/feedback"
import { archiveFolders } from "../src/sources"

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

describe("settings from the environment", () => {
  it("treats an unfilled placeholder or blank as unset", () => {
    process.env.FM_ANALYST_DATA_DIR = "${user_config.data_dir}"
    expect(setting("FM_ANALYST_DATA_DIR")).toBeUndefined()
    expect(dataFolder()).toMatch(/Documents[/\\]FM (Tinkerman|Match Analyst)$/)
    process.env.FM_ANALYST_DATA_DIR = "  "
    expect(dataFolder()).toMatch(/FM (Tinkerman|Match Analyst)$/)
  })

  it("keeps a real value", () => {
    process.env.FM_ANALYST_DATA_DIR = "/tmp/analyst"
    expect(dataFolder()).toBe("/tmp/analyst")
  })

  it("never treats a placeholder as an archive folder", () => {
    process.env.FMMATCHLENS_ARCHIVE_DIR = "${user_config.archive_dir}"
    expect(archiveFolders().some((folder) => folder.includes("${"))).toBe(false)
  })
})
