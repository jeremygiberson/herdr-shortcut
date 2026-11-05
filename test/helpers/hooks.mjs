// Resolves the mod's `import ... from "herdr"` to the stub, so git.js, config.js and log.js run under plain node.
export async function resolve(specifier, context, next) {
  if (specifier === "herdr") return { url: new URL("./herdr-stub.mjs", import.meta.url).href, shortCircuit: true };
  if (specifier === "gpui-kit" || specifier === "gpui-base") return { url: new URL("./gpui-stub.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
