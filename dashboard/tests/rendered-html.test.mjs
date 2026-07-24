import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Autoprover campaign control room", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>Continuous Math Research · Autoprover<\/title>/i,
  );
  assert.match(html, />Autoprover</);
  assert.match(html, /Campaign control/);
  assert.match(html, />Problems</);
  assert.match(html, /Research notes/);
  assert.match(html, /Preview · connecting|Connecting/);
  assert.match(html, /Connecting to the controller/);
  assert.doesNotMatch(html, /Lonely Runner Conjecture/);
  assert.match(html, /autoprover-og\.png/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("keeps campaign controls, completed reports, and metadata wired", async () => {
  const [component, page, layout, packageJson] = await Promise.all([
    readFile(
      new URL("../app/components/AutoproverDashboard.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(component, /fetch\("\/api\/dashboard"/);
  assert.match(component, /x-autoprover-command-token/);
  assert.match(component, /completedProblems/);
  assert.match(component, /recentProcessNotes/);
  assert.match(component, /Highest priority first/);
  assert.match(component, /Counterexample route:/);
  assert.match(component, /\/api\/catalog\/discover/);
  assert.match(component, /\/api\/catalog\/suggest/);
  assert.match(component, /\/api\/catalog\/prioritize/);
  assert.match(component, /\/api\/attempt\/switch/);
  assert.match(component, /Find more problems/);
  assert.match(component, /Run next/);
  assert.match(component, /Move to another problem/);
  assert.match(component, /Earlier work is preserved/);
  assert.match(component, /Resume saved work for/);
  assert.match(component, /Pause after current calls/);
  assert.match(component, /Approaches for this problem/);
  assert.match(page, /<AutoproverDashboard \/>/);
  assert.match(layout, /autoprover-og\.png/);
  assert.match(layout, /openGraph:/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await access(new URL("../public/autoprover-og.png", import.meta.url));
  await assert.rejects(
    access(new URL("../app/_sites-preview/", import.meta.url)),
  );
});
