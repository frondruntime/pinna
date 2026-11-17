import type { APIRoute } from "astro";
import { renderLlmsFull, textResponse } from "../lib/llms";

export const prerender = true;

export const GET: APIRoute = async () => textResponse(await renderLlmsFull());
