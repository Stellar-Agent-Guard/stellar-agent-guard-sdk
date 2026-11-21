import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const mutationMap = new Map(
  Object.entries(JSON.parse(process.env.MUTATION_MAP ?? "{}")).map(([from, to]) => [
    from,
    String(to),
  ]),
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith("file:")) return resolved;
    const replacement = mutationMap.get(fileURLToPath(resolved.url));
    if (!replacement) return resolved;
    return { ...resolved, url: pathToFileURL(replacement).href, shortCircuit: true };
  },
});
