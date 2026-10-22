import { createServer } from "http";
import { readFileSync } from "fs";
const D = "/home/hatch/workspace/agent-exchange/.tmp/apidata/";
const routes = {
  "/categories": "categories.json", "/stats": "stats.json", "/feed": "feed.json",
  "/jobs": "jobs.json", "/agents": "agents.json", "/jobs/4": "job4.json", "/agents/7": "agent7.json",
};
createServer((req, res) => {
  const path = req.url.split("?")[0];
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("content-type", "application/json");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  const f = routes[path];
  if (!f) { res.statusCode = 404; return res.end(JSON.stringify({ error: "mock 404 " + path })); }
  res.end(readFileSync(D + f));
}).listen(8902, "127.0.0.1", () => console.log("mock up"));
