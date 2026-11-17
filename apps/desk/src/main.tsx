import { createRealm } from "@frondruntime/pinna";
import { RealmService } from "@frondruntime/pinna-effect";
import { Effect } from "effect";
import { createRoot } from "react-dom/client";
import { AccountPanel } from "./client/account-panel.tsx";
import { Blotter } from "./client/blotter.tsx";
import { makeDesk } from "./client/desk.ts";
import { LayoutsPanel } from "./client/layouts-panel.tsx";
import { OrdersPanel } from "./client/orders-panel.tsx";
import { WorkspaceView } from "./client/workspace.tsx";
import { browserWorkspaceStore } from "./client/workspace-data.ts";
import { makeExchange } from "./exchange/index.ts";
import { inMemoryTransport } from "./transport.ts";
import "./styles.css";

// Composition lives here; neither side imports the other.
const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");
const root = createRoot(container);
const realm = createRealm({ name: "desk" });
const application = Effect.gen(function* () {
  const exchange = yield* makeExchange({ seed: 42, initialWorkingOrders: 5 });
  const { transport } = inMemoryTransport(exchange);
  const desk = yield* makeDesk(
    transport,
    browserWorkspaceStore({
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    }),
  );
  root.render(
    <main>
      <p className="eyebrow">PINNA / DESK</p>
      <h1>Foreign exchange</h1>
      <LayoutsPanel layouts={desk.layouts} />
      <WorkspaceView workspace={desk} />
      <OrdersPanel workspace={desk} />
      <AccountPanel orders={desk.orders} />
      <Blotter book={desk.trades} />
      <p className="caption">Simulated market · Five currency pairs</p>
    </main>,
  );
  yield* Effect.never;
}).pipe(Effect.provideService(RealmService, realm), Effect.scoped);

const running = Effect.runFork(
  application.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        root.render(
          <main>
            <h1>Desk could not start</h1>
            <p role="alert">{String(error)}</p>
          </main>,
        );
      }),
    ),
  ),
);
const stop = () => {
  root.unmount();
  running.interruptUnsafe();
};
window.addEventListener("pagehide", stop, { once: true });
if (import.meta.hot) import.meta.hot.dispose(stop);
