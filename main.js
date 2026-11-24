const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow } = require("electron");

if (!app.isPackaged) {
  // Watch only the UI files so backend edits don't reload the window.
  require("electron-reload")(
    [path.join(__dirname, "index.html"), path.join(__dirname, "renderer")],
    {
      electron: path.join(__dirname, "node_modules", ".bin", "electron"),
      hardResetMethod: "exit",
    },
  );
}

let backend = null;

function startBackend() {
  // Run the mock backend with Electron's own Node runtime (no system Node needed).
  backend = spawn(
    process.execPath,
    [path.join(__dirname, "backend", "server.js")],
    {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  backend.on("exit", () => {
    backend = null;
  });
}

function stopBackend() {
  if (backend) backend.kill();
}

function createWindow() {
  const win = new BrowserWindow({ width: 1200, height: 800 });
  win.loadFile("index.html");
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
});

app.on("before-quit", stopBackend);
process.on("exit", stopBackend);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
