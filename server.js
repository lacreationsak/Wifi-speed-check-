// Local development helper only. Not used in production: on Vercel this
// project deploys as a static site (see vercel.json / .vercelignore) and
// speed measurements run entirely client-side against speed.cloudflare.com,
// so no server — this one included — is needed once it's deployed.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const rootDirectory = __dirname;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = http.createServer((request, response) => {
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath).replace(/^[/\\]+/, "");
  const filePath = path.resolve(rootDirectory, relativePath);

  if (!filePath.startsWith(`${rootDirectory}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(data);
  });
});

server.once("error", (error) => {
  console.error(`Could not start the local server: ${error.message}`);
  process.exitCode = 1;
});

function openInBrowser(url) {
  // "start" is a Windows shell built-in, "open" is macOS, "xdg-open" is
  // the freedesktop.org standard most Linux distros ship. Falling back
  // to only the Windows command meant the browser silently never opened
  // on macOS/Linux; the URL is always logged too, so the person can
  // still get there manually if none of these are available.
  const openCommand =
    process.platform === "win32" ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;

  exec(openCommand, (error) => {
    if (error) {
      console.warn(`Could not auto-open the browser (${error.message}). Open ${url} manually.`);
    }
  });
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const url = `http://localhost:${port}`;

  console.log(`Wi-Fi Speed Checker is running at ${url}`);
  openInBrowser(url);
});