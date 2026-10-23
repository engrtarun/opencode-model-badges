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
    return stub(`
      export const readFileSync = () => JSON.stringify({url: "http://opencode.test", password: "fixture-only"});
      export const writeFileSync = () => {};
      export const appendFileSync = () => {};
    `)
  }
  return nextResolve(specifier, context)
}
