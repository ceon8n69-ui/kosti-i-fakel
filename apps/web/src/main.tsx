import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setupShell } from "./lib/telegram";
import "./styles.css";

setupShell();
createRoot(document.getElementById("root")!).render(<App />);
