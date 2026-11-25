/**
 * Page entry for `examples/browser/index.html` (issue #482): wires the form to
 * `loadGuardDashboard`. Only public values ever enter the browser — an RPC URL
 * and two public addresses.
 *
 * The repo's tsconfig deliberately has no DOM lib (the SDK must not depend on
 * browser globals), so the handful of DOM members this page uses are typed
 * structurally below instead of pulling `lib.dom` into the whole project.
 */
import { rpc } from "@stellar/stellar-sdk";
import { loadGuardDashboard, renderDashboardText } from "./dashboard.ts";

interface PageElement {
  textContent: string | null;
  addEventListener(type: "submit", listener: (event: { preventDefault(): void }) => void): void;
}
interface PageDocument {
  querySelector(selector: string): PageElement | null;
}
type FormDataCtor = new (form: PageElement) => { get(name: string): unknown };

const page = globalThis as unknown as { document?: PageDocument; FormData?: FormDataCtor };
const form = page.document?.querySelector("#lookup");
const output = page.document?.querySelector("#output");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!output || !page.FormData) return;
  const data = new page.FormData(form);
  output.textContent = "loading…";
  loadGuardDashboard({
    server: new rpc.Server(String(data.get("rpc"))),
    guard: String(data.get("guard")),
    source: String(data.get("source")),
  })
    .then((view) => {
      output.textContent = renderDashboardText(view);
    })
    .catch((error: unknown) => {
      output.textContent = `could not load: ${error instanceof Error ? error.message : String(error)}`;
    });
});
