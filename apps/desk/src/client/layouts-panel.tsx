import { useValue } from "@frondruntime/pinna-react";
import { memo, useState } from "react";
import type { Layouts } from "./layouts.ts";
import type { DroppedPart } from "./workspace-data.ts";

function DroppedParts({ parts }: { readonly parts: readonly DroppedPart[] }) {
  return parts.length === 0 ? (
    <p>No parts will be dropped.</p>
  ) : (
    <ul>
      {parts.map((part) => (
        <li key={`${part.path}:${part.reason}`}>
          <code>{part.path}</code>: {part.reason}
        </li>
      ))}
    </ul>
  );
}

const LayoutStatus = memo(function LayoutStatus({
  layouts,
  id,
  onRender,
}: {
  readonly layouts: Layouts;
  readonly id: string;
  readonly onRender?: ((id: string) => void) | undefined;
}) {
  onRender?.(id);
  const status = useValue(layouts.$status(id));
  return (
    <span aria-current={status !== "inactive" ? "true" : undefined} data-layout-status={id}>
      {status === "inactive" ? "" : status === "modified" ? " Active · Modified" : " Active"}
    </span>
  );
});

const LayoutRow = memo(function LayoutRow({
  layouts,
  id,
  onRowRender,
  onStatusRender,
}: {
  readonly layouts: Layouts;
  readonly id: string;
  readonly onRowRender?: ((id: string) => void) | undefined;
  readonly onStatusRender?: ((id: string) => void) | undefined;
}) {
  onRowRender?.(id);
  const layout = useValue(layouts.$layouts.row(id));
  const [error, setError] = useState("");
  const [shared, setShared] = useState("");
  if (!layout) return null;
  return (
    <li data-layout={id}>
      <button type="button" onClick={() => layouts.switchTo(id)}>
        {layout.name}
      </button>
      <LayoutStatus layouts={layouts} id={id} onRender={onStatusRender} />
      <form
        key={layout.name}
        onSubmit={(event) => {
          event.preventDefault();
          const name = new FormData(event.currentTarget).get("name");
          try {
            layouts.rename(id, String(name ?? ""));
            setError("");
          } catch (error) {
            setError(String(error));
          }
        }}
      >
        <label>
          Rename {layout.name}
          <input name="name" defaultValue={layout.name} />
        </label>
        <button type="submit">Rename</button>
      </form>
      <button type="button" onClick={() => layouts.delete(id)}>
        Delete {layout.name}
      </button>
      <button
        type="button"
        onClick={() => {
          const text = layouts.copy(id);
          setShared(text);
          if (navigator.clipboard)
            void navigator.clipboard
              .writeText(text)
              .catch(() => setError("Clipboard unavailable. Copy the text below."));
        }}
      >
        Copy {layout.name}
      </button>
      {shared && (
        <label>
          Layout text
          <textarea readOnly value={shared} onFocus={(event) => event.currentTarget.select()} />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
});

export const LayoutList = memo(function LayoutList({
  layouts,
  onRender,
  onRowRender,
  onStatusRender,
}: {
  readonly layouts: Layouts;
  readonly onRender?: (() => void) | undefined;
  readonly onRowRender?: ((id: string) => void) | undefined;
  readonly onStatusRender?: ((id: string) => void) | undefined;
}) {
  onRender?.();
  const keys = useValue(layouts.$layouts.keys);
  return (
    <ul aria-label="Saved layouts">
      {keys.map((id) => (
        <LayoutRow
          key={id}
          layouts={layouts}
          id={id}
          onRowRender={onRowRender}
          onStatusRender={onStatusRender}
        />
      ))}
    </ul>
  );
});

const SaveLayout = memo(function SaveLayout({ layouts }: { readonly layouts: Layouts }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          layouts.save(name);
          setName("");
          setError("");
        } catch (error) {
          setError(String(error));
        }
      }}
    >
      <label>
        Layout name
        <input value={name} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <button type="submit">Save current workspace</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
});

const PasteLayout = memo(function PasteLayout({ layouts }: { readonly layouts: Layouts }) {
  const [text, setText] = useState("");
  const preview = useValue(layouts.$preview);
  return (
    <>
      <label>
        Paste layout
        <textarea value={text} onInput={(event) => setText(event.currentTarget.value)} />
      </label>
      <button type="button" onClick={() => layouts.preview(text)}>
        Review pasted layout
      </button>
      {preview && (
        <section aria-label="Layout preview">
          <h3>Review before applying</h3>
          <p>
            Open tiles:{" "}
            {preview.workspace.tiles
              .map((tile) => `${tile.symbol} (${tile.notional})`)
              .join(", ") || "none"}
            . Positions {preview.workspace.positionsShown ? "shown" : "hidden"}.
          </p>
          <p>
            Sort: {preview.workspace.blotter.sort.column} {preview.workspace.blotter.sort.direction}
            . Filter: {preview.workspace.blotter.filter || "none"}. Scroll:{" "}
            {preview.workspace.blotter.scrollTop}.
          </p>
          <DroppedParts parts={preview.dropped} />
          <button type="button" onClick={() => layouts.confirmPreview()}>
            Confirm layout
          </button>
          <button type="button" onClick={() => layouts.cancelPreview()}>
            Cancel
          </button>
        </section>
      )}
    </>
  );
});

const RecoveryNotice = memo(function RecoveryNotice({ layouts }: { readonly layouts: Layouts }) {
  const parts = useValue(layouts.$dropped);
  const error = useValue(layouts.$storageError);
  return (
    <>
      {parts.length > 0 && (
        <aside aria-label="Dropped workspace parts">
          <h3>Workspace parts dropped</h3>
          <DroppedParts parts={parts} />
        </aside>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
});

export const LayoutsPanel = memo(function LayoutsPanel({ layouts }: { readonly layouts: Layouts }) {
  return (
    <section aria-label="Layouts">
      <h2>Layouts</h2>
      <RecoveryNotice layouts={layouts} />
      <SaveLayout layouts={layouts} />
      <LayoutList layouts={layouts} />
      <PasteLayout layouts={layouts} />
    </section>
  );
});
