import { codeToHtml, type DecorationItem, type ShikiTransformer } from "shiki";
import { pinnaCodeTheme } from "./pinnaCodeTheme";
import { type SampleImport, sampleImports, withImports } from "./sampleImports";

/**
 * One `// #region name` of a sample under `apps/playground/src/landing`, the source of every
 * sample the landing page prints, so `bun run typecheck` compiles what the page shows. It prints
 * without the file's imports; `sampleRegion` adds them.
 */
function regionBody(source: string, name: string): string {
  const open = `// #region ${name}\n`;
  const start = source.indexOf(open);
  if (start === -1) {
    throw new Error(`Unknown sample region: ${name}`);
  }
  const end = source.indexOf("// #endregion", start);
  const lines = source
    .slice(start + open.length, end)
    .split("\n")
    .filter((line) => !line.includes("@ts-expect-error"));
  // A region inside a declaration prints from its own indentation, not the file's.
  const indent = Math.min(
    ...lines.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)),
  );
  return lines
    .map((line) => line.slice(indent))
    .join("\n")
    .trim();
}

/** A region as the page prints it: the imports it uses, then its code (`sampleImports.ts`). */
export function sampleRegion(source: string, name: string): string {
  return withImports(source, regionBody(source, name));
}

/** The names a region imports, by module, for a line that names them without the code. */
export function regionImports(source: string, name: string): ReadonlyArray<SampleImport> {
  return sampleImports(source, regionBody(source, name));
}

/** An error a sample marks under the line it is on: one the compiler reports, or one the line throws. */
interface MarkedError {
  /** The line the error is on, counted from zero after the marks are taken out. */
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly message: string;
  /** `type` for a mark that starts `error TS`, `throw` for one that starts `Error: `. */
  readonly kind: "type" | "throw";
  /** The short label under the span: the compiler's code for a type error, "throws" for a throw. */
  readonly label: string;
}

// `//      ^^^^^ error TS2540: …` under a line: the carets sit under the span the compiler
// reports, and the rest is its message, captured from `bun run typecheck` with the
// `@ts-expect-error` above the line removed. `//  ^^^ Error: pinna: …` marks what the line throws
// when it runs instead.
const errorMark = /^\s*\/\/\s*(\^+) (.+)$/;

function takeErrorMarks(code: string): {
  readonly code: string;
  readonly errors: ReadonlyArray<MarkedError>;
} {
  const lines: Array<string> = [];
  const errors: Array<MarkedError> = [];
  for (const line of code.split("\n")) {
    const match = errorMark.exec(line);
    const [, carets, message] = match ?? [];
    if (carets === undefined || message === undefined || lines.length === 0) {
      lines.push(line);
      continue;
    }
    const kind = message.startsWith("Error: ") ? "throw" : "type";
    errors.push({
      line: lines.length - 1,
      column: line.indexOf("^"),
      length: carets.length,
      message,
      kind,
      label:
        kind === "throw"
          ? "throws"
          : `type error ${/^error (TS\d+)/.exec(message)?.[1] ?? ""}`.trimEnd(),
    });
  }
  return { code: lines.join("\n"), errors };
}

/** What the note under a marked span prints: the whole message, or a short label. */
type SampleNotes = "message" | "label";

/**
 * Prints each marked error as its own line under the code it marks: carets, then its message, or
 * with `label` a short label and the message as the note's title.
 */
const errorNotes = (errors: ReadonlyArray<MarkedError>, notes: SampleNotes): ShikiTransformer => ({
  name: "pinna:error-notes",
  // `pre`, not `code`: Shiki applies decorations in its own `code` hook and refuses a code element
  // whose line count no longer matches the source.
  pre(pre) {
    const node = pre.children.find((child) => child.type === "element" && child.tagName === "code");
    if (node === undefined || node.type !== "element") {
      throw new Error("Shiki printed a pre without a code element");
    }
    const lines = node.children.filter(
      (child) => child.type === "element" && child.properties["class"] === "line",
    );
    // From the last error up, so each insertion leaves the earlier positions alone.
    for (const error of [...errors].reverse()) {
      const line = lines[error.line];
      if (line === undefined) {
        throw new Error(`An error mark points past the sample's last line: ${error.message}`);
      }
      // The note is a block, so it ends the line itself: it takes the place of the newline after
      // the line, which would otherwise print an empty line under it.
      const after = node.children.indexOf(line) + 1;
      const next = node.children[after];
      const newline = next !== undefined && next.type === "text" && next.value === "\n" ? 1 : 0;
      node.children.splice(after, newline, {
        type: "element",
        tagName: "span",
        properties: {
          class: `code-error-note is-${error.kind}${notes === "label" ? " is-label" : ""}`,
          style: `--column: ${error.column}`,
          ...(notes === "label" ? { title: error.message } : {}),
        },
        children: [
          {
            type: "element",
            tagName: "span",
            properties: { class: "code-error-carets" },
            children: [{ type: "text", value: "^".repeat(error.length) }],
          },
          { type: "text", value: ` ${notes === "label" ? error.label : error.message}` },
        ],
      });
    }
  },
});

/**
 * The errors of one line as one mark: the span from the first error's start to the last one's end,
 * labeled with each label in order, so a line that fails to compile and also throws, such as an
 * `async` recipe, takes one note under it, not two.
 */
const oneMarkPerLine = (errors: ReadonlyArray<MarkedError>): ReadonlyArray<MarkedError> => {
  const lines = new Map<number, Array<MarkedError>>();
  for (const error of errors) {
    lines.set(error.line, [...(lines.get(error.line) ?? []), error]);
  }
  return [...lines].map(([line, marks]) => {
    const column = Math.min(...marks.map((mark) => mark.column));
    const end = Math.max(...marks.map((mark) => mark.column + mark.length));
    return {
      line,
      column,
      length: end - column,
      message: marks.map((mark) => mark.message).join("\n"),
      kind: marks.some((mark) => mark.kind === "type") ? "type" : "throw",
      label: marks.map((mark) => mark.label).join(", "),
    };
  });
};

/** A sample region as highlighted HTML, its marked errors underlined and printed under their lines. */
export function highlightSample(
  source: string,
  name: string,
  notes: SampleNotes = "message",
): Promise<string> {
  const taken = takeErrorMarks(sampleRegion(source, name));
  const code = taken.code;
  const errors = notes === "label" ? oneMarkPerLine(taken.errors) : taken.errors;
  const decorations = errors.map(
    (error): DecorationItem => ({
      start: { line: error.line, character: error.column },
      end: { line: error.line, character: error.column + error.length },
      properties: {
        class: `code-error-span is-${error.kind}`,
        ...(notes === "label" ? { title: error.message } : {}),
      },
    }),
  );
  return codeToHtml(code, {
    lang: "tsx",
    theme: pinnaCodeTheme,
    decorations,
    transformers: [errorNotes(errors, notes)],
  });
}
