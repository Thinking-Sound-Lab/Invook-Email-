import "server-only";

import axios, { type AxiosResponse } from "axios";
import { PassThrough, Readable } from "node:stream";

function getApiOrigin(): string {
  return (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

export async function proxyEventStream(request: Request, path: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "text/event-stream",
  };
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  let upstream: AxiosResponse<Readable>;
  try {
    const upstreamUrl = new URL(path, getApiOrigin());
    upstreamUrl.search = new URL(request.url).search;
    upstream = await axios.get<Readable>(upstreamUrl.toString(), {
      headers,
      responseType: "stream",
      signal: request.signal,
      validateStatus: () => true,
    });
  } catch (error) {
    if (axios.isCancel(error)) return new Response(null, { status: 204 });
    throw error;
  }
  const responseHeaders = new Headers();
  for (const name of [
    "cache-control",
    "content-type",
    "x-accel-buffering",
    "x-content-type-options",
    "x-request-id",
  ]) {
    const value = upstream.headers[name];
    if (typeof value === "string") responseHeaders.set(name, value);
  }

  const responseBody = new PassThrough();
  upstream.data.once("error", (error: unknown) => {
    if (axios.isCancel(error)) {
      responseBody.end();
      return;
    }
    responseBody.destroy(new Error("Upstream event stream failed"));
  });
  upstream.data.pipe(responseBody);

  const body = Readable.toWeb(responseBody) as unknown as ReadableStream;
  return new Response(body, {
    headers: responseHeaders,
    status: upstream.status,
  });
}
