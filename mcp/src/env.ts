// Settings from the environment. Claude Desktop fills an .mcpb's env from the
// extension's settings, but passes an optional setting the user left blank through
// as the literal placeholder ("${user_config.data_dir}"). Such a value means "not
// set", never a path or a URL.

/** An environment setting, or undefined when it is empty or an unfilled placeholder. */
export function setting(name: string): string | undefined {
  const value = process.env[name]?.trim()
  if (!value || /\$\{[^}]*\}/.test(value)) return undefined
  return value
}
