const stub = (source) => ({
  url: `data:text/javascript,${encodeURIComponent(source)}`,
  shortCircuit: true,
})

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opencode/plugin") {
    return stub("export const Plugin = { define: plugin => plugin }")
  }
  if (specifier === "node:fs" && context.parentURL?.endsWith("/index.ts")) {
    // The plugin must never read service credentials or write the user's debug log in tests.
    const lockScript = `
      export const readFileSync = () => JSON.stringify({url: "http://opencode.test", password: "fixture-only"});
      export const writeFileSync = () => {};
      export const appendFileSync = () => {};
      // fire-lock stubs — globalThis.__abgLock steers the two behaviours:
      //   held=false          -> "wx" create succeeds (fresh lock acquired)
      //   held=true, fresh    -> EEXIST on create; statSync reports a lock
      //                          younger than 10s -> the fire must stand down
      //   held=true, stale    -> EEXIST on create; statSync reports >10s -> takeover
      export const openSync = (file, flags) => {
        const st = globalThis.__abgLock
        if (st && st.held) {
          const e = new Error("EEXIST: file already exists")
          e.code = "EEXIST"
          throw e
        }
        return 3
      }
      export const writeSync = () => {}
      export const closeSync = () => {}
      export const statSync = (file) => ({
        mtimeMs: Date.now() - ((globalThis.__abgLock && globalThis.__abgLock.existingAgeMs) || 0),
      })
      export const unlinkSync = () => {}
    `
    return stub(lockScript)
  }
  return nextResolve(specifier, context)
}
