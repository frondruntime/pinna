import type { APIRoute, GetStaticPaths } from "astro";
import { markdownResponse, renderMarkdownPages } from "../../lib/llms";

export const prerender = true;

// `/docs/effect/boxes.md` and `/docs/start/index.md`: each docs page's Markdown copy, which
// llms.txt links and each page's head names as its `alternate`.
export const getStaticPaths = (async () =>
  (await renderMarkdownPages()).map((page) => ({
    params: { path: page.path.slice("/docs/".length, -".md".length) },
    props: { body: page.body },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => markdownResponse(props.body as string);
