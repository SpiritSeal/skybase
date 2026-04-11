import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";
// JetBrains Mono — bundled web font with comprehensive Unicode coverage
// (box drawing, braille spinners, powerline arrows, emoji). xterm.js'
// glyph rendering is only as good as the font; relying on system monospace
// fonts means each user's machine determines whether Claude Code's TUI
// renders correctly. Bundling guarantees a consistent baseline.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

// NOTE: React.StrictMode is intentionally OFF for now. It double-mounts
// effects in dev which exposed an orphan-term bug we're chasing — keep it
// off until the duplicate-keystroke issue is definitively fixed, then turn
// it back on as a regression check. (StrictMode has no effect in prod.)
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
